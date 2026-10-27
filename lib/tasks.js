// TASKS — the waits a person answers, and everything people do with them.
//
// A screen (screen-show) or an approval that parks opens tasks (afterPark).
// People see them in an inbox (listMine), may take one so nobody else works on
// it (claim / release), and answer it (answer). An approval goes on once its
// rule is met; a screen goes on with what was submitted. Both through the one
// resumeByKey every answer goes through, with the person recorded.
//
// WHO MAY ACT is decided here, from the user the host's request carries
// ({ id, roles }): a task for a user is theirs, a task for a role is anyone's
// holding it, a task for neither is anyone's in the company — and a Super
// Admin may act on any (the same rule as flows.mayAnswer). A claimed task is
// the claimer's alone. The engine never reads the auth tables.
//
// The host is told when a task opens, falls due or is escalated (onTask), so
// it can send the email or the push notification — the engine knows a role's
// name, not its members' addresses.

var { generateId } = require('@xeplr/utils/lib/helpers');
var db = require('./db');
var approval = require('./actions/approval');

var LIVE = ['queued', 'open', 'claimed'];
var hook = null;

function setTaskHook(fn) { hook = typeof fn === 'function' ? fn : null; }

function tell(event, task) {
  if (!hook) return;
  Promise.resolve().then(function() { return hook(event, task); }).catch(function(err) {
    console.error('[workflow] onTask(' + event + ') failed:', err.message);
  });
}

function fail(status, code, message) {
  var err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function mayAnswer(role, user) { return require('./flows').mayAnswer(role, user); }

function now() { return new Date().toISOString(); }

function noted(task, entry) {
  return (task.history || []).concat([Object.assign({ at: now() }, entry)]);
}

/** May this user act on this task at all (before claims)? */
function isFor(task, user) {
  if (!user || !user.id) return false;
  var roles = Array.isArray(user.roles) ? user.roles : [];
  if (roles.indexOf('Super Admin') > -1) return true;
  if (task.assigneeUserId) return task.assigneeUserId === user.id;
  return mayAnswer(task.assigneeRole, user);
}

// ── opening ───────────────────────────────────────────────────────────────

/**
 * A step that a person answers has just parked: open its tasks. Called by the
 * runner with the step's resolved input. Anything else that waits — an email
 * link, a job — opens none.
 */
async function afterPark(run, path, step, stepRun, resumeKeyId, input) {
  input = input || {};
  var base = {
    runId: run.id, workflowId: run.workflowId, pathId: path ? path.id : null, stepRunId: stepRun.id,
    resumeKeyId: resumeKeyId, stepKey: step.stepKey, title: input.title || step.name || step.stepKey
  };
  var rows = [];
  if (step.actionName === 'screen-show') {
    rows.push(Object.assign({}, base, { kind: 'screen', position: 0, status: 'open', assigneeRole: input.assignTo || null }));
  } else if (step.actionName === 'approval') {
    var approvers = approval.approversOf(input.approvers);
    var inTurn = input.order === 'inTurn';
    var dueAt = input.dueInHours ? new Date(Date.now() + Number(input.dueInHours) * 3600000).toISOString() : null;
    approvers.forEach(function(a, i) {
      rows.push(Object.assign({}, base, {
        kind: 'approval', position: i, status: inTurn && i > 0 ? 'queued' : 'open',
        assigneeUserId: a.user || null, assigneeRole: a.role || null,
        dueAt: inTurn && i > 0 ? null : dueAt, escalateTo: input.escalateTo || null
      }));
    });
  }
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var task = await db.model('WorkflowTask').query().insert(Object.assign({ id: generateId() }, rows[i]));
    out.push(task);
    if (task.status === 'open') tell('created', task);
  }
  return out;
}

// ── the inbox ─────────────────────────────────────────────────────────────

/**
 * GET /tasks/mine — open tasks for this user, their roles, or anyone in the
 * company, plus the ones they have taken; due first, then oldest. Paged.
 */
async function listMine(user, opts) {
  opts = opts || {};
  if (!user || !user.id) return { total: 0, tasks: [] };
  var roles = Array.isArray(user.roles) ? user.roles : [];
  var limit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 200);
  var offset = Math.max(parseInt(opts.offset, 10) || 0, 0);
  var everything = roles.indexOf('Super Admin') > -1;

  var mine = function(q) {
    q.whereIn('status', ['open', 'claimed']);
    if (everything) return q;
    return q.where(function(w) {
      w.where({ assigneeUserId: user.id })
        .orWhere(function(r) { r.whereNull('assigneeUserId').whereIn('assigneeRole', roles.length ? roles : ['']); })
        .orWhere(function(n) { n.whereNull('assigneeUserId').whereNull('assigneeRole'); })
        .orWhere({ claimedBy: user.id });
    });
  };
  var total = await mine(db.model('WorkflowTask').query()).resultSize();
  var tasks = await mine(db.model('WorkflowTask').query())
    .orderByRaw('"dueAt" ASC NULLS LAST, "recordCreatedDate" ASC').limit(limit).offset(offset);

  var wfIds = Array.from(new Set(tasks.map(function(t) { return t.workflowId; })));
  var workflows = wfIds.length ? await db.model('Workflow').query().whereIn('id', wfIds) : [];
  var nameOf = {};
  workflows.forEach(function(w) { nameOf[w.id] = w.name; });
  var runIds = Array.from(new Set(tasks.map(function(t) { return t.runId; })));
  var runs = runIds.length ? await db.model('WorkflowRun').query().whereIn('id', runIds) : [];
  var periodOf = {};
  runs.forEach(function(r) { periodOf[r.id] = r.triggerData && r.triggerData.window ? r.triggerData.window : null; });
  var srIds = tasks.map(function(t) { return t.stepRunId; });
  var stepRuns = srIds.length ? await db.model('WorkflowStepRun').query().whereIn('id', srIds) : [];
  var inputOf = {};
  stepRuns.forEach(function(sr) { inputOf[sr.id] = sr.input || {}; });

  return {
    total: total,
    tasks: tasks.map(function(t) {
      var input = inputOf[t.stepRunId] || {};
      return {
        id: t.id, runId: t.runId, workflowId: t.workflowId, workflowName: nameOf[t.workflowId] || null,
        stepKey: t.stepKey, title: t.title, kind: t.kind, status: t.status,
        assigneeUserId: t.assigneeUserId, assigneeRole: t.assigneeRole,
        claimedBy: t.claimedBy, mine: t.claimedBy === user.id, dueAt: t.dueAt, since: t.recordCreatedDate,
        // The period the case is for, when what started it had one ("September").
        period: periodOf[t.runId] || null,
        // What the answer screen needs: the screen and its buttons, or the
        // two an approval always has.
        screen: t.kind === 'screen' ? (input.screen || null) : null,
        buttons: t.kind === 'screen' ? require('./flows').buttonsOf(input.buttons)
          : [{ key: 'approved', label: 'Approve' }, { key: 'rejected', label: 'Reject' }],
        given: t.kind === 'screen' && input.values && typeof input.values === 'object' ? input.values : {}
      };
    })
  };
}

async function loadTask(id) {
  var task = await db.model('WorkflowTask').query().findById(id);
  if (!task) throw fail(404, 'TASK_NOT_FOUND', 'No task "' + id + '".');
  return task;
}

// ── taking one ────────────────────────────────────────────────────────────

/** Take a task so nobody else works on it. Only one person wins. */
async function claim(id, user) {
  var task = await loadTask(id);
  if (!isFor(task, user)) throw fail(403, 'NOT_YOURS', 'This task is for ' + (task.assigneeRole || 'someone else') + '.');
  if (task.status === 'claimed' && task.claimedBy === user.id) return task;
  var taken = await db.model('WorkflowTask').query().findById(id).where({ status: 'open' })
    .patch({ status: 'claimed', claimedBy: user.id, claimedAt: now() });
  if (!taken) {
    var current = await loadTask(id);
    if (current.status === 'claimed') throw fail(409, 'TASK_CLAIMED', 'Someone else has already taken this task.');
    throw fail(409, 'TASK_CLOSED', 'This task is no longer open.');
  }
  return loadTask(id);
}

/** Put a taken task back for everyone it is for. */
async function release(id, user) {
  var task = await loadTask(id);
  var roles = (user && Array.isArray(user.roles)) ? user.roles : [];
  if (task.claimedBy !== (user && user.id) && roles.indexOf('Super Admin') === -1) {
    throw fail(403, 'NOT_YOURS', 'Only the person who took this task can put it back.');
  }
  await db.model('WorkflowTask').query().findById(id).where({ status: 'claimed' })
    .patch({ status: 'open', claimedBy: null, claimedAt: null });
  return loadTask(id);
}

// ── answering ─────────────────────────────────────────────────────────────

/**
 * Answer a task. A screen goes through the screens facade (its roles and
 * buttons apply, and the submitted values are the step's output). An
 * approval records Approve or Reject, and goes on when its rule is met.
 *
 * body: { decision: 'approved'|'rejected', comment }  for an approval
 *       { values, action, recordId }                  for a screen
 */
async function answer(id, body, user) {
  body = body || {};
  var task = await loadTask(id);
  if (!isFor(task, user)) throw fail(403, 'NOT_YOURS', 'This task is for ' + (task.assigneeRole || 'someone else') + '.');
  if (task.status === 'claimed' && task.claimedBy !== user.id) throw fail(409, 'TASK_CLAIMED', 'Someone else has taken this task.');
  if (task.status === 'withdrawn') throw fail(409, 'TASK_CLOSED', 'This task is no longer needed: the case went ahead without it.');
  if (task.status !== 'open' && task.status !== 'claimed') throw fail(409, 'TASK_CLOSED', 'This task is no longer open.');

  if (task.kind === 'screen') {
    return require('./flows').submitRun(task.runId, {
      values: body.values, action: body.action, recordId: body.recordId, stepKey: task.stepKey
    }, { user: user });
  }
  return answerApproval(task, body, user);
}

async function answerApproval(task, body, user) {
  var decision = body.decision === 'approved' || body.decision === 'rejected' ? body.decision : null;
  if (!decision) throw fail(400, 'DECISION_REQUIRED', 'Say approved or rejected.');
  var comment = body.comment === undefined || body.comment === null ? null : String(body.comment);
  if (decision === 'rejected' && !(comment && comment.trim())) {
    throw fail(400, 'REASON_REQUIRED', 'Say why it is rejected, so the person who raised it knows what to fix.');
  }

  var runner = require('./workflowRunner');
  var run = await db.model('WorkflowRun').query().findById(task.runId);
  var stepRun = await db.model('WorkflowStepRun').query().findById(task.stepRunId);
  var input = (stepRun && stepRun.input) || {};

  // FOUR EYES: not the person who started the case, not someone who acted at
  // the steps it names, and not someone who already answered this approval.
  if (run.recordCreatedBy && run.recordCreatedBy === user.id) {
    throw fail(403, 'NOT_SAME_PERSON', 'You started this case, so someone else approves it.');
  }
  var barred = String(input.notSame || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  if (barred.length) {
    var acted = await db.model('WorkflowStepRun').query().where({ runId: run.id, actorUserId: user.id }).whereIn('stepKey', barred).resultSize();
    if (acted) throw fail(403, 'NOT_SAME_PERSON', 'You worked on an earlier step of this case, so someone else approves it.');
  }

  var resolved = await db.conn().transaction(async function(trx) {
    // The same lock a meeting point takes: two approvers answering in the same
    // second queue, and only one of them can be the answer that decides it.
    await trx.raw('SELECT "id" FROM "workflow_runs" WHERE "id" = ? FOR UPDATE', [run.id]);
    var all = await db.model('WorkflowTask').query(trx).where({ stepRunId: task.stepRunId }).orderBy('position');
    var mine = all.filter(function(t) { return t.id === task.id; })[0];
    if (!mine || LIVE.indexOf(mine.status) === -1 || mine.status === 'queued') throw fail(409, 'TASK_CLOSED', 'This task is no longer open.');
    if (all.some(function(t) { return t.status === 'done' && t.decidedBy === user.id; })) {
      throw fail(409, 'ALREADY_ANSWERED', 'You have already answered this approval.');
    }
    await db.model('WorkflowTask').query(trx).findById(task.id).patch({
      status: 'done', decidedBy: user.id, decidedAt: now(), decision: decision, comment: comment
    });
    mine.status = 'done'; mine.decidedBy = user.id; mine.decision = decision; mine.comment = comment; mine.decidedAt = now();

    var verdict = verdictOf(input, all);
    if (!verdict.go) {
      // In turn: the next approver's task opens once this one approves (or,
      // collecting, once this one answers at all).
      if (input.order === 'inTurn' && (decision === 'approved' || input.onReject === 'collect')) {
        var next = all.filter(function(t) { return t.status === 'queued'; })[0];
        if (next) {
          var due = input.dueInHours ? new Date(Date.now() + Number(input.dueInHours) * 3600000).toISOString() : null;
          await db.model('WorkflowTask').query(trx).findById(next.id).patch({ status: 'open', dueAt: due });
          next.status = 'open';
          return { opened: next };
        }
      }
      return null;
    }
    await withdraw(db.model('WorkflowTask').query(trx).where({ stepRunId: task.stepRunId }));
    return { output: verdict.output };
  });

  if (resolved && resolved.opened) tell('created', resolved.opened);
  if (resolved && resolved.output) {
    var key = await db.model('WorkflowResumeKey').query().findById(task.resumeKeyId);
    await runner.resumeByKey(key.key, resolved.output, { actor: user.id });
  }
  return loadTask(task.id);
}

/**
 * Is the approval decided? The meeting point's rule, counted over tasks:
 * enough approvals, or (stopping on a reject) one reject, or not enough left
 * to reach it — or, collecting, everyone has answered.
 */
function verdictOf(input, all) {
  var answered = all.filter(function(t) { return t.status === 'done'; });
  var pending = all.filter(function(t) { return t.status === 'open' || t.status === 'claimed' || t.status === 'queued'; }).length;
  var approved = answered.filter(function(t) { return t.decision === 'approved'; }).length;
  var rejected = answered.filter(function(t) { return t.decision === 'rejected'; }).length;
  var need = approval.check(input).need;
  var enough = approval.needed(need, all.length);
  var stop = input.onReject !== 'collect';
  var go = approved >= enough || (stop && (rejected > 0 || approved + pending < enough)) || pending === 0;
  return {
    go: go,
    output: {
      decision: approved >= enough && !(stop && rejected > 0) ? 'approved' : 'rejected',
      approved: approved, rejected: rejected,
      answers: answered.map(function(t) {
        return { by: t.decidedBy, role: t.assigneeRole || null, decision: t.decision, comment: t.comment || null, at: t.decidedAt };
      })
    }
  };
}

// ── what the engine does to tasks as a run moves ───────────────────────────

/** Tasks no longer needed — their wait was answered another way, or the case ended. */
function withdraw(query) {
  return query.whereIn('status', LIVE).patch({ status: 'withdrawn' });
}

/**
 * A screen's task is done when its key is answered (by whoever submitted it);
 * every other live task on that key is withdrawn. Inside resumeByKey's
 * transaction.
 */
async function closeForKey(trx, resumeKeyId, actor, output) {
  if (actor) {
    await db.model('WorkflowTask').query(trx).where({ resumeKeyId: resumeKeyId, kind: 'screen' }).whereIn('status', LIVE)
      .patch({ status: 'done', decidedBy: actor, decidedAt: now(), decision: (output && output.action) || null });
  }
  await withdraw(db.model('WorkflowTask').query(trx).where({ resumeKeyId: resumeKeyId }));
}

// ── admin ─────────────────────────────────────────────────────────────────

/** Give a task to someone else: { userId } or { role }, with a reason. */
async function reassign(id, to, opts) {
  opts = opts || {};
  if (!opts.reason || !String(opts.reason).trim()) throw fail(400, 'REASON_REQUIRED', 'Say why it is being reassigned.');
  to = to || {};
  if (!to.userId && !to.role) throw fail(400, 'ASSIGNEE_REQUIRED', 'Say who gets it: { userId } or { role }.');
  var task = await loadTask(id);
  if (task.status !== 'open' && task.status !== 'claimed' && task.status !== 'queued') throw fail(409, 'TASK_CLOSED', 'This task is no longer open.');
  await db.model('WorkflowTask').query().findById(id).patch({
    assigneeUserId: to.userId || null, assigneeRole: to.userId ? null : to.role,
    status: task.status === 'claimed' ? 'open' : task.status, claimedBy: null, claimedAt: null,
    history: noted(task, { what: 'reassigned', by: opts.actor || null, reason: String(opts.reason),
      from: task.assigneeUserId ? 'user:' + task.assigneeUserId : (task.assigneeRole || 'anyone'),
      to: to.userId ? 'user:' + to.userId : to.role })
  });
  var updated = await loadTask(id);
  tell('reassigned', updated);
  return updated;
}

// ── the sweeper's part ─────────────────────────────────────────────────────

/**
 * Overdue tasks: the host is told once (a reminder), and a task with
 * escalateTo moves to that role. Across tenants, each in its own.
 */
async function sweepDue() {
  var stamp = now();
  var due = await db.model('WorkflowTask').unscopedQuery().whereIn('status', ['open', 'claimed'])
    .whereNotNull('dueAt').where('dueAt', '<', stamp)
    .where(function(q) { q.whereNull('remindedAt').orWhere(function(e) { e.whereNotNull('escalateTo').whereNull('escalatedAt'); }); })
    .limit(100);
  var out = [];
  for (var i = 0; i < due.length; i++) {
    var t = due[i];
    var patch = {};
    var events = [];
    if (!t.remindedAt) { patch.remindedAt = stamp; events.push('due'); }
    if (t.escalateTo && !t.escalatedAt) {
      Object.assign(patch, {
        escalatedAt: stamp, assigneeRole: t.escalateTo, assigneeUserId: null, status: 'open', claimedBy: null, claimedAt: null,
        history: noted(t, { what: 'escalated', by: null, reason: 'Not answered by its due time',
          from: t.assigneeUserId ? 'user:' + t.assigneeUserId : (t.assigneeRole || 'anyone'), to: t.escalateTo })
      });
      events.push('escalated');
    }
    var changed = await db.model('WorkflowTask').unscopedQuery().findById(t.id).whereIn('status', ['open', 'claimed']).patch(patch);
    if (!changed) continue;
    var fresh = await db.model('WorkflowTask').unscopedQuery().findById(t.id);
    events.forEach(function(e) { tell(e, fresh); });
    out.push({ taskId: t.id, events: events });
  }
  return out;
}

module.exports = {
  afterPark: afterPark, listMine: listMine, claim: claim, release: release, answer: answer,
  reassign: reassign, sweepDue: sweepDue, closeForKey: closeForKey, withdraw: withdraw,
  setTaskHook: setTaskHook, verdictOf: verdictOf, isFor: isFor
};

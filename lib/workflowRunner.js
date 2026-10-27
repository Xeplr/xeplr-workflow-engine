// The engine. Two public entry points:
//
//   startRun(workflowId, params, opts)   — begin a new occurrence
//   resumeByKey(key, output)             — the ENTIRE consumer-side contract
//                                           for a 'wait' step. The caller
//                                           never needs to know which run or
//                                           step a key belongs to — that
//                                           lookup lives in
//                                           workflow_resume_keys alone.
//
// Everything else here is internal plumbing: resolving a step's `values`
// against the run's context, calling the action through @xeplr/actions'
// runAction (which validates input against the action's own inputSchema —
// this module never duplicates that), routing via transitions
// (@xeplr/expression-handler evaluates the structured condition), and
// fanning an 'each' transition out into child runs (see
// workflow_run_edges.sql) that this same engine drives independently.
//
// TENANT CONTEXT: every DB touch after the very first lookup runs inside
// runWithMt(mtOf(row), ...) using the RUN's own stored mtIds — never the
// caller's ambient context. A run can resume long after the request that
// started it has ended (a resume click days later, a fanned-out child
// finishing on its own), so there may be no ambient context at all — see
// @xeplr/jobs' lib/execute.js, which this follows exactly for the same
// reason.

var crypto = require('crypto');
var { generateId } = require('@xeplr/utils/lib/helpers');
var { runWithMt } = require('@xeplr/db');
var actions = require('@xeplr/actions');
var { runAction } = actions;
var { resolveAll, getPath, applySchema } = require('@xeplr/schema-handler');
var xf = require('@xeplr/expression-handler');
var db = require('./db');
var versions = require('./versions');
var actionCatalog = require('./actionCatalog');
var tasks = require('./tasks');
var { exposedEnv } = require('./envExposed');

// EVERY MODEL COMES THROUGH db.model(), never from models/index.js directly.
//
// This module is required before connectDb has run, so a class captured here
// at load time would carry the process's GLOBAL Objection binding — which,
// embedded in a host app, is the HOST's database. Every query would then look
// for workflow's tables somewhere they have never existed.
//
// Written out at each call site rather than hidden behind locals, so it is
// visible that these are bound lookups and not module-level classes. Same
// shape as @xeplr/auth's `auth.model('User').query()`. Objection caches per
// (Model, knex) pair, so the lookup is a map hit rather than a new class.

function uid() { return generateId(); }

function mintResumeKey() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Where a resume key can be reached from OUTSIDE this process.
 *
 * Read at the moment a wait step runs rather than captured at load, so the
 * same rule holds as everywhere else in this package: nothing about the
 * environment is frozen at require time. Null when unset — the refusal
 * belongs to whichever action actually needed it, which can say what it was
 * trying to do.
 *
 * The path is fixed because the route is: see router.js's
 * POST /public/resume/:key. WORKFLOW_PUBLIC_URL is the base a caller can
 * reach this service on, mount path included when a host mounted it under
 * one — e.g. https://bi.example.com/workflow
 */
function publicResumeUrl(key) {
  var base = process.env.WORKFLOW_PUBLIC_URL;
  if (!base) return null;
  return base.replace(/\/+$/, '') + '/public/resume/' + key;
}

// Every table here uses all four slots regardless of how many levels this
// app registered — an unregistered level is simply never read. See
// @xeplr/jobs' lib/execute.js mtOf() for the same reasoning.
function mtOf(row) {
  var ctx = {};
  for (var n = 1; n <= 4; n++) {
    var key = 'mtId' + n;
    if (row && row[key]) ctx[key] = row[key];
  }
  return ctx;
}

function stepMap(steps) {
  var byKey = {};
  steps.forEach(function(s) { byKey[s.stepKey] = s; });
  return byKey;
}

function nextByPosition(steps, step) {
  var idx = steps.findIndex(function(s) { return s.stepKey === step.stepKey; });
  return (idx > -1 && idx < steps.length - 1) ? steps[idx + 1].stepKey : null;
}

// ── THE LEASE ────────────────────────────────────────────────────────────
//
// Whoever moves a run holds it until `lockedUntil`, renewing while it works.
// A process that dies mid-step stops renewing, and lib/recovery.js finds the
// run still 'running' after the lease has passed. Without it a crash left the
// run 'running' forever, and nothing could tell it from one genuinely busy.
var timing = { leaseMs: 120000, renewMs: 30000 };

/** Shorter leases for a test that kills a process and waits for the sweeper. */
function setLeaseTiming(opts) {
  if (opts && opts.leaseMs) timing.leaseMs = opts.leaseMs;
  if (opts && opts.renewMs) timing.renewMs = opts.renewMs;
}

function leaseUntil() {
  return new Date(Date.now() + timing.leaseMs).toISOString();
}

/** Hold the run while `fn` runs; renewed on a timer that never keeps the process alive. */
async function underLease(runId, fn) {
  await db.model('WorkflowRun').unscopedQuery().findById(runId).patch({ lockedUntil: leaseUntil() });
  var timer = setInterval(function() {
    db.model('WorkflowRun').unscopedQuery().findById(runId).where({ status: 'running' }).patch({ lockedUntil: leaseUntil() })
      .catch(function(err) { console.error('[workflowRunner] could not renew the lease on run ' + runId + ':', err.message); });
  }, timing.renewMs);
  timer.unref();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

// ── PATHS ─────────────────────────────────────────────────────────────────
//
// Where a run is, as rows (0019, 0020). A run starts with one path. A step
// that leaves by EVERY matching arrow closes its path and opens one per arrow
// (a split); a meeting point closes the split's paths into one that carries
// on. The run is waiting when every open path is waiting, and done when none
// is open.
var OPEN = ['ready', 'running', 'waiting'];

async function openPath(run, stepKey, extra) {
  return db.model('WorkflowRunPath').query().insert(Object.assign({
    id: uid(), runId: run.id, stepKey: stepKey || null, status: 'ready', round: 0
  }, extra || {}, mtOf(run)));
}

/** The run's open path (the newest), made on first use for a run that has none. */
async function pathOf(run) {
  var path = await db.model('WorkflowRunPath').query().where({ runId: run.id }).whereIn('status', OPEN)
    .orderBy('recordCreatedDate', 'desc').first();
  return path || openPath(run, null);
}

function movePath(path, patch) {
  return db.model('WorkflowRunPath').query().findById(path.id).patch(patch);
}

/**
 * Ends the run, once. A second call — two paths failing at the same moment,
 * a meeting point and a path both deciding the run is over — changes nothing,
 * and the parent of a fanned-out child is told once.
 *
 * Every open path ends with it, and every live key is spent: an approver still
 * holding a link to a run that has ended gets "already used", not a run that
 * starts moving again.
 */
async function finishRun(run, status, error) {
  var startedAt = run.startedAt ? new Date(run.startedAt).getTime() : Date.now();
  var finishedAt = Date.now();
  var ended = await db.model('WorkflowRun').query().findById(run.id).whereNotIn('status', ['success', 'failed']).patch({
    status: status,
    error: error || null,
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    lockedUntil: null
  });
  if (!ended) return;
  await db.model('WorkflowRunPath').query().where({ runId: run.id }).whereIn('status', OPEN)
    .patch({ status: status === 'success' ? 'done' : 'failed' });
  await db.model('WorkflowResumeKey').query().where({ runId: run.id }).whereNull('consumedDate')
    .patch({ consumedDate: new Date(finishedAt).toISOString() });
  await tasks.withdraw(db.model('WorkflowTask').query().where({ runId: run.id }));
  await afterRunFinished(run.id);
}

/**
 * After a path stops — it waits, arrives, or ends — say what the RUN is now:
 * finished when no path is open, waiting when every open one waits, and
 * otherwise still running (another path is being moved right now).
 *
 * Each path writes its own status before reading the others', so of two paths
 * stopping at the same moment the later reader sees both.
 */
async function settleRun(run) {
  var open = await db.model('WorkflowRunPath').query().where({ runId: run.id }).whereIn('status', OPEN);
  if (!open.length) { await finishRun(run, 'success', null); return; }
  if (open.every(function(p) { return p.status === 'waiting'; })) {
    await db.model('WorkflowRun').query().findById(run.id).whereIn('status', ['running', 'waiting'])
      .patch({ status: 'waiting', lockedUntil: null });
  }
}

/**
 * A path reached an end (end_success, or past the last step). Only this path
 * is done. If it belonged to a split, the meeting point it will now never
 * reach is looked at again: "all" may be complete without it, and
 * "at least 2" may now be out of reach.
 */
async function endPath(workflow, steps, run, path) {
  await movePath(path, { status: 'done' });
  if (path.splitId) {
    var meeting = await meet(run, stepMap(steps), path.splitId, null);
    if (meeting && meeting.impossible) { await finishRun(run, 'failed', meeting.impossible); return; }
    if (meeting) { await walk(workflow, steps, run, meeting.merged.stepKey, { path: meeting.merged, met: true }); return; }
  }
  await settleRun(run);
}

// ── MEETING POINTS ────────────────────────────────────────────────────────

/** What a path brought: an approval's `decision`, or the screen button pressed. */
function decisionOf(output) {
  var d = output && (output.decision !== undefined && output.decision !== null ? output.decision : output.action);
  return d === undefined || d === null || d === '' ? null : String(d).slice(0, 64);
}

/**
 * The arrivals as conditions read them: `arrivals.rows` (one per path that
 * arrived: { path, from, decision, output }), `arrived`, `expected` (arrived +
 * still on their way), `approved`, `rejected`.
 */
function summarise(arrivals, pending) {
  var rows = arrivals.map(function(a) {
    return { path: a.pathId, from: a.fromStepKey || null, decision: a.decision || null, output: a.output || {} };
  });
  var count = function(re) { return rows.filter(function(r) { return re.test(r.decision || ''); }).length; };
  return { rows: rows, arrived: rows.length, expected: rows.length + pending,
    approved: count(/^approve/i), rejected: count(/^reject/i) };
}

/** 'go', 'wait', or 'never' (not enough paths left to reach `atLeast`). */
function verdictOf(join, summary, pending) {
  if (join.stopCondition && xf.evaluate(join.stopCondition, { arrivals: summary })) return 'go';
  var wait = join.wait || 'all';
  if (wait === 'any') return 'go';
  if (wait === 'all') return pending === 0 ? 'go' : 'wait';
  if (summary.arrived >= wait.atLeast) return 'go';
  return summary.arrived + pending < wait.atLeast ? 'never' : 'wait';
}

/**
 * A PATH ARRIVES AT A MEETING POINT (or, with `arriving` null, one of the
 * split's paths ended elsewhere and the meeting point is looked at again).
 *
 * Under a lock on the run row, so two approvals answered in the same second
 * queue: the first records its arrival and sees the other still open, the
 * second sees both and moves the case. Only paths the split ACTUALLY opened
 * and that can still arrive are waited for — an arrow whose condition was
 * false never opened one.
 *
 * Returns { merged } — the path that carries on, at the meeting step — or
 * { impossible } or null (keep waiting, or already met: a late arrival is
 * recorded and moves nothing).
 */
async function meet(run, byKey, splitId, arriving) {
  return db.conn().transaction(async function(trx) {
    await trx.raw('SELECT "id" FROM "workflow_runs" WHERE "id" = ? FOR UPDATE', [run.id]);
    var split = await db.model('WorkflowRunSplit').query(trx).findById(splitId);
    var now = new Date().toISOString();

    if (arriving) {
      var current = await db.model('WorkflowRunPath').query(trx).findById(arriving.path.id);
      // Cancelled by the meeting point while it was on its way: recorded, moves nothing.
      var late = Boolean(split.joinedAt) || !current || current.status === 'cancelled';
      await db.model('WorkflowRunArrival').query(trx).insert({
        id: uid(), runId: run.id, splitId: splitId, pathId: arriving.path.id, stepKey: arriving.step.stepKey,
        fromStepKey: arriving.fromStepKey || null, decision: decisionOf(arriving.output),
        output: arriving.output && typeof arriving.output === 'object' ? arriving.output : null, late: late
      });
      if (current && current.status !== 'cancelled') {
        await db.model('WorkflowRunPath').query(trx).findById(arriving.path.id).patch({ status: 'arrived', stepKey: arriving.step.stepKey });
      }
      if (late) return null;
    }
    if (split.joinedAt) return null;

    var arrivals = await db.model('WorkflowRunArrival').query(trx).where({ splitId: splitId, late: false }).orderBy('recordCreatedDate', 'asc');
    if (!arrivals.length) return null;
    var stepKey = arrivals[0].stepKey;
    var step = byKey[stepKey];
    var pending = await db.model('WorkflowRunPath').query(trx).where({ splitId: splitId }).whereIn('status', OPEN);
    var summary = summarise(arrivals, pending.length);
    var verdict = verdictOf(step.join || {}, summary, pending.length);
    if (verdict === 'wait') return null;

    await db.model('WorkflowRunSplit').query(trx).findById(splitId).patch({ joinedAt: now, joinStepKey: stepKey });
    if (verdict === 'never') {
      return { impossible: { code: 'JOIN_IMPOSSIBLE', message: 'Step "' + (step.name || stepKey) + '" waits for at least ' + step.join.wait.atLeast +
        ' paths, but only ' + summary.arrived + ' arrived and none are left on their way.' } };
    }

    // The paths still open: withdrawn (their waits and keys with them), or
    // left to finish and be recorded without moving the case.
    if (pending.length && (step.join.others || 'cancel') === 'cancel') {
      var ids = pending.map(function(p) { return p.id; });
      await db.model('WorkflowRunPath').query(trx).whereIn('id', ids).patch({ status: 'cancelled' });
      await db.model('WorkflowResumeKey').query(trx).whereIn('pathId', ids).whereNull('consumedDate').patch({ consumedDate: now });
      await tasks.withdraw(db.model('WorkflowTask').query(trx).whereIn('pathId', ids));
      await db.model('WorkflowStepRun').query(trx).whereIn('pathId', ids).where({ status: 'waiting' })
        .patch({ status: 'skipped', error: { code: 'WITHDRAWN', message: 'No longer needed: "' + (step.name || stepKey) + '" went ahead without it.' } });
    }

    var merged = await db.model('WorkflowRunPath').query(trx).insert(Object.assign({
      id: uid(), runId: run.id, parentPathId: arrivals[arrivals.length - 1].pathId, splitId: split.parentSplitId || null,
      fromSplitId: splitId, stepKey: stepKey, status: 'running', round: 0
    }, mtOf(run)));
    return { merged: merged };
  });
}

/** Open a path per target: the split. The path that reached it is done. */
async function openSplit(run, path, step, targets) {
  var row = await db.model('WorkflowRunSplit').query().insert(Object.assign({
    id: uid(), runId: run.id, stepKey: step.stepKey, pathId: path.id, parentSplitId: path.splitId || null, opened: targets.length
  }, mtOf(run)));
  await movePath(path, { status: 'done' });
  var opened = [];
  for (var i = 0; i < targets.length; i++) {
    opened.push(await openPath(run, targets[i], { parentPathId: path.id, splitId: row.id }));
  }
  return opened;
}

/**
 * EVERY RUN THAT ENDS TELLS ITS PARENT, wherever it ended.
 *
 * A fanned-out child used to report only when it finished in one go. One
 * that paused on a wait step (an approval, a screen) and finished on resume
 * never did, so a parent waiting to join waited forever. Ending is always
 * finishRun, so this is where it is told: the next queued sibling starts
 * (an arrow runs at most `limit` at once), and the parent joins when all are done.
 */
async function afterRunFinished(runId) {
  var edge = await db.model('WorkflowRunEdge').query().where({ childRunId: runId }).first();
  if (!edge) return;
  var parent = await db.model('WorkflowRun').query().findById(edge.parentRunId);
  if (!parent) return;
  var workflow = await db.model('Workflow').query().findById(parent.workflowId);
  var steps = await versions.stepsForRun(parent);
  await startNextQueued(workflow, steps, edge);
  await maybeCompleteParent(edge.parentRunId, edge.sourceStepKey, workflow, steps);
}

/** One queued sibling, claimed so two finishing at once never start the same one. */
async function startNextQueued(workflow, steps, edge) {
  var siblings = await db.model('WorkflowRunEdge').query()
    .where({ parentRunId: edge.parentRunId, sourceStepKey: edge.sourceStepKey }).orderBy('itemIndex');
  for (var i = 0; i < siblings.length; i++) {
    var claimed = await db.model('WorkflowRun').query().patch({ status: 'running', lockedUntil: leaseUntil() })
      .where({ id: siblings[i].childRunId, status: 'queued' });
    if (claimed) {
      var next = siblings[i];
      var target = next.targetStepKey || eachTargetOf(steps, next.sourceStepKey);
      // Not awaited, as every child start is: a child may sit on a wait
      // step for days.
      executeChildRun(workflow, steps, next.childRunId, target).catch(function(err) {
        console.error('[workflowRunner] child run ' + next.childRunId + ' failed to start:', err.message);
      });
      return;
    }
  }
}

/** For an edge from before targetStepKey was stored: the source step's "each" arrow. */
function eachTargetOf(steps, sourceStepKey) {
  var source = stepMap(steps)[sourceStepKey];
  var arrow = source && (source.transitions || []).find(function(t) { return t.mode === 'each'; });
  return arrow ? arrow.target : null;
}

// HOW THIS HOST TURNS A SAVED CONNECTION'S ID INTO ITS LOGIN (startEngine's
// resolveConnection). A step stores connectionInfoId; the login is put only
// into the call to the action, never into the step run's recorded input.
var connectionResolver = null;
function setConnectionResolver(fn) { connectionResolver = typeof fn === 'function' ? fn : null; }

/** How many items one "each" arrow runs at once, unless it says. */
var DEFAULT_FANOUT_LIMIT = 10;
/** How many times one step may run in one run, unless the workflow says. */
var DEFAULT_MAX_STEP_RUNS = 100;

/**
 * The run's context for resolving a step's `values` and evaluating its
 * transitions: previous_step / steps.<key> come from what has actually run
 * IN THIS RUN so far (not from array position — a jump via transitions means
 * the two can differ), params/item are the run's own, resumeKey is injected
 * separately, only for the specific step that needs it.
 */
/**
 * Resolve `{path}` bindings KEEPING TYPES: a string that is exactly one
 * binding takes the bound value as it is (an object stays an object, a number
 * a number); anything else is text, as interpolate makes it. One
 * implementation, in @xeplr/schema-handler, with the `|date:` pipe.
 */
function resolveTyped(value, context) {
  return resolveAll(value, context);
}

/**
 * WHAT A STEP IS GIVEN: its values resolved KEEPING TYPES, so
 * `from: "{steps.fetch.output.rows}"` hands the next step a list. Before,
 * every value was text: a list arrived as its JSON, and data-operation saw
 * one row that was a string.
 *
 * A field the action declares `string` still gets text — a number or a list
 * bound whole into a subject line is written out, as it always was — so an
 * action that expects text never meets anything else.
 */
function stepInput(step, context) {
  var values = resolveAll(step.values || {}, context);
  var def = actions.get(step.actionName);
  ((def && def.inputSchema) || []).forEach(function(field) {
    var v = values[field.name];
    if (field.type !== 'string' || v === null || v === undefined || typeof v === 'string') return;
    values[field.name] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
  return values;
}

// What started a run, as {trigger.*} reads it — in bindings AND in the
// conditions on arrows. A run started by hand has just its kind.
function triggerOf(run) {
  return run.triggerData || { kind: run.trigger || 'manual' };
}

/**
 * The paths a path came from: itself, the path that split into it, and so on
 * back to the start. A path reads its own steps and the ones before its
 * split — never a parallel path's, which may or may not have run yet. Those
 * reach the meeting point as `arrivals`.
 */
async function lineageOf(run, path) {
  if (!path) return null;
  var all = await db.model('WorkflowRunPath').query().where({ runId: run.id });
  var byId = {};
  all.forEach(function(p) { byId[p.id] = p; });
  var ids = {};
  for (var p = byId[path.id] || path; p; p = p.parentPathId ? byId[p.parentPathId] : null) {
    if (ids[p.id]) break;
    ids[p.id] = true;
  }
  return ids;
}

/** What arrived at the meeting point this path carries on from. */
async function arrivalsFor(path) {
  if (!path || !path.fromSplitId) return null;
  var arrivals = await db.model('WorkflowRunArrival').query().where({ splitId: path.fromSplitId, late: false }).orderBy('recordCreatedDate', 'asc');
  var pending = await db.model('WorkflowRunPath').query().where({ splitId: path.fromSplitId }).whereIn('status', OPEN).resultSize();
  return summarise(arrivals, pending);
}

async function buildContext(run, path) {
  var stepRuns = await db.model('WorkflowStepRun').query()
    .where({ runId: run.id })
    .whereIn('status', ['success', 'waiting', 'failed'])
    .orderBy('recordCreatedDate', 'asc');
  // A failed step is readable only when the run went on past it
  // (onError: continue), which gave it an output: { failed, error }.
  stepRuns = stepRuns.filter(function(sr) { return sr.status !== 'failed' || (sr.output && sr.output.failed); });
  var lineage = await lineageOf(run, path);
  if (lineage) stepRuns = stepRuns.filter(function(sr) { return !sr.pathId || lineage[sr.pathId]; });

  var byKey = {};
  stepRuns.forEach(function(sr) { byKey[sr.stepKey] = { output: sr.output || {} }; });
  var previous = stepRuns.length ? stepRuns[stepRuns.length - 1] : null;

  return {
    params: run.params || {},
    // WHAT STARTED THIS RUN (lib/triggers.js): a finished job's status,
    // window and output, a schedule's due time. {trigger.*} in a binding or a
    // condition. A run started by hand has just its kind.
    trigger: triggerOf(run),
    item: run.item || null,
    steps: byKey,
    previous_step: previous ? { output: previous.output || {} } : {},
    // At a meeting point and after it: what every path brought (summarise).
    arrivals: await arrivalsFor(path),
    // Only what WORKFLOW_ENV_EXPOSED names, never process.env itself — a
    // resolved input is echoed to the builder and persisted on the step run,
    // so anything reachable here is readable by anyone who can author a step.
    // See lib/envExposed.js.
    env: exposedEnv(),
    resumeKey: null,
    // The full URL that key resolves to. Set beside resumeKey on a wait step,
    // for the same reason and at the same moment — see executeFrom.
    resumeUrl: null
  };
}

/**
 * The schema a RUN is validated against: the union of what every step declares
 * it needs from the caller.
 *
 * Declared per STEP because the step is where you find out you need it — you
 * are binding `{params.customerEmail}` into an email-send's `to`, and that is
 * the moment to say the workflow requires it. Keeping a separate workflow-
 * level list means adding the requirement and adding the binding are two
 * actions in two places, and the day somebody does only the first the run
 * demands a parameter nothing reads.
 *
 * UNION RULES, for a name declared by more than one step:
 *
 *   required  ANY step requiring it makes it required. A caller cannot supply
 *             it to one step and not another — there is one value, asked for
 *             once, before any of them run.
 *   otherwise the FIRST declaration by step position wins (type, default,
 *             description). Two steps disagreeing about the type of one name
 *             is an authoring mistake, and picking the earlier one at least
 *             makes it deterministic rather than dependent on row order.
 *
 * `workflows.params` is folded in FIRST when present, so workflows that
 * declared at the workflow level before steps could carry it keep working —
 * and keep priority, since they are the older statement of intent.
 */
function collectParams(workflow, steps) {
  var byName = {};
  var order = [];

  function fold(declared) {
    (Array.isArray(declared) ? declared : []).forEach(function(f) {
      if (!f || !f.name) return;
      if (!byName[f.name]) {
        byName[f.name] = Object.assign({}, f);
        order.push(f.name);
        return;
      }
      // Already seen: the earlier declaration stands, except that requiring
      // it anywhere requires it everywhere.
      if (f.required) byName[f.name].required = true;
    });
  }

  fold(workflow.params);
  (steps || []).forEach(function(step) { fold(step.params); });

  return order.map(function(name, i) {
    return Object.assign({}, byName[name], { order: i + 1 });
  });
}

/**
 * Validate a caller's params against what the workflow's steps declare, and
 * return the set the run should actually use (declared defaults filled in).
 *
 * A workflow whose steps declare NOTHING takes whatever it is given,
 * unchanged. That is not a loophole — it is the state every workflow built
 * before this existed is in, and silently rejecting their params would break
 * them all. Declaring is how a workflow opts INTO being strict.
 *
 * Undeclared keys are dropped by applySchema, which is the same rule a step's
 * input follows. A caller passing `custmerId` gets told `customerId` is
 * missing rather than having the typo travel to the first step that reads it.
 */
function resolveParams(workflow, steps, params) {
  var declared = collectParams(workflow, steps);
  if (!declared.length) return params || {};
  try {
    return applySchema(declared, params || {}, 'params');
  } catch (err) {
    // Re-thrown with the workflow named. The caller asked to run "Onboard
    // customer", not to satisfy a schema, and the message is what a person
    // reads in a snackbar. `details` is carried through untouched so the run
    // dialog can mark the individual fields.
    var wrapped = new Error('Cannot run "' + workflow.name + '": ' + err.message);
    wrapped.details = err.details || [];
    wrapped.code = 'PARAMS_INVALID';
    throw wrapped;
  }
}

/**
 * Begin a new occurrence. Runs inside whatever tenant context is already
 * ambient (an authenticated HTTP request already has it, via mtMiddleware) —
 * BaseModel's $beforeInsert fills mtId1-4 on the new run from that context.
 */
async function startRun(workflowId, params, opts) {
  opts = opts || {};
  var workflow = await db.model('Workflow').query().findById(workflowId);
  if (!workflow) throw new Error('Workflow not found: ' + workflowId);
  var steps = await db.model('WorkflowStep').query().where({ workflowId: workflowId }).orderBy('position');
  if (!steps.length) throw new Error('Workflow "' + workflow.name + '" has no steps');

  // A WORKFLOW DECLARES ITS INPUTS THE WAY AN ACTION DOES, and refuses to
  // start without them. `workflows.params` is deliberately the same field
  // shape as an action's inputSchema (see 0003_workflows.sql), so this is the
  // same applySchema that runAction validates a step's input with — one
  // definition of what "required" means, for both levels of the product.
  //
  // BEFORE the run row is inserted. A refused start must leave nothing
  // behind: an occurrence recorded for a call that never ran a step is a row
  // somebody has to explain, and it would show up in the run list as a
  // failure of the workflow rather than of the caller.
  //
  // Missing `to` on a step is caught by the action, at the moment that step
  // runs — which can be the fourth step, twenty minutes in, after three
  // others have already written to a database. Missing `customerId` on the
  // WORKFLOW is caught here, before anything happens at all. That is the
  // whole reason this belongs at the top rather than in the step.
  var resolved = resolveParams(workflow, steps, params);

  // THE STEPS AS THEY ARE NOW are the steps this run reads to the end, whatever
  // is published while it waits (lib/versions.js).
  var versionId = await versions.pinVersion(workflowId, steps);

  var run = await db.model('WorkflowRun').query().insert({
    id: uid(),
    workflowId: workflowId,
    versionId: versionId,
    status: 'running',
    // Held from the first moment, so a crash before the first step is found too.
    lockedUntil: leaseUntil(),
    // The RESOLVED set, not what the caller typed: applySchema fills declared
    // defaults, and those are what the run actually used. Storing the raw
    // input would make workflow_runs.params ("the values the run was started
    // with, so a result can be explained") describe a run that never happened.
    params: resolved,
    trigger: opts.trigger || 'manual',
    // What fired it, in full — read by steps as {trigger.*}.
    triggerData: opts.triggerData || null,
    // WHO STARTED IT. Every caller already passes opts.user (the router hands
    // it req.user), and without this the column stayed null on every run —
    // which made "the runs I have not finished" an unanswerable question, and
    // that is the one question somebody halfway through a flow of screens
    // actually has. A fanned-out child is inserted elsewhere and inherits
    // nothing here on purpose: nobody started it.
    recordCreatedBy: (opts.user && opts.user.id) || null,
    startedAt: new Date().toISOString()
  });
  await openPath(run, steps[0].stepKey);

  await executeFrom(workflow, await versions.stepsForRun(run), run, steps[0].stepKey);
  return db.model('WorkflowRun').query().findById(run.id);
}

/**
 * Drive a path of a run forward from `startStepKey` until it pauses on a wait
 * step, arrives at a meeting point, splits, reaches an end, or fans out (see
 * handleFanOut — the parent's own progress stops at the fan-out point).
 *
 * opts.path      the path to move (default: the run's open one)
 * opts.cameWith  the output of the step that led here — what the path brings
 *                to a meeting point when it starts at one
 * opts.met       the path has already met (it carries on FROM the meeting
 *                point), so the meeting step runs rather than being arrived at
 */
async function executeFrom(workflow, steps, run, startStepKey, opts) {
  return leased(run, function() { return walk(workflow, steps, run, startStepKey, opts); });
}

function leased(run, fn) {
  return runWithMt(mtOf(run), function() { return underLease(run.id, fn); });
}

/** Carry a routing decision out: an end, a split, or the next step. */
async function follow(workflow, steps, run, path, routed, cameWith, fromStepKey) {
  if (routed.done) return;
  if (routed.end) return endPath(workflow, steps, run, path);
  if (routed.paths) {
    // One after another, in this call. "Parallel" is waiting in parallel —
    // two approvers each with their own task — not two steps executing at
    // the same instant.
    for (var i = 0; i < routed.paths.length; i++) {
      await walk(workflow, steps, run, routed.paths[i].stepKey, { path: routed.paths[i], cameWith: cameWith, fromStepKey: fromStepKey });
    }
    return;
  }
  return walk(workflow, steps, run, routed.next, { path: path, cameWith: cameWith, fromStepKey: fromStepKey });
}

async function walk(workflow, steps, run, startStepKey, opts) {
  opts = opts || {};
  var byKey = stepMap(steps);
  var cursor = startStepKey;
  var path = opts.path || await pathOf(run);
  var cameWith = opts.cameWith || null;
  var fromStepKey = opts.fromStepKey || null;
  var met = Boolean(opts.met);

  while (cursor) {
    var step = byKey[cursor];
    if (!step) { await finishRun(run, 'failed', { message: 'Unknown step: ' + cursor }); return; }

    // A MEETING POINT: the path arrives and waits for the split's other
    // paths, unless this arrival is the one that completes it.
    if (step.join && path.splitId && !met) {
      var meeting = await meet(run, byKey, path.splitId, { path: path, step: step, output: cameWith, fromStepKey: fromStepKey });
      if (meeting && meeting.impossible) { await finishRun(run, 'failed', meeting.impossible); return; }
      if (!meeting) { await settleRun(run); return; }
      path = meeting.merged;
    }
    met = false;

    // A LOOP IS STOPPED, NOT FOLLOWED. An arrow back to an earlier step with
    // no wait step on the way used to spin forever, holding a worker.
    var limit = workflow.maxStepRuns || DEFAULT_MAX_STEP_RUNS;
    var ranBefore = await db.model('WorkflowStepRun').query().where({ runId: run.id, stepKey: step.stepKey }).resultSize();
    if (ranBefore >= limit) {
      await finishRun(run, 'failed', { message: 'Step ' + step.stepKey + ' has run ' + ranBefore + ' times in this run, so it was stopped as a loop. ' +
        'If it is meant to repeat more, raise the workflow\'s maxStepRuns (now ' + limit + ').', code: 'LOOP_LIMIT' });
      return;
    }

    var context = await buildContext(run, path);
    var resolvedValues;
    try {
      resolvedValues = stepInput(step, context);
    } catch (err) {
      // A template the engine cannot fill ({x|date} on text, a zone that
      // is not one): the step fails saying so, rather than running with
      // an empty file name.
      await finishRun(run, 'failed', { message: 'Step ' + step.stepKey + ': ' + err.message });
      return;
    }

    // Taken only while open: a meeting point may have withdrawn this path
    // while it was on its way, and then it stops here.
    var taken = await db.model('WorkflowRunPath').query().findById(path.id).whereIn('status', OPEN)
      .patch({ stepKey: step.stepKey, status: 'running' });
    if (!taken) return;
    var stepRun = await db.model('WorkflowStepRun').query().insert({
      id: uid(), runId: run.id, pathId: path.id, stepId: step.id, stepKey: step.stepKey,
      actionName: step.actionName, status: 'running', input: resolvedValues, position: step.position
    });

    // A wait step's resume key has to exist BEFORE the action runs, since
    // the whole point is handing it to the action as input (a confirm
    // link, an approval URL) — so it's minted, folded into the context,
    // and the values are re-resolved with it available as {resumeKey}.
    //
    // THE ROW IS WRITTEN BEFORE THE ACTION TOO, not after it returns. The
    // action is what puts the key in front of somebody — the moment
    // email-send hands off, a click can arrive, and it routinely does:
    // mail scanners pre-fetch links within seconds of delivery. Inserting
    // afterwards left a window where the key was live in an inbox and
    // absent from the table, and resumeByKey answers that with "already
    // used or not valid" — which is the opposite of true and sends anyone
    // debugging it looking for a double-click that never happened.
    var resumeKey = null;
    var resumeKeyRowId = null;
    if (step.kind === 'wait') {
      resumeKey = mintResumeKey();
      context.resumeKey = resumeKey;
      // {resumeUrl} — THE WHOLE ADDRESS, not just the key.
      //
      // A step that hands its key to something OUTSIDE this process (a job,
      // an API, anything that will call back later) needs a URL, and the
      // author must not be the one assembling it: hardcoding this service's
      // own hostname into a step's values means every environment gets a
      // step that works in exactly one of them, and the failure is a
      // callback that quietly never arrives.
      //
      // Null when WORKFLOW_PUBLIC_URL is unset, and deliberately NOT
      // defaulted to localhost — a wrong-but-present address produces a
      // callback that goes nowhere and a run that waits forever, which is
      // far worse than an action refusing at the point of use and naming
      // the variable. Same rule the workspace keeps for database names.
      context.resumeUrl = publicResumeUrl(resumeKey);
      resolvedValues = stepInput(step, context);
      await db.model('WorkflowStepRun').query().findById(stepRun.id).patch({ input: resolvedValues });
      resumeKeyRowId = uid();
      await db.model('WorkflowResumeKey').query().insert({
        id: resumeKeyRowId, runId: run.id, pathId: path.id, stepId: step.id, key: resumeKey,
        // workflow_steps.timeoutMs, which nothing used to read: lib/recovery.js
        // fails the wait once this passes.
        expiresAt: step.timeoutMs ? new Date(Date.now() + step.timeoutMs).toISOString() : null
      });
    }

    // The recorded input keeps the connection's id; only this call gets the login.
    var callInput;
    try {
      callInput = await actions.resolveConnections(resolvedValues, connectionResolver, 'Step ' + step.stepKey);
    } catch (err) {
      callInput = null;
      var noLogin = err;
    }
    var result = callInput ? await runAction({
      name: step.actionName,
      input: callInput,
      // resumeKey: a wait step's own key, for an action that hands it to
      // something in this same process rather than over a URL (a job
      // started in-process reports back through jobs.jobFinished).
      // trigger: what started the run, for an action that carries it on
      // (job-run passes a job's period to the next job).
      // resolveTyped: a binding that is the WHOLE value keeps its type
      // ("{trigger.output.totalRows}" stays 7, "{trigger.window}" an object),
      // for an action that passes values on rather than printing them
      // (job-run's inputs and carry). Every other action takes `input`, as
      // resolved above, unchanged.
      system: { runId: run.id, stepId: step.id, stepKey: step.stepKey, resumeKey: resumeKey,
        trigger: triggerOf(run), rawValues: step.values || {},
        resolveTyped: function(value) { return resolveTyped(value, context); } }
    }) : { status: 'failed', output: null, durationMs: 0,
      // A saved connection that could not be resolved fails the step the way
      // its action failing would, so onError and the arrows apply alike.
      error: { name: noLogin.name, message: noLogin.message, code: noLogin.code || null } };

    if (result.status !== 'success') {
      await db.model('WorkflowStepRun').query().findById(stepRun.id).patch({
        status: 'failed', error: result.error, durationMs: result.durationMs
      });
      // The action never delivered the key, so burn it. Consumed rather
      // than deleted: the row is the record that this step DID reach the
      // point of minting one, which is worth keeping when working out why
      // a run stalled. Either way it can no longer resolve a call.
      if (resumeKeyRowId) {
        await db.model('WorkflowResumeKey').query().findById(resumeKeyRowId)
          .patch({ consumedDate: new Date().toISOString() });
      }
      // GOING ON PAST A FAILURE FOLLOWS THE ARROWS, the same as success. The
      // error is the step's output, so an arrow can send it somewhere of its
      // own (output.failed = true) and a later step can read what went wrong.
      // It used to go to the next step by position, ignoring every arrow.
      if (step.onError === 'continue') {
        var failedOutput = { failed: true, error: { message: (result.error && result.error.message) || 'Failed', code: (result.error && result.error.code) || null } };
        await db.model('WorkflowStepRun').query().findById(stepRun.id).patch({ output: failedOutput });
        var afterFailure = await routeAfterStep(workflow, steps, run, step, failedOutput, path, context);
        if (afterFailure.done || afterFailure.end || afterFailure.paths) return follow(workflow, steps, run, path, afterFailure, failedOutput, step.stepKey);
        cursor = afterFailure.next;
        cameWith = failedOutput;
        fromStepKey = step.stepKey;
        continue;
      }
      await finishRun(run, 'failed', result.error);
      return;
    }

    await db.model('WorkflowStepRun').query().findById(stepRun.id).patch({
      status: step.kind === 'wait' ? 'waiting' : 'success',
      output: result.output, durationMs: result.durationMs
    });

    if (step.kind === 'wait') {
      // The key row already exists (written before the action ran, above).
      // The RUN waits only when none of its other paths is still moving.
      await db.model('WorkflowRunPath').query().findById(path.id).where({ status: 'running' }).patch({ status: 'waiting' });
      // A screen or an approval: the people it waits for get their tasks.
      await tasks.afterPark(run, path, step, stepRun, resumeKeyRowId, resolvedValues);
      await settleRun(run);
      return; // paused — resumeByKey continues from exactly here
    }

    var routed = await routeAfterStep(workflow, steps, run, step, result.output, path, context);
    if (routed.done || routed.end || routed.paths) return follow(workflow, steps, run, path, routed, result.output, step.stepKey);
    cursor = routed.next;
    cameWith = result.output;
    fromStepKey = step.stepKey;
  }

  await endPath(workflow, steps, run, path);
}

/**
 * Decide what runs next after a step's OWN result. Returns one of:
 *
 *   { next }     the next step on this same path
 *   { paths }    a split: one new path per target (leave: 'every')
 *   { end }      this path is done (end_success, or past the last step)
 *   { done }     the run has been ended here (end_failed, end_run, a failure),
 *                or handed to a fan-out
 *
 * No transitions → the next step by position. With transitions, leave
 * 'first' (the default) takes the first matching row; leave 'every' takes
 * every matching row, each opening its own path. An 'each' row that matches
 * at least one element fans out (see handleFanOut); matching zero elements is
 * no match. No row matching, and no blank catch-all row, fails the run — a
 * silent fall-through would hide a branch nobody accounted for.
 *
 * Arrows read `output`, `item`, `params`, `trigger`, every earlier step on
 * this path as `steps.<key>.output` (what a step's values could always read),
 * and at a meeting point `arrivals`.
 */
async function routeAfterStep(workflow, steps, run, step, output, path, context) {
  var byKey = stepMap(steps);

  if (!step.transitions || !step.transitions.length) {
    var next = nextByPosition(steps, step);
    return next ? { done: false, next: next } : { done: false, end: true };
  }

  var row = { output: output, item: run.item, params: run.params, trigger: triggerOf(run),
    steps: (context && context.steps) || {}, arrivals: (context && context.arrivals) || null };
  var every = step.leave === 'every';
  var targets = [];

  for (var i = 0; i < step.transitions.length; i++) {
    var t = step.transitions[i];
    var matches = !t.condition || xf.evaluate(t.condition, row);
    if (!matches) continue;

    // LET A FUNCTION DECIDE: the arrow names a registered `decide` function,
    // and its answer is the next step. It must be a step of this workflow —
    // one of the arrow's `targets` when it lists them — or an end; anything
    // else fails the run, by name, rather than wandering somewhere nobody drew.
    var target = t.target;
    if (t.decide) {
      try {
        target = await decideTarget(t, row, step, byKey, run);
      } catch (err) {
        await finishRun(run, 'failed', { message: err.message });
        return { done: true };
      }
      if (target === 'end_failed') { await finishRun(run, 'failed', { message: 'Ended by "' + t.decide + '" on ' + step.stepKey }); return { done: true }; }
    }

    if (t.mode === 'each') {
      var fannedOut = await handleFanOut(workflow, steps, run, step, t, output);
      if (fannedOut) return { done: true };
      continue; // 0 elements matched — not a real match, keep looking
    }

    if (target === 'end_failed') { await finishRun(run, 'failed', { message: 'Ended by transition on ' + step.stepKey }); return { done: true }; }
    // The whole case is finished, whatever else is still open.
    if (target === 'end_run') { await finishRun(run, 'success', null); return { done: true }; }
    if (target !== 'end_success' && !byKey[target]) { await finishRun(run, 'failed', { message: 'Transition on ' + step.stepKey + ' targets unknown step: ' + target }); return { done: true }; }
    if (!every) return target === 'end_success' ? { done: false, end: true } : { done: false, next: target };
    targets.push(target);
  }

  if (every && targets.length) {
    // end_success opens nothing: that arrow's path is simply done.
    var opened = targets.filter(function(k) { return k !== 'end_success'; });
    if (!opened.length) return { done: false, end: true };
    return { done: false, paths: await openSplit(run, path, step, opened) };
  }

  await finishRun(run, 'failed', { message: 'No transition matched on step ' + step.stepKey + ' and there is no catch-all row' });
  return { done: true };
}

/**
 * Ask an arrow's `decide` function where to go. It is called with what the
 * step produced (`output` — for a screen, what was filled in — also as
 * `values`), the run's `params`, `item` and `trigger`, the step it is leaving
 * and the steps it may choose from; it returns a step key, 'end_success',
 * 'end_failed' or 'end_run'. Throws, with the function's name, for anything else.
 */
async function decideTarget(t, row, step, byKey, run) {
  var def = actions.get(t.decide);
  if (!def) throw new Error('Step ' + step.stepKey + ' asks "' + t.decide + '" where to go next, but no function of that name is registered');
  if (def.event !== 'decide') throw new Error('Step ' + step.stepKey + ' asks "' + t.decide + '" where to go next, but it is written for ' + (def.event ? '"' + def.event + '"' : 'a workflow step'));
  var allowed = Array.isArray(t.targets) && t.targets.length ? t.targets : Object.keys(byKey).concat(['end_success', 'end_failed', 'end_run']);
  var answer = await def.execute({
    output: row.output, values: row.output, params: row.params, item: row.item, trigger: row.trigger,
    step: step.stepKey, runId: run.id, targets: allowed.slice()
  });
  var key = typeof answer === 'string' ? answer.trim() : '';
  if (!key) throw new Error('"' + t.decide + '" did not say where to go next from ' + step.stepKey);
  if (allowed.indexOf(key) === -1) throw new Error('"' + t.decide + '" chose "' + key + '" from ' + step.stepKey + ', which is not one of: ' + allowed.join(', '));
  if (key !== 'end_success' && key !== 'end_failed' && key !== 'end_run' && !byKey[key]) throw new Error('"' + t.decide + '" chose "' + key + '", which is not a step of this workflow');
  return key;
}

/**
 * `t.source` is a dotted path to the array to fan over (resolved against
 * { output, item, params } — usually `output.<field>`). Each element that
 * also satisfies `t.condition` becomes its own child run, seeded with that
 * element as `item`, starting at `t.target`. The parent's own progress stops
 * here: it either finishes immediately (no joinStep — its job was just to
 * spawn the children) or sits at status 'waiting' until every child reaches
 * a terminal state, at which point maybeCompleteParent resumes it at
 * `step.joinStep`.
 */
async function handleFanOut(workflow, steps, run, step, t, output) {
  // A fan-out stops the run's own progress and waits for its children; with
  // other paths of the same run still open, there would be nothing to stop
  // or wait with. Said plainly rather than half-done.
  var open = await db.model('WorkflowRunPath').query().where({ runId: run.id }).whereIn('status', OPEN).resultSize();
  if (open > 1) {
    await finishRun(run, 'failed', { code: 'EACH_IN_PARALLEL', message: 'Step "' + (step.name || step.stepKey) + '" goes through a list ' +
      'for each item while this case is also on other paths. Put the list before the split, or after the meeting point.' });
    return true;
  }
  var array = t.source ? getPath({ output: output, item: run.item, params: run.params, trigger: triggerOf(run) }, t.source) : null;
  if (!Array.isArray(array)) return false;

  var matches = [];
  array.forEach(function(el, idx) {
    var elRow = { output: output, item: el, params: run.params, trigger: triggerOf(run) };
    if (!t.condition || xf.evaluate(t.condition, elRow)) matches.push({ el: el, idx: idx });
  });
  if (!matches.length) return false;

  var childIds = [];
  for (var i = 0; i < matches.length; i++) {
    var m = matches[i];
    var itemKey = m.el && typeof m.el === 'object' ? (m.el.id || m.el.messageId || m.el.key) : null;
    var child = await db.model('WorkflowRun').query().insert(Object.assign({
      id: uid(), workflowId: workflow.id, versionId: run.versionId || null, status: 'queued', params: run.params,
      triggerData: run.triggerData || null, item: m.el, trigger: 'fanout', startedAt: new Date().toISOString()
    }, mtOf(run)));
    await openPath(child, t.target);
    await db.model('WorkflowRunEdge').query().insert({
      id: uid(), parentRunId: run.id, childRunId: child.id,
      sourceStepKey: step.stepKey, targetStepKey: t.target, itemIndex: m.idx,
      itemKey: itemKey != null ? String(itemKey) : null, item: m.el
    });
    childIds.push(child.id);
  }

  if (step.joinStep) {
    await db.model('WorkflowRun').query().findById(run.id).patch({ status: 'waiting', lockedUntil: null });
    await db.model('WorkflowRunPath').query().where({ runId: run.id, status: 'running' }).patch({ status: 'waiting' });
  } else {
    await finishRun(run, 'success', null);
  }

  // AT MOST `limit` AT ONCE (default 10). The rest wait as 'queued', and
  // each child that ends starts the next (afterRunFinished). A list of 500
  // emails used to start 500 runs, and 500 connections, at the same moment.
  //
  // Not awaited — a child may sit on a wait step for days, and the parent's
  // own fate (done above, or waiting on the join) does not depend on how
  // long that takes.
  var atOnce = t.limit || DEFAULT_FANOUT_LIMIT;
  for (var c = 0; c < childIds.length && c < atOnce; c++) {
    (function(childId) {
      db.model('WorkflowRun').query().patch({ status: 'running', lockedUntil: leaseUntil() }).where({ id: childId, status: 'queued' }).then(function(claimed) {
        if (!claimed) return;
        return executeChildRun(workflow, steps, childId, t.target);
      }).catch(function(err) {
        console.error('[workflowRunner] child run ' + childId + ' failed to start:', err.message);
      });
    })(childIds[c]);
  }

  return true;
}

// The child is already claimed ('queued' → 'running') by whoever starts it.
// Its parent hears that it ended through finishRun → afterRunFinished,
// whether it ends here or days later on a resume.
async function executeChildRun(workflow, steps, runId, startStepKey) {
  var run = await db.model('WorkflowRun').unscopedQuery().findById(runId);
  await runWithMt(mtOf(run), async function() {
    var fresh = await db.model('WorkflowRun').query().findById(runId);
    await executeFrom(workflow, steps, fresh, startStepKey);
  });
}

/**
 * Called by every sibling as it finishes. Only the sibling that observes ALL
 * of them terminal actually proceeds — guarded by an atomic
 * waiting → running patch (same compare-and-swap shape as @xeplr/jobs'
 * per-job lock) so two children finishing near-simultaneously cannot both
 * run the join step.
 */
async function maybeCompleteParent(parentRunId, sourceStepKey, workflow, steps) {
  var parent = await db.model('WorkflowRun').unscopedQuery().findById(parentRunId);
  if (!parent || parent.status !== 'waiting') return; // no join configured, or already handled

  return runWithMt(mtOf(parent), async function() {
    var edges = await db.model('WorkflowRunEdge').query().where({ parentRunId: parentRunId, sourceStepKey: sourceStepKey });
    var childIds = edges.map(function(e) { return e.childRunId; });
    var children = childIds.length ? await db.model('WorkflowRun').query().whereIn('id', childIds) : [];
    var allDone = children.length > 0 && children.every(function(c) { return c.status === 'success' || c.status === 'failed'; });
    if (!allDone) return;

    var claimed = await db.model('WorkflowRun').query().patch({ status: 'running', lockedUntil: leaseUntil() }).where({ id: parentRunId, status: 'waiting' });
    if (claimed === 0) return; // another sibling already won the race

    var byKey = stepMap(steps);
    var sourceStep = byKey[sourceStepKey];
    if (!sourceStep || !sourceStep.joinStep) {
      await finishRun({ id: parentRunId, startedAt: parent.startedAt }, 'success', null);
      return;
    }

    var fresh = await db.model('WorkflowRun').query().findById(parentRunId);
    await executeFrom(workflow, steps, fresh, sourceStep.joinStep);
  });
}

/**
 * The entire consumer-side contract for a wait step. The caller supplies
 * only what it was handed — the key — and whatever output the resolution
 * carries (an approval decision, submitted form fields; can be omitted for a
 * bare "this happened" signal like an email confirmation click).
 */
function invalidKey() {
  var err = new Error('This link has already been used or is not valid.');
  // So a HOST can tell the two apart. Its activation route is called for
  // every user, including ones who never came from a workflow, and "no
  // workflow was waiting on this" is a normal outcome there — not something
  // to surface as a failure. Without a code the only way to classify it is
  // matching on the message, which is a sentence written to be read by a
  // person and will be reworded.
  err.code = 'RESUME_KEY_INVALID';
  return err;
}

function notReadyKey() {
  var err = new Error('This step is still running — try again in a moment.');
  err.code = 'RESUME_KEY_NOT_READY';
  return err;
}

/**
 * A RESUME CAN BE A FAILURE.
 *
 * `opts.status === 'failed'` resolves the parked step as failed instead of
 * succeeded, and from there the step's ordinary `onError` decides what
 * happens — 'stop' (the default) fails the run, 'continue' moves on by
 * position. No new concept: it is the same treatment a step gets when its own
 * action fails, arriving down a different road.
 *
 * This is what a job chain needs. A workflow step that starts a twenty-minute
 * movement parks on its key; the job fails, times out, or is refused because
 * the job was already running; and without this the step would resolve as
 * SUCCESSFUL carrying a failure in its output. The next step would then run
 * against data that was never moved — an aggregation over a period nothing
 * loaded, a deletion of rows that were never replaced. Silently, because
 * every status on the screen would read green.
 *
 * The caller says which it is, because only the caller knows. @xeplr/jobs
 * decides that 'skipped', 'timedOut' and 'interrupted' all mean "the work did
 * not happen" and sends `status: 'failed'`; this engine never learns jobs'
 * vocabulary.
 *
 * OPTIONAL, and absent means success — every existing caller (an approval
 * click, a confirmation link) resolves a step that succeeded, and none of
 * them should have to start saying so.
 */
async function resumeByKey(key, output, opts) {
  opts = opts || {};
  var pending = await db.model('WorkflowResumeKey').unscopedQuery().where({ key: key, consumedDate: null }).first();
  if (!pending) throw invalidKey();

  var run = await db.model('WorkflowRun').unscopedQuery().findById(pending.runId);
  if (!run) throw invalidKey();

  return runWithMt(mtOf(run), async function() {
    var workflow = await db.model('Workflow').query().findById(run.workflowId);
    // The steps the run STARTED with (lib/versions.js), so a design saved
    // while it waited — even one that re-created every step — cannot strand it.
    var steps = await versions.stepsForRun(run);
    var step = steps.filter(function(st) { return st.id === pending.stepId; })[0];
    if (!step) throw invalidKey();

    // READ BEFORE CLAIMING, and refuse if the step has not actually parked
    // yet. The key row is written before the action runs (see executeFrom),
    // so between email-send handing off and the step being marked 'waiting'
    // there is a live key attached to a step that is still executing. A
    // resume in that window would route the run onward WHILE the wait step's
    // own action is mid-flight. Rejecting without consuming is what makes it
    // recoverable: the caller retries in a moment and it works.
    var existingStepRun = await db.model('WorkflowStepRun').query()
      .where({ runId: run.id, stepId: step.id, status: 'waiting' }).first();
    if (!existingStepRun) throw notReadyKey();

    var mergedOutput = Object.assign({}, existingStepRun.output, output || {});
    var failed = opts.status === 'failed';

    // ONE TRANSACTION: the key is spent, the answer recorded and the run
    // taken, or none of it. A crash between the three used to leave a spent
    // key on a run still 'waiting' — waiting for an answer it had already
    // been given, which nothing could ever deliver again. Now a crash after
    // it leaves a run 'running' under a lease, and lib/recovery.js routes it
    // on from the recorded answer.
    var claimed = await db.conn().transaction(async function(trx) {
      // Still the atomic conditional patch, so two concurrent calls that both
      // saw 'waiting' cannot both win.
      var claim = await db.model('WorkflowResumeKey').query(trx)
        .patch({ consumedDate: new Date().toISOString() })
        .where({ id: pending.id, consumedDate: null });
      if (claim === 0) return false;

      await db.model('WorkflowStepRun').query(trx).findById(existingStepRun.id).patch({
        status: failed ? 'failed' : 'success',
        output: mergedOutput,
        // KEPT even on a failure. The job's own output — rows moved, the window
        // it actually covered — is what makes the failure diagnosable, and on a
        // partial movement it is also what says how far it got.
        error: failed ? (opts.error || { message: 'The waiting step was resolved as failed.' }) : null,
        // WHO answered it: the person who submitted the screen, or whose
        // approval decided it. Null for a machine (an email link, a job).
        actorUserId: opts.actor || null
      });
      await tasks.closeForKey(trx, pending.id, opts.actor || null, mergedOutput);
      await db.model('WorkflowRun').query(trx).findById(run.id).patch({ status: 'running', lockedUntil: leaseUntil() });
      if (pending.pathId) {
        await db.model('WorkflowRunPath').query(trx).findById(pending.pathId).patch({ status: 'running' });
      }
      return true;
    });
    if (!claimed) throw invalidKey();
    var fresh = await db.model('WorkflowRun').query().findById(run.id);
    // The path this answer belongs to; a key from before paths has none.
    var path = (pending.pathId && await db.model('WorkflowRunPath').query().findById(pending.pathId)) || await pathOf(fresh);

    if (failed) {
      // EXACTLY the branch executeFrom takes when a step's own action fails —
      // written out rather than shared, because the two arrive with different
      // things already done (there is no action result here, and the step run
      // is already patched above). The RULE is what matters and it is the
      // same one: onError decides, and it defaults to stopping.
      if (step.onError !== 'continue') {
        await finishRun(fresh, 'failed', opts.error || { message: 'Step ' + step.stepKey + ' was resolved as failed.' });
        return { runId: run.id, stepKey: step.stepKey, status: 'failed' };
      }
      var after = nextByPosition(steps, step);
      await leased(fresh, function() {
        return follow(workflow, steps, fresh, path, after ? { next: after } : { end: true }, mergedOutput, step.stepKey);
      });
      return { runId: run.id, stepKey: step.stepKey, status: 'failed' };
    }

    await leased(fresh, async function() {
      var routed = await routeAfterStep(workflow, steps, fresh, step, mergedOutput, path, await buildContext(fresh, path));
      return follow(workflow, steps, fresh, path, routed, mergedOutput, step.stepKey);
    });

    return { runId: run.id, stepKey: step.stepKey, status: 'success' };
  });
}

function interrupted(message) {
  return { code: 'INTERRUPTED', message: message };
}

/**
 * PICK UP A RUN WHOSE PROCESS DIED. Called by lib/recovery.js once it holds
 * the run's expired lease. Each path that was moving is picked up on its own,
 * from the last thing it recorded:
 *
 *   nothing        it died before the path's first step — start it there
 *   running        a step was mid-way. Run it again only if it is safe to
 *                  (actionCatalog.isSafeToRetry: reads, computes, screens);
 *                  otherwise stop as INTERRUPTED. An email may already be
 *                  sent, a file uploaded — a person checks, not a guess.
 *   waiting        it parked but never said so — mark it waiting
 *   success        the step finished and the run died choosing the next one
 *                  — choose again, which has no effect of its own. Not after
 *                  a fan-out started: some children may exist, so stop.
 *   failed         it ends as that step did, or goes on past it (onError:
 *                  continue) exactly as it would have
 */
async function recoverRun(run) {
  return runWithMt(mtOf(run), async function() {
    var workflow = await db.model('Workflow').query().findById(run.workflowId);
    var steps = await versions.stepsForRun(run);
    var moving = await db.model('WorkflowRunPath').query().where({ runId: run.id }).whereIn('status', ['ready', 'running'])
      .orderBy('recordCreatedDate', 'asc');
    if (!moving.length) moving = [await pathOf(run)];
    var outcomes = [];
    for (var i = 0; i < moving.length; i++) {
      var current = await db.model('WorkflowRunPath').query().findById(moving[i].id);
      // An earlier path's recovery may have ended the run, or met this one.
      var live = await db.model('WorkflowRun').query().findById(run.id);
      if (!current || OPEN.indexOf(current.status) === -1 || ['success', 'failed'].indexOf(live.status) > -1) continue;
      outcomes.push(await recoverPath(workflow, steps, run, current, moving.length === 1));
    }
    var still = await db.model('WorkflowRun').query().findById(run.id);
    if (still.status === 'running') await settleRun(still);
    return outcomes.length === 1 ? outcomes[0] : outcomes;
  });
}

async function recoverPath(workflow, steps, run, path, onlyPath) {
  var byKey = stepMap(steps);
  var last = await db.model('WorkflowStepRun').query().where({ runId: run.id, pathId: path.id }).orderBy('recordCreatedDate', 'desc').first();
  // Step runs from before paths carry none; the run's only path owns them.
  if (!last && onlyPath) last = await db.model('WorkflowStepRun').query().where({ runId: run.id }).orderBy('recordCreatedDate', 'desc').first();

  if (!last) {
    await executeFrom(workflow, steps, run, path.stepKey || steps[0].stepKey, { path: path });
    return 'restarted';
  }
  var step = byKey[last.stepKey];
  var name = '"' + ((step && step.name) || last.stepKey) + '"';
  if (!step) {
    await finishRun(run, 'failed', interrupted('The server stopped while step ' + name + ' was running, and that step is no longer part of this run.'));
    return 'stopped';
  }

  if (last.status === 'running') {
    await db.model('WorkflowStepRun').query().findById(last.id).patch({
      status: 'interrupted', error: interrupted('The server stopped while this step was running.')
    });
    // A key minted for it is spent: the action may never have handed it on.
    await db.model('WorkflowResumeKey').query().where({ runId: run.id, stepId: last.stepId, consumedDate: null })
      .patch({ consumedDate: new Date().toISOString() });
    await tasks.withdraw(db.model('WorkflowTask').query().where({ stepRunId: last.id }));
    if (actionCatalog.isSafeToRetry(step.actionName)) {
      await executeFrom(workflow, steps, run, step.stepKey, { path: path, met: true });
      return 'retried';
    }
    await finishRun(run, 'failed', interrupted('The server stopped while step ' + name + ' was running. It was not run again, ' +
      'because it may already have done its work (sent, saved or moved something). Check it, then run the workflow again.'));
    return 'stopped';
  }

  if (last.status === 'waiting') {
    await movePath(path, { status: 'waiting' });
    await settleRun(run);
    return 'parked';
  }

  var goesOn = last.status === 'success' ||
    (last.status === 'failed' && step.onError === 'continue' && last.output && last.output.failed);
  if (goesOn) {
    var fannedOut = await db.model('WorkflowRunEdge').query().where({ parentRunId: run.id, sourceStepKey: step.stepKey }).resultSize();
    if (fannedOut) {
      await finishRun(run, 'failed', interrupted('The server stopped while step ' + name + ' was starting one run per item. ' +
        'Some of them may have started; check them before running the workflow again.'));
      return 'stopped';
    }
    await leased(run, async function() {
      var routed = await routeAfterStep(workflow, steps, run, step, last.output || {}, path, await buildContext(run, path));
      return follow(workflow, steps, run, path, routed, last.output || {}, step.stepKey);
    });
    return 'routed';
  }

  await finishRun(run, 'failed', last.error || interrupted('The server stopped after step ' + name + ' failed.'));
  return 'stopped';
}

// ── ADMIN ─────────────────────────────────────────────────────────────────
//
// What a person with workflows:admin may do to a case that is stuck or wrong.
// Each needs a reason, and the reason and who gave it are kept on the case.

function refused(status, code, message) {
  var err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function reasonOf(opts) {
  var reason = opts && opts.reason ? String(opts.reason).trim() : '';
  if (!reason) throw refused(400, 'REASON_REQUIRED', 'Say why.');
  return reason;
}

/** Stop a case that is still going. Its tasks and links stop working. */
async function cancelRun(runId, opts) {
  var reason = reasonOf(opts);
  var run = await db.model('WorkflowRun').query().findById(runId);
  if (!run) throw refused(404, 'RUN_NOT_FOUND', 'No run "' + runId + '".');
  if (['success', 'failed'].indexOf(run.status) > -1) throw refused(409, 'RUN_FINISHED', 'This case has already finished.');
  await finishRun(run, 'failed', { code: 'CANCELLED', message: 'Cancelled: ' + reason, by: (opts && opts.actor) || null });
  return db.model('WorkflowRun').query().findById(runId);
}

/**
 * Run again the step a crash interrupted, once a person has checked it did
 * not already do its work (lib/recovery.js stopped it as INTERRUPTED rather
 * than guess). Only for a case that was on one path: one that was waiting
 * elsewhere too lost those waits when it stopped, so it is started afresh.
 */
async function retryRun(runId, opts) {
  var reason = reasonOf(opts);
  var run = await db.model('WorkflowRun').query().findById(runId);
  if (!run) throw refused(404, 'RUN_NOT_FOUND', 'No run "' + runId + '".');
  if (run.status !== 'failed' || !run.error || run.error.code !== 'INTERRUPTED') {
    throw refused(409, 'NOT_INTERRUPTED', 'Only a case stopped because the server stopped mid-step can be run again from that step.');
  }
  var stopped = await db.model('WorkflowRunPath').query().where({ runId: runId, status: 'failed' });
  if (stopped.length > 1) {
    throw refused(409, 'SEVERAL_PATHS', 'This case was on several paths when it stopped; start it again instead.');
  }
  var interruptedRun = await db.model('WorkflowStepRun').query().where({ runId: runId, status: 'interrupted' }).orderBy('recordCreatedDate', 'desc').first();
  var workflow = await db.model('Workflow').query().findById(run.workflowId);
  var steps = await versions.stepsForRun(run);
  var step = interruptedRun && stepMap(steps)[interruptedRun.stepKey];
  if (!step) throw refused(409, 'NOT_INTERRUPTED', 'The step that was interrupted is not part of this case.');

  await db.model('WorkflowStepRun').query().findById(interruptedRun.id).patch({
    error: Object.assign({}, interruptedRun.error, { retriedBy: (opts && opts.actor) || null, retryReason: reason, retriedAt: new Date().toISOString() })
  });
  var path = stopped[0] || await pathOf(run);
  await movePath(path, { status: 'ready' });
  await db.model('WorkflowRun').query().findById(runId).patch({ status: 'running', error: null, finishedAt: null, durationMs: null, lockedUntil: leaseUntil() });
  var fresh = await db.model('WorkflowRun').query().findById(runId);
  await executeFrom(workflow, steps, fresh, step.stepKey, { path: path, met: true });
  return db.model('WorkflowRun').query().findById(runId);
}

// resolveParams and collectParams are exported for their own sake: they are
// the pieces of the engine that are pure — rows in, a schema or a resolved
// set out, or a throw — and testing them needs no database.
module.exports = {
  resolveTyped: resolveTyped, stepInput: stepInput, setConnectionResolver: setConnectionResolver, startRun: startRun, resumeByKey: resumeByKey, resolveParams: resolveParams, collectParams: collectParams,
  // For lib/recovery.js.
  recoverRun: recoverRun, leaseUntil: leaseUntil, setLeaseTiming: setLeaseTiming, mtOf: mtOf,
  // Admin (lib/tasks.js has reassign).
  cancelRun: cancelRun, retryRun: retryRun };

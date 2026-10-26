// TRIGGERS — WHAT STARTS A WORKFLOW, FOR EVERY KIND OF START.
//
// A workflow's `trigger` (0014) says what is supposed to start it. This module
// is what acts on it: one registry of kinds, the same way actions are one
// registry of steps. A kind is a name and up to three functions:
//
//   validate(trigger)  → the trigger normalised, or throws naming the problem
//   due(trigger, from) → for a kind that fires on time: the next moment it is
//                        due after `from` (Date), or null
//   matches(trigger, event) → for a kind that fires on an event: whether this
//                        event is the one it waits for
//
// Built in: manual and api (nothing to arm — someone or something calls the
// run), schedule (a cron expression), and job (a job finished). Folder and
// mailbox watchers are later kinds of the same registry; a host can register
// its own with registerTrigger().
//
// THE SAME RULES FOR EVERY KIND:
//   * only a PUBLISHED workflow fires; a draft never does
//   * `enabled: false` switches a trigger off without losing it
//   * a run is started with what fired it as `triggerData`, which steps read
//     as {trigger.*} ({trigger.status}, {trigger.window.from}, {trigger.dueAt})
//   * every fire and every skip is recorded on workflow_trigger_states, so
//     "when did it last run, when is it next due, why did it not start" is a
//     row, not a log search
var { runWithMt } = require('@xeplr/db');
var { generateId } = require('@xeplr/utils/lib/helpers');
var parser = require('cron-parser');
var db = require('./db');

var KINDS = {};
var JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,25}$/;
var JOB_WHEN = ['success', 'failed', 'finished'];

// A model validation error by NAME (as Objection's is), so the generic save
// route answers it as one — 422 with the reason under `fields.trigger` —
// rather than as a server error. status/code are for callers of the engine.
function invalid(message) {
  var err = new Error(message);
  err.name = 'ValidationError';
  err.type = 'ModelValidation';
  err.data = { trigger: [{ message: message, keyword: 'trigger' }] };
  err.statusCode = 400;
  err.status = 400;
  err.code = 'TRIGGER_INVALID';
  return err;
}

/** Add (or replace) a kind of trigger. */
function registerTrigger(kind, def) {
  if (!kind || typeof kind !== 'string') throw new Error('registerTrigger: a kind name is required');
  KINDS[kind] = Object.assign({ kind: kind }, def || {});
}

function kinds() { return Object.keys(KINDS); }

/**
 * Every kind, as a designer offers it: { kind, label, description, fields }.
 * `fields` is what the form asks for ({ name, label, placeholder?, help?,
 * required?, options? }). A designer builds its trigger form from this rather
 * than from its own list, so it never offers a kind this engine refuses.
 */
function catalog() {
  return Object.keys(KINDS).map(function(k) {
    var d = KINDS[k];
    return { kind: k, label: d.label || k, description: d.description || '', fields: d.fields || [] };
  });
}

function common(trigger) {
  var out = { kind: trigger.kind };
  if (trigger.enabled === false) out.enabled = false;
  return out;
}

registerTrigger('manual', {
  label: 'Someone presses Start',
  description: 'Someone presses Start.',
  fields: [],
  validate: common
});

registerTrigger('api', {
  label: 'Another system calls it',
  description: 'Another system starts it through the API.',
  fields: [],
  validate: common
});

registerTrigger('schedule', {
  label: 'On a schedule',
  description: 'On a schedule — a cron expression, e.g. "0 9 * * 1" for Mondays at 9.',
  fields: [
    { name: 'cron', label: 'When', placeholder: '0 9 * * 1', help: 'Minute hour day month weekday', required: true },
    { name: 'timezone', label: 'Time zone', placeholder: 'Asia/Kolkata', help: 'Empty: the server\'s' }
  ],
  validate: function(trigger) {
    var cron = String(trigger.cron == null ? '' : trigger.cron).trim();
    if (!cron) throw invalid('A schedule needs `cron`, e.g. "0 9 * * 1" (Mondays at 9:00).');
    var opts = trigger.timezone ? { tz: String(trigger.timezone) } : undefined;
    try { parser.parseExpression(cron, opts); } catch (e) {
      throw invalid('"' + cron + '" is not a cron expression this can read: ' + e.message);
    }
    var out = common(trigger);
    out.cron = cron;
    if (trigger.timezone) out.timezone = String(trigger.timezone);
    return out;
  },
  due: function(trigger, from) {
    var opts = { currentDate: from };
    if (trigger.timezone) opts.tz = trigger.timezone;
    return parser.parseExpression(trigger.cron, opts).next().toDate();
  }
});

registerTrigger('job', {
  label: 'A job finishes',
  description: 'When a job finishes — successfully, with a failure, or either way.',
  fields: [
    { name: 'jobId', label: 'Job', placeholder: 'the job\'s id', required: true },
    { name: 'when', label: 'When it', options: [
      { value: 'success', label: 'succeeds' }, { value: 'failed', label: 'fails' }, { value: 'finished', label: 'finishes either way' }
    ] }
  ],
  validate: function(trigger) {
    var jobId = String(trigger.jobId == null ? '' : trigger.jobId).trim();
    if (!jobId) throw invalid('A job trigger needs `jobId`: the job whose finish starts this workflow.');
    if (!JOB_ID_PATTERN.test(jobId)) throw invalid('"' + jobId + '" is not a job id.');
    var when = trigger.when == null ? 'success' : String(trigger.when);
    if (JOB_WHEN.indexOf(when) === -1) {
      throw invalid('`when` must be one of ' + JOB_WHEN.join(', ') + ' — got "' + when + '".');
    }
    var out = common(trigger);
    out.jobId = jobId;
    out.when = when;
    return out;
  },
  matches: function(trigger, event) {
    if (!event || event.jobId !== trigger.jobId) return false;
    if (trigger.when === 'finished') return true;
    return event.status === trigger.when;
  }
});

/**
 * A workflow's trigger, checked and normalised. null/undefined stays null
 * ("started however it is called"). Throws a 400 naming the problem.
 */
function validate(trigger) {
  if (trigger === null || trigger === undefined) return null;
  if (typeof trigger !== 'object' || Array.isArray(trigger)) {
    throw invalid('`trigger` must be an object such as { "kind": "schedule", "cron": "0 9 * * 1" }.');
  }
  var def = KINDS[trigger.kind];
  if (!def) throw invalid('"' + trigger.kind + '" is not a kind of trigger. Kinds: ' + kinds().join(', ') + '.');
  return def.validate ? def.validate(trigger) : common(trigger);
}

function isOn(workflow) {
  return Boolean(workflow && workflow.status === 'published' && workflow.trigger &&
    workflow.trigger.enabled !== false && KINDS[workflow.trigger.kind]);
}

function mtOf(row) {
  return { mtId1: row.mtId1 || null, mtId2: row.mtId2 || null, mtId3: row.mtId3 || null, mtId4: row.mtId4 || null };
}

// ── the record of what each trigger did ─────────────────────────────────

async function stateOf(workflowId) {
  return db.model('WorkflowTriggerState').query().where({ workflowId: workflowId }).first();
}

async function writeState(workflow, patch) {
  var State = db.model('WorkflowTriggerState');
  var row = await stateOf(workflow.id);
  var values = Object.assign({ kind: workflow.trigger ? workflow.trigger.kind : null }, patch);
  if (row) return State.query().patchAndFetchById(row.id, values);
  return State.query().insert(Object.assign({ id: generateId(), workflowId: workflow.id }, values));
}

/**
 * Start a run because a trigger fired, inside the workflow's own tenant
 * context. A run that cannot start (a required parameter nobody supplies, no
 * steps) is recorded as a skip with the reason, never thrown at the caller —
 * a finished job must not fail because a workflow after it is broken.
 */
async function fire(workflow, triggerData) {
  var runner = require('./workflowRunner');
  return runWithMt(mtOf(workflow), async function() {
    try {
      var run = await runner.startRun(workflow.id, {}, { trigger: workflow.trigger.kind, triggerData: triggerData });
      await writeState(workflow, { lastFiredAt: new Date().toISOString(), lastRunId: run && run.id });
      return { fired: true, runId: run && run.id };
    } catch (err) {
      await writeState(workflow, { lastSkippedAt: new Date().toISOString(), lastSkipReason: err.message });
      return { fired: false, reason: err.message };
    }
  });
}

// ── event kinds: a job finished ─────────────────────────────────────────

// A chain of jobs longer than this is a loop nobody drew on purpose.
var MAX_DEPTH = 25;

/**
 * An event happened (today: a job finished). Every published, enabled
 * workflow whose trigger is of `kind` and matches it starts, in the caller's
 * tenant context — the event's own. Returns what each one did.
 */
async function emit(kind, event) {
  var def = KINDS[kind];
  if (!def || !def.matches) return [];
  var rows = await db.model('Workflow').query()
    .where({ status: 'published' })
    .whereRaw("\"trigger\"->>'kind' = ?", [kind]);
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var w = rows[i];
    if (!isOn(w) || !def.matches(w.trigger, event)) continue;
    var r = await fire(w, Object.assign({ kind: kind }, event));
    out.push(Object.assign({ workflowId: w.id }, r));
  }
  return out;
}

// ── time kinds: the schedule tick ───────────────────────────────────────

/**
 * One pass over every timed trigger, across every tenant (a tick is a timer:
 * there is no request and so no tenant — rows are picked unscoped and each
 * run is started in its own workflow's context, as @xeplr/jobs' scheduler
 * does).
 *
 * A trigger seen for the first time, or whose settings changed, is given its
 * next due time and does not fire — so publishing a workflow never starts a
 * run for a time that has already passed. A due one is CLAIMED by moving its
 * due time forward with a conditional update; only the process whose update
 * landed fires it, so two processes running the tick start it once.
 *
 * `now` is for tests; production passes nothing.
 */
async function tick(now) {
  now = now || new Date();
  var timed = kinds().filter(function(k) { return KINDS[k].due; });
  if (!timed.length) return [];
  var Workflow = db.model('Workflow');
  var State = db.model('WorkflowTriggerState');
  var rows = await Workflow.unscopedQuery()
    .where({ status: 'published', isActive: true })
    .whereRaw("\"trigger\"->>'kind' in (" + timed.map(function() { return '?'; }).join(',') + ')', timed);
  var fired = [];
  for (var i = 0; i < rows.length; i++) {
    var w = rows[i];
    if (!isOn(w)) continue;
    var def = KINDS[w.trigger.kind];
    var settings = JSON.stringify(w.trigger);
    await runWithMt(mtOf(w), async function() {
      var state = await stateOf(w.id);
      if (!state || !state.nextDueAt || state.settings !== settings) {
        await writeState(w, { settings: settings, nextDueAt: def.due(w.trigger, now).toISOString() });
        return;
      }
      var dueAt = new Date(state.nextDueAt);
      if (dueAt > now) return;
      var next = def.due(w.trigger, now).toISOString();
      var claimed = await State.query()
        .where({ id: state.id, nextDueAt: state.nextDueAt })
        .patch({ nextDueAt: next });
      if (!claimed) return;
      var r = await fire(w, { kind: w.trigger.kind, dueAt: dueAt.toISOString(), firedAt: now.toISOString() });
      fired.push(Object.assign({ workflowId: w.id }, r));
    });
  }
  return fired;
}

var _timer = null;

/** Run the tick every `intervalMs` (default 30 s). The timer does not keep the process alive. */
function startTicking(intervalMs) {
  stopTicking();
  var every = intervalMs || 30000;
  var running = false;
  _timer = setInterval(function() {
    if (running) return;
    running = true;
    tick().catch(function(err) {
      console.error('[workflow] trigger tick failed — no scheduled workflow is starting: ' + err.message);
    }).finally(function() { running = false; });
  }, every);
  if (_timer.unref) _timer.unref();
}

function stopTicking() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

/** What a workflow's trigger is and what it last did — for a screen. */
async function describe(workflow) {
  var state = workflow ? await stateOf(workflow.id) : null;
  return {
    trigger: (workflow && workflow.trigger) || null,
    on: isOn(workflow),
    lastFiredAt: (state && state.lastFiredAt) || null,
    lastRunId: (state && state.lastRunId) || null,
    lastSkippedAt: (state && state.lastSkippedAt) || null,
    lastSkipReason: (state && state.lastSkipReason) || null,
    nextDueAt: (state && isOn(workflow) && state.nextDueAt) || null
  };
}

module.exports = {
  registerTrigger: registerTrigger,
  kinds: kinds,
  catalog: catalog,
  validate: validate,
  isOn: isOn,
  fire: fire,
  emit: emit,
  tick: tick,
  startTicking: startTicking,
  stopTicking: stopTicking,
  describe: describe,
  MAX_DEPTH: MAX_DEPTH,
  JOB_WHEN: JOB_WHEN
};

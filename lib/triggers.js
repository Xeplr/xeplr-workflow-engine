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
var { resolveAll } = require('@xeplr/schema-handler');
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
  // WHAT THE RUN IS GIVEN, for a workflow that asks for inputs: each value a
  // template over what fired it, e.g. { month: "{trigger.window.from|date:YYYY-MM}" }.
  // Without it a run started by a trigger had no inputs, and a workflow with a
  // required one was refused every time it fired.
  if (trigger.params !== undefined && trigger.params !== null) {
    if (typeof trigger.params !== 'object' || Array.isArray(trigger.params)) {
      throw invalid('`params` gives the run its inputs: an object such as { "month": "{trigger.window.from|date:YYYY-MM}" }.');
    }
    out.params = trigger.params;
  }
  return out;
}

// THE PERIOD A SCHEDULED RUN IS FOR, as a window: from (included) and to (not
// included), the shape a job hands on. Worked out in the trigger's time zone,
// because "last month" begins at midnight where the business is, not in UTC.
var PERIODS = ['previous-day', 'previous-month', 'previous-quarter', 'previous-year', 'current-month'];

/** The calendar parts of an instant in `zone` (or the server's own). */
function partsIn(date, zone) {
  if (!zone) return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
  var p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(date).forEach(function(x) { p[x.type] = x.value; });
  return { y: +p.year, m: +p.month, d: +p.day };
}

/** Midnight at the start of y-m-d in `zone`, as an instant. */
function midnight(y, m, d, zone) {
  var guess = Date.UTC(y, m - 1, d);
  if (!zone) return new Date(y, m - 1, d);
  // The zone's offset at that moment: what UTC time reads as 00:00 there.
  var at = new Date(guess);
  var p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(at).forEach(function(x) { p[x.type] = x.value; });
  var shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess - (shown - guess));
}

/** { from, to } for `period`, around the instant `at`. */
function windowFor(period, at, zone) {
  var t = partsIn(at, zone);
  var from, to;
  if (period === 'previous-day') { from = [t.y, t.m, t.d - 1]; to = [t.y, t.m, t.d]; }
  else if (period === 'previous-month') { from = [t.y, t.m - 1, 1]; to = [t.y, t.m, 1]; }
  else if (period === 'current-month') { from = [t.y, t.m, 1]; to = [t.y, t.m + 1, 1]; }
  else if (period === 'previous-quarter') { var q = Math.floor((t.m - 1) / 3) * 3 + 1; from = [t.y, q - 3, 1]; to = [t.y, q, 1]; }
  else if (period === 'previous-year') { from = [t.y - 1, 1, 1]; to = [t.y, 1, 1]; }
  else return null;
  // Normalise month/day overflow (month 0, day 0) through a plain date.
  function norm(a) { var x = new Date(Date.UTC(a[0], a[1] - 1, a[2])); return [x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()]; }
  var f = norm(from); var e = norm(to);
  return { from: midnight(f[0], f[1], f[2], zone).toISOString(), to: midnight(e[0], e[1], e[2], zone).toISOString() };
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
    { name: 'timezone', label: 'Time zone', placeholder: 'Asia/Kolkata', help: 'Empty: the server\'s' },
    { name: 'period', label: 'For the period', options: [
      { value: '', label: 'no period' },
      { value: 'previous-day', label: 'the day before' }, { value: 'previous-month', label: 'the month before' },
      { value: 'previous-quarter', label: 'the quarter before' }, { value: 'previous-year', label: 'the year before' },
      { value: 'current-month', label: 'this month' }
    ], help: 'Steps read it as {trigger.window.from} and {trigger.window.to}' }
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
    if (trigger.period) {
      if (PERIODS.indexOf(trigger.period) === -1) throw invalid('`period` is one of ' + PERIODS.join(', ') + ', not "' + trigger.period + '".');
      out.period = trigger.period;
    }
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
      // The run's inputs from the trigger's `params`, each a template over
      // what fired it ({trigger.window.from|date:YYYY-MM}).
      var params = workflow.trigger.params
        ? resolveAll(workflow.trigger.params, { trigger: triggerData })
        : {};
      var run = await runner.startRun(workflow.id, params, { trigger: workflow.trigger.kind, triggerData: triggerData });
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
      var data = { kind: w.trigger.kind, dueAt: dueAt.toISOString(), firedAt: now.toISOString() };
      if (w.trigger.period) data.window = windowFor(w.trigger.period, dueAt, w.trigger.timezone);
      var r = await fire(w, data);
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
  JOB_WHEN: JOB_WHEN,
  PERIODS: PERIODS,
  windowFor: windowFor
};

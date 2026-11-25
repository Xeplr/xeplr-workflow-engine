// THE CLOCK IS @xeplr/jobs — the engine keeps no timer of its own.
//
// Two kinds of timed work, both run by the jobs scheduler:
//
//   1. A WORKFLOW "ON A SCHEDULE" IS A JOB. Saving the workflow keeps a job
//      (id = the workflow's id) whose action, `workflow-scheduled`, starts it.
//      The schedule is then on the Jobs screen like any other, and pausing it
//      there pauses the workflow. Unpublishing, switching the trigger off,
//      changing it to another kind or deleting the workflow removes the job.
//      The period the run is for ({trigger.window}) is worked out from the
//      slot the job was due at, in the trigger's time zone, as before.
//
//   2. THE ENGINE'S DUE WORK IS ONE SYSTEM JOB, every minute: `workflow-due`
//      runs sweep() (lib/recovery.js) — runs whose process died, Wait boxes
//      past their time, reminders and escalations, file and email watches.
//      Each piece is claimed in the database, so two processes running it at
//      once do each thing once. It belongs to every company and nobody can
//      change it from the screen (@xeplr/jobs migrations/0012).
//
// The host hands over how to keep a job (startEngine's keepSchedule, i.e.
// @xeplr/jobs' keepSchedule) and registers the two actions with its jobs
// (jobActions). Without a keeper a schedule cannot be saved (lib/triggers.js).
var { runWithMt } = require('@xeplr/db');
var db = require('./db');
var jobs = require('./jobs');

var SCHEDULED_ACTION = 'workflow-scheduled';
var DUE_ACTION = 'workflow-due';

/** The system job of the engine's due work, as keepSchedule takes it. */
var DUE_JOB = {
  id: 'workflow-due',
  name: 'Workflows: due work',
  description: 'Every minute: Wait boxes that run out of time, reminders and escalations on tasks, ' +
    'files and emails a workflow waits for, and runs that stopped halfway. A system job — it cannot be changed.',
  actionName: DUE_ACTION,
  inputs: {},
  cron: '* * * * *'
};

function mtOf(row) {
  return { mtId1: row.mtId1 || null, mtId2: row.mtId2 || null, mtId3: row.mtId3 || null, mtId4: row.mtId4 || null };
}

/** The job a workflow should have, or null for none. Pure — exported to test. */
function specFor(workflow) {
  var triggers = require('./triggers');
  if (!workflow || workflow.isActive === false || !triggers.isOn(workflow) || workflow.trigger.kind !== 'schedule') return null;
  var t = workflow.trigger;
  return {
    name: 'Workflow: ' + workflow.name,
    description: 'Starts the workflow "' + workflow.name + '" on its schedule. Change the schedule in the workflow; pausing it here pauses the workflow.',
    actionName: SCHEDULED_ACTION,
    inputs: { workflowId: workflow.id },
    cron: t.cron,
    timezone: t.timezone || null
  };
}

/**
 * Bring a workflow's job in line with what it is now — created, changed or
 * removed. Read fresh (deleted rows included, so a delete removes the job), in
 * the workflow's own tenant. A failure is recorded on the trigger's state, so
 * "why does this not run" is a row, and thrown for the caller's log.
 */
async function sync(workflowId) {
  var keep = jobs.scheduleKeeper();
  if (!keep || !workflowId) return null;
  var row = await db.model('Workflow').knex()('workflows').where({ id: workflowId }).first();
  // Removed outright: its job goes too, in the caller's own company (whoever
  // deleted it could see it).
  if (!row) return keep(workflowId, null);
  if (typeof row.trigger === 'string') row.trigger = JSON.parse(row.trigger);
  var spec = specFor(row);
  return runWithMt(mtOf(row), async function() {
    try {
      return await keep(workflowId, spec);
    } catch (err) {
      try {
        var State = db.model('WorkflowTriggerState');
        var state = await State.query().where({ workflowId: workflowId }).first();
        var values = { lastSkippedAt: new Date().toISOString(), lastSkipReason: 'Its schedule could not be kept in Jobs: ' + err.message };
        if (state) await State.query().findById(state.id).patch(values);
        else await State.query().insert(Object.assign({ id: require('@xeplr/utils/lib/helpers').generateId(), workflowId: workflowId, kind: row.trigger && row.trigger.kind }, values));
      } catch (_) { /* the log line below still says it */ }
      throw err;
    }
  });
}

/**
 * Called by the Workflow model after a write, with the ids it touched. A write
 * inside the generic save waits for its commit (queryContext.afterCommit): the
 * job is in another database, and keeping it for a save that then rolled back
 * would leave a job for a schedule that was never saved.
 */
function syncLater(ids, context, trx) {
  ids = Array.from(new Set((ids || []).filter(Boolean)));
  if (!ids.length || !jobs.scheduleKeeper()) return Promise.resolve();
  function run() {
    return ids.reduce(function(p, id) {
      return p.then(function() {
        return sync(id).catch(function(err) {
          console.error('[workflow] the schedule of workflow ' + id + ' was not kept in Jobs: ' + err.message);
        });
      });
    }, Promise.resolve());
  }
  if (context && Array.isArray(context.afterCommit)) { context.afterCommit.push(run); return Promise.resolve(); }
  if (trx && trx.isTransaction && trx.executionPromise) { trx.executionPromise.then(run, function() {}); return Promise.resolve(); }
  return run();
}

/** Make sure the engine's due-work job exists. Called by startEngine when a keeper is given. */
function keepDueJob() {
  var keep = jobs.scheduleKeeper();
  if (!keep) return Promise.resolve(null);
  return keep(DUE_JOB.id, DUE_JOB, { system: true });
}

function count(list) { return Array.isArray(list) ? list.length : 0; }

/**
 * The two actions a host registers with its jobs. Both run inside the job's
 * tenant context, which @xeplr/jobs sets.
 */
var scheduledAction = {
  name: SCHEDULED_ACTION,
  description: 'Starts a workflow — what a workflow "On a schedule" is run by. Kept by the workflow itself; change its schedule there.',
  inputSchema: [{ name: 'workflowId', type: 'string', required: true, description: 'The workflow to start' }],
  execute: async function(ctx) {
    var triggers = require('./triggers');
    var input = (ctx && ctx.input) || {};
    var system = (ctx && ctx.system) || {};
    var w = await db.model('Workflow').query().findById(input.workflowId);
    if (!w) throw new Error('Workflow ' + input.workflowId + ' is gone, so nothing was started. This job can be deleted.');
    if (!triggers.isOn(w) || w.trigger.kind !== 'schedule') {
      throw new Error('"' + w.name + '" is not published with a schedule switched on, so it was not started.');
    }
    // The SLOT the job was due at, not the moment it was picked: a run picked
    // late is still the 09:00 run, and its period is the same either way.
    var dueAt = new Date(system.dueAt || system.startedAt || Date.now());
    var data = { kind: 'schedule', dueAt: dueAt.toISOString(), firedAt: new Date().toISOString() };
    if (w.trigger.period) data.window = triggers.windowFor(w.trigger.period, dueAt, w.trigger.timezone);
    var r = await triggers.fire(w, data);
    if (!r.fired) throw new Error('"' + w.name + '" did not start: ' + r.reason);
    return { workflowId: w.id, runId: r.runId, window: data.window || null };
  }
};

var dueAction = {
  name: DUE_ACTION,
  description: 'The workflows\' due work: Wait boxes that run out of time, reminders and escalations, files and emails waited for, runs that stopped halfway.',
  inputSchema: [],
  // COUNTS ONLY. This job's runs are listed to every company, so what it
  // returns must not name another company's runs or tasks.
  execute: async function() {
    var done = await require('./recovery').sweep();
    return {
      recovered: count(done.recovered),
      timedOut: count(done.expired),
      pastDue: count(done.due),
      reminded: count(done.nudged),
      woken: count(done.woken),
      watched: count(done.watched)
    };
  }
};

module.exports = {
  DUE_JOB: DUE_JOB,
  SCHEDULED_ACTION: SCHEDULED_ACTION,
  DUE_ACTION: DUE_ACTION,
  specFor: specFor,
  sync: sync,
  syncLater: syncLater,
  keepDueJob: keepDueJob,
  jobActions: [scheduledAction, dueAction]
};

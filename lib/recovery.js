// THE DUE WORK — what finds runs nobody is moving any more, and everything
// else that falls due with time passing.
//
// NO TIMER HERE. sweep() is run by the jobs scheduler, once a minute, as the
// system job `workflow-due` (lib/schedules.js) — the one clock of the install.
// A test, or an admin, can call it any time. What it does:
//
//   1. A run still 'running' whose lease has passed. The process moving it
//      died. The sweeper takes the lease (an atomic conditional patch, so two
//      processes sweeping at once never both take it) and hands the run to
//      workflowRunner.recoverRun, which decides from what the run last
//      recorded whether to go on, run a step again, or stop for a person.
//
//   2. A wait whose key has expired (workflow_steps.timeoutMs). It is
//      resolved as failed through the same resumeByKey every answer goes
//      through, so the step's onError decides what happens: stop the run
//      (the default) or go on, with output.timedOut = true for a later step
//      to read.
//
//   3. A task past its dueAt: the host is told once (onTask 'due'), and one
//      with escalateTo moves to that role (lib/tasks.js sweepDue). Superseded
//      by reminders & escalation:
//
//   3b. A task whose reminder or escalation is due (its `nudges`, set from the
//      step's `reminders` when it opened): the host is told (onTask
//      'reminder' / 'escalated') and an escalation moves or shares the task
//      (lib/tasks.js sweepNudges). Each claimed once across processes.
//
//   4. A Wait step due to wake — its time or date reached, something it
//      waits for arrived, or it took too long (lib/waits.js). So waiting on
//      time adds no timer of its own.
//
//   5. A watch trigger due to look — "a file arrives", "an email arrives"
//      (lib/triggers.js checkWatches).
//
// Runs from before leases existed have none, and are left alone.
//
// Several processes may sweep the same database: every piece is claimed with
// a conditional update, so each is done once.

var { runWithMt } = require('@xeplr/db');
var db = require('./db');
var runner = require('./workflowRunner');

var BATCH = 50;
var sweeping = false;

async function recoverStale(now) {
  var stale = await db.model('WorkflowRun').unscopedQuery()
    .where({ status: 'running' }).whereNotNull('lockedUntil').where('lockedUntil', '<', now).limit(BATCH);
  var out = [];
  for (var i = 0; i < stale.length; i++) {
    var run = stale[i];
    var taken = await db.model('WorkflowRun').unscopedQuery().findById(run.id)
      .where({ status: 'running' }).where('lockedUntil', '<', now)
      .patch({ lockedUntil: runner.leaseUntil() });
    if (!taken) continue;
    try {
      out.push({ runId: run.id, outcome: await runner.recoverRun(run) });
    } catch (err) {
      console.error('[workflow] could not recover run ' + run.id + ':', err.message);
      out.push({ runId: run.id, outcome: 'error', error: err.message });
    }
  }
  return out;
}

async function expireWaits(now) {
  var keys = await db.model('WorkflowResumeKey').unscopedQuery()
    .whereNull('consumedDate').whereNotNull('expiresAt').where('expiresAt', '<', now).limit(BATCH);
  var out = [];
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    try {
      await runWithMt(runner.mtOf(key), function() {
        return runner.resumeByKey(key.key, { timedOut: true }, {
          status: 'failed',
          error: { code: 'TIMED_OUT', message: 'No answer arrived before the wait expired.' }
        });
      });
      out.push({ runId: key.runId, outcome: 'timedOut' });
    } catch (err) {
      // Answered a moment ago, or still parking: either way, not ours to fail.
      if (err.code === 'RESUME_KEY_INVALID' || err.code === 'RESUME_KEY_NOT_READY') continue;
      console.error('[workflow] could not expire the wait on run ' + key.runId + ':', err.message);
      out.push({ runId: key.runId, outcome: 'error', error: err.message });
    }
  }
  return out;
}

/**
 * One pass of everything due. Run by the system job `workflow-due` every
 * minute; exported so a test, or an admin route, can do it now. A pass already
 * going in this process is not started twice: the second call answers empty.
 */
async function sweep() {
  if (sweeping) return { recovered: [], expired: [], due: [], nudged: [], woken: [], watched: [] };
  sweeping = true;
  try {
    var now = new Date().toISOString();
    return { recovered: await recoverStale(now), expired: await expireWaits(now), due: await require('./tasks').sweepDue(),
      nudged: await require('./tasks').sweepNudges(new Date(now)),
      woken: await require('./waits').wakeDue(new Date(now)),
      watched: await require('./triggers').checkWatches(new Date(now)) };
  } finally {
    sweeping = false;
  }
}

module.exports = { sweep: sweep };

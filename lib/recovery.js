// THE SWEEPER — what finds runs nobody is moving any more.
//
// Three kinds, every intervalMs (default 30 s):
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
//      with escalateTo moves to that role (lib/tasks.js sweepDue).
//
// Runs from before leases existed have none, and are left alone.
//
// Several processes may sweep the same database. The timer never keeps a
// process alive.

var { runWithMt } = require('@xeplr/db');
var db = require('./db');
var runner = require('./workflowRunner');

var BATCH = 50;
var timer = null;
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

/** One pass. Exported so a test, or an admin route, can sweep now rather than wait. */
async function sweep() {
  if (sweeping) return { recovered: [], expired: [] };
  sweeping = true;
  try {
    var now = new Date().toISOString();
    return { recovered: await recoverStale(now), expired: await expireWaits(now), due: await require('./tasks').sweepDue() };
  } finally {
    sweeping = false;
  }
}

function startSweeping(intervalMs) {
  if (timer) return;
  timer = setInterval(function() {
    sweep().catch(function(err) { console.error('[workflow] sweep failed:', err.message); });
  }, intervalMs || 30000);
  timer.unref();
}

function stopSweeping() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { sweep: sweep, startSweeping: startSweeping, stopSweeping: stopSweeping };

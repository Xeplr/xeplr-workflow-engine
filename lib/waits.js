// WAKING WAITS — the other half of a Wait step (lib/actions/wait.js).
//
// A Wait step writes on its resume key when to wake (wakeAt, with the output
// to wake with) and, for a file or an email, what to check (watch, nextCheckAt).
// wakeDue() does both, for every tenant:
//
//   1. A key past its wakeAt is answered with its wakeOutput — the time or the
//      date was reached ({ waited: true }), or what was waited for took too
//      long ({ tooLong: true }) and the step's "Took too long" arrow is taken.
//   2. A key whose check is due is CLAIMED by moving nextCheckAt forward with a
//      conditional update — only the process whose update landed checks — and
//      its action is run (file-list, email-read). Found something: the key is
//      answered with what arrived ({ arrived: true, files | messages }), so
//      THIS run goes on with it. Nothing: it waits for the next check.
//
// Every answer goes through runner.resumeByKey, which spends the key in one
// transaction, so a wait is woken once however many processes sweep — and an
// arrival and its "too long" in the same pass cannot both win.
//
// NO TIMER OF ITS OWN. wakeDue() runs inside the engine's sweep
// (lib/recovery.js), which the jobs scheduler runs every minute as the system
// job `workflow-due` (lib/schedules.js).
var { runWithMt } = require('@xeplr/db');
var db = require('./db');
var runner = require('./workflowRunner');
var actionCatalog = require('./actionCatalog');

var BATCH = 50;

function settled(err) {
  // Answered a moment ago, or still parking: either way not ours to wake.
  return err && (err.code === 'RESUME_KEY_INVALID' || err.code === 'RESUME_KEY_NOT_READY');
}

async function wakeTimed(now) {
  var keys = await db.model('WorkflowResumeKey').unscopedQuery()
    .whereNull('consumedDate').whereNotNull('wakeAt').where('wakeAt', '<=', now).limit(BATCH);
  var out = [];
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    try {
      await runWithMt(runner.mtOf(key), function() {
        return runner.resumeByKey(key.key, Object.assign({ wokeAt: new Date().toISOString() }, key.wakeOutput || { waited: true }));
      });
      out.push({ runId: key.runId, outcome: (key.wakeOutput && key.wakeOutput.tooLong) ? 'tooLong' : 'woke' });
    } catch (err) {
      if (settled(err)) continue;
      console.error('[workflow] could not wake the wait on run ' + key.runId + ':', err.message);
      out.push({ runId: key.runId, outcome: 'error', error: err.message });
    }
  }
  return out;
}

/** What arrived, as the step hands it on: the files, or the messages. */
function arrivalOf(watch, output) {
  output = output || {};
  if (watch.actionName === 'file-list') return { files: output.files || [], count: output.count || 0 };
  if (watch.actionName === 'email-read') return { messages: output.messages || [], count: output.messageCount || 0 };
  return output;
}

async function checkArrivals(now) {
  var Key = db.model('WorkflowResumeKey');
  var keys = await Key.unscopedQuery()
    .whereNull('consumedDate').whereNotNull('watch').whereNotNull('nextCheckAt').where('nextCheckAt', '<=', now).limit(BATCH);
  var out = [];
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var watch = key.watch || {};
    var next = new Date(Date.parse(now) + (watch.everyMs || 300000)).toISOString();
    // Claimed: two processes sweeping at once check it once.
    var claimed = await Key.unscopedQuery().findById(key.id)
      .whereNull('consumedDate').where('nextCheckAt', key.nextCheckAt).patch({ nextCheckAt: next });
    if (!claimed) continue;
    try {
      await runWithMt(runner.mtOf(key), async function() {
        var result = await runner.runCheck(watch.actionName, watch.input, 'Wait for ' + (watch.actionName === 'email-read' ? 'an email' : 'a file'));
        if (result.status !== 'success') {
          // Kept waiting: a mailbox that is down now may answer at the next check.
          out.push({ runId: key.runId, outcome: 'checkFailed', error: (result.error && result.error.message) || 'The check failed' });
          return;
        }
        if (!actionCatalog.isFound(watch.actionName, result.output)) { out.push({ runId: key.runId, outcome: 'nothingYet' }); return; }
        await runner.resumeByKey(key.key, Object.assign({ arrived: true, tooLong: false, waited: false, arrivedAt: new Date().toISOString() },
          arrivalOf(watch, result.output)));
        out.push({ runId: key.runId, outcome: 'arrived' });
      });
    } catch (err) {
      if (settled(err)) continue;
      console.error('[workflow] could not check the wait on run ' + key.runId + ':', err.message);
      out.push({ runId: key.runId, outcome: 'error', error: err.message });
    }
  }
  return out;
}

/** One pass: arrivals first, so something that arrived in time is not called late. */
async function wakeDue(now) {
  now = (now instanceof Date ? now : new Date()).toISOString();
  var arrived = await checkArrivals(now);
  var woke = await wakeTimed(now);
  return arrived.concat(woke);
}

module.exports = { wakeDue: wakeDue, arrivalOf: arrivalOf };

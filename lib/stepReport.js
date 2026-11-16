// WHAT A RUNNING STEP SAYS, AND HOW IT IS STOPPED.
//
// Every action a step runs is handed, in `system`:
//
//   onProgress(numbers)   the newest numbers — { rowsRead, rowsWritten,
//                         percent, … }. A gauge, not a log: each call replaces
//                         the last.
//   log(message, meta)    a line for the person watching ("Reading orders.csv
//                         (3.0 GB) into orders"). Kept, oldest first, the
//                         newest LOG_LINES.
//   signal                an AbortSignal: aborted when the case is cancelled,
//                         so the action stops its own work (a load stops
//                         between batches) instead of running on to the end.
//
// Both are saved on the step run (workflow_step_runs.progress / .log), at
// most every WRITE_MS — an action may report every batch, thousands of times,
// and writing each would cost more than the work. COALESCED, not queued: only
// the newest numbers are written. No timer: the next report triggers the next
// write, and finish() writes whatever is left, so nothing is left running.
//
// A CANCEL FROM ANYWHERE. cancelRun aborts the signal at once when the step
// runs in this process; and each write reads the run's status, so a cancel
// made in another process (another worker, the API while the step runs in the
// jobs process) stops the step within WRITE_MS of its next report.
//
// Never throws into the action: reporting must not fail the work it reports on.
var db = require('./db');

var WRITE_MS = 2000;
var LOG_LINES = 300;

// The steps running in this process, by run: cancelRun aborts them at once.
var running = new Map();

function open(runId, stepRunId) {
  var controller = new AbortController();
  var pending = null;            // the newest numbers not yet written
  var lines = [];                // the log so far (the newest LOG_LINES)
  var linesDirty = false;
  var lastWrite = 0;
  var inFlight = null;

  if (!running.has(runId)) running.set(runId, new Set());
  running.get(runId).add(controller);

  function write(force) {
    if (inFlight) return inFlight;
    var now = Date.now();
    if (!force && now - lastWrite < WRITE_MS) return null;
    if (!pending && !linesDirty) return null;
    lastWrite = now;
    var patch = {};
    if (pending) { patch.progress = pending; pending = null; }
    if (linesDirty) { patch.log = lines.slice(); linesDirty = false; }
    inFlight = db.model('WorkflowStepRun').query().findById(stepRunId).patch(patch)
      .then(function() {
        // A cancel made elsewhere: the run is no longer going.
        return db.model('WorkflowRun').query().findById(runId).select('status');
      })
      .then(function(run) {
        if (run && run.status !== 'running' && !controller.signal.aborted) controller.abort(cancelled());
      })
      .catch(function() { /* reporting must never fail the step */ })
      .then(function() { inFlight = null; });
    return inFlight;
  }

  return {
    signal: controller.signal,
    onProgress: function(numbers) {
      if (!numbers || typeof numbers !== 'object') return;
      pending = Object.assign({}, numbers, { at: new Date().toISOString() });
      write(false);
    },
    log: function(message, meta) {
      var line = { at: new Date().toISOString(), level: (meta && meta.level) || 'info', message: String(message).slice(0, 1000) };
      lines.push(line);
      if (lines.length > LOG_LINES) lines = lines.slice(lines.length - LOG_LINES);
      linesDirty = true;
      write(false);
    },
    /** The step is over: whatever is pending is written, and the step leaves the running list. */
    finish: async function() {
      var set = running.get(runId);
      if (set) { set.delete(controller); if (!set.size) running.delete(runId); }
      if (inFlight) await inFlight;
      await write(true);
    }
  };
}

function cancelled() {
  return Object.assign(new Error('The case was cancelled.'), { code: 'STOPPED' });
}

/** Stops every step of this run running in this process (cancelRun). */
function abortRun(runId) {
  var set = running.get(runId);
  if (!set) return 0;
  set.forEach(function(c) { if (!c.signal.aborted) c.abort(cancelled()); });
  return set.size;
}

module.exports = { open: open, abortRun: abortRun, WRITE_MS: WRITE_MS, LOG_LINES: LOG_LINES };

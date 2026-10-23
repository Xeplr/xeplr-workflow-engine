// JOBS AND WORKFLOWS — the two places they meet, and nothing more.
//
//   a job as a STEP     the job-run step starts a job and parks until it ends
//   a job as a TRIGGER  a workflow whose trigger is { kind: 'job', jobId }
//                       starts when that job finishes (lib/triggers.js)
//
// Both are ordinary workflows. The host tells this module two things, because
// only the host knows both products are present: how to start a job
// (setJobStarter — @xeplr/jobs' trigger()) and that a job has finished
// (jobFinished — @xeplr/jobs' onFinish hook). This module never imports jobs.
var triggers = require('./triggers');

// Supplied by the host: async (jobId, { inputs, chain, callbackUrl }) →
// { occurrenceId }. With @xeplr/jobs in the same process that is
// `jobs.trigger`. Unset, a job-run step falls back to the jobs API over HTTP.
var _startJob = null;

function setJobStarter(fn) {
  _startJob = typeof fn === 'function' ? fn : null;
}

function jobStarter() { return _startJob; }

function pause(ms) {
  return new Promise(function(resolve) { var t = setTimeout(resolve, ms); if (t.unref) t.unref(); });
}

/**
 * Resume the job-run step that started this job.
 *
 * A job can finish before the step that started it has parked — the start is
 * fire-and-forget, and a quick job ends in milliseconds — and the engine
 * answers that with RESUME_KEY_NOT_READY rather than routing a step that is
 * still running. So it is tried again for a few seconds, as @xeplr/jobs' HTTP
 * callback retries. A key already used (that callback got there first) is a
 * settled answer.
 */
async function resumeStep(key, output, opts) {
  var runner = require('./workflowRunner');
  for (var attempt = 0; attempt < 20; attempt++) {
    try {
      await runner.resumeByKey(key, output, opts);
      return true;
    } catch (err) {
      if (err.code === 'RESUME_KEY_INVALID') return false;
      if (err.code !== 'RESUME_KEY_NOT_READY') throw err;
      await pause(250);
    }
  }
  throw new Error('The step waiting on this job never parked, so it could not be told the job finished.');
}

/**
 * What a finished job hands a workflow it triggers, as {trigger.*}:
 *
 *   jobId     the job that finished
 *   status    'success' | 'failed'
 *   error     its error, when it failed
 *   output    what its action returned
 *   window    the period it ran for: the range it was given, or — given
 *             none — the range its action reports it covered
 *   given / used  those two ranges separately (@xeplr/jobs' previous.*)
 *   carry     values carried along from the jobs before it
 *   path      the jobs that led here, oldest first — for loop protection
 *
 * Pure — exported to test.
 */
function eventOf(report) {
  report = report || {};
  var out = report.output || {};
  var chain = out.chain || {};
  var path = Array.isArray(chain.path) ? chain.path.slice() : [];
  if (out.jobId) path.push(out.jobId);
  return {
    jobId: out.jobId || null,
    status: report.status === 'success' ? 'success' : 'failed',
    error: report.error || null,
    output: out.output || null,
    window: out.window || (out.output && out.output.window) || null,
    given: out.window || null,
    used: (out.output && out.output.window) || null,
    carry: chain.carry && typeof chain.carry === 'object' ? chain.carry : {},
    path: path
  };
}

/**
 * Called by the host for EVERY job run that ends (@xeplr/jobs' onFinish), in
 * that job's tenant context, with the jobs envelope { status, error, output }.
 *
 * Two things, independently: if a job-run step started this job, resume it;
 * and start every workflow whose trigger is this job finishing.
 */
async function jobFinished(report) {
  report = report || {};
  var out = report.output || {};
  var chain = out.chain || {};
  var result = { resumed: false, started: [] };

  if (chain.resumeKey) {
    result.resumed = await resumeStep(chain.resumeKey, out,
      report.status === 'success' ? {} : { status: 'failed', error: report.error });
  }

  if (!out.jobId) return result;
  result.started = await triggers.emit('job', eventOf(report));
  return result;
}

/**
 * What a job-run step hands the job it starts, when its run was itself
 * started by a job: the period flows on unless the step sets one, the carried
 * values and the path travel with it, and both of the previous job's ranges
 * are offered (@xeplr/jobs' previous.given / previous.used). A job already on
 * the path, or a path at MAX_DEPTH, is refused — that is a loop.
 *
 * Pure — exported to test.
 */
function nextJobCall(trigger, jobId, inputs, carry) {
  var t = trigger && trigger.kind === 'job' ? trigger : null;
  var path = t && Array.isArray(t.path) ? t.path : [];
  if (path.indexOf(jobId) > -1) {
    throw new Error('Job ' + jobId + ' has already run in this chain (' + path.concat(jobId).join(' → ') +
      '), so running it again would loop. Change the workflows so the chain ends.');
  }
  if (path.length >= triggers.MAX_DEPTH) {
    throw new Error('This chain has run ' + path.length + ' jobs in a row, which is the most allowed. Check the workflows for a loop.');
  }
  var given = inputs && typeof inputs === 'object' && !Array.isArray(inputs) ? Object.assign({}, inputs) : {};
  if (t && t.window && given.window === undefined) given = Object.assign({ window: t.window }, given);
  var carried = Object.assign({}, (t && t.carry) || {}, carry && typeof carry === 'object' ? carry : {});
  return {
    inputs: given,
    chain: { carry: carried, path: path, previous: { given: (t && t.given) || null, used: (t && t.used) || null } }
  };
}

module.exports = {
  setJobStarter: setJobStarter,
  jobStarter: jobStarter,
  jobFinished: jobFinished,
  eventOf: eventOf,
  nextJobCall: nextJobCall
};

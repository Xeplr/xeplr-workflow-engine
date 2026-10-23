// job-run — START A JOB AND PARK UNTIL IT REPORTS BACK.
//
// The step behind an arrow on the "connect jobs" canvas. Everything it does is
// two HTTP calls' worth of glue between two products that do not import each
// other:
//
//   1. POST <jobsUrl>/jobs/<jobId>/trigger  { inputs, callbackUrl }
//   2. return — the STEP does not finish here. It is a `wait` step, so the run
//      parks, and @xeplr/jobs POSTs the outcome to callbackUrl when the
//      occurrence reaches a terminal state, which resumes it.
//
// ── why it does not wait for the job ─────────────────────────────────────
//
// A movement runs for twenty minutes. Holding an await open across that would
// tie a run's progress to one process staying alive, and a deploy in the
// middle would lose it with nothing recording why. The resume key is a row in
// a table: it survives a restart, and it is the same mechanism an emailed
// approval link has always used.
//
// ── THIS IS TEMPORARY, AND SHOULD BE DELETED ─────────────────────────────
//
// Nothing here is about jobs except the URL shape and the field named
// `callbackUrl`. The general form is @xeplr/actions' `http-request` (today a
// placeholder) called from a wait step with `{resumeUrl}` bound into its body,
// which would serve jobs, saved API calls and anything else that can honour
// the callback contract. This exists so the jobs canvas can be finished
// first; when http-request lands, a job step becomes a configuration of it and
// this file goes away.
//
// It lives in xeplr-workflow rather than in @xeplr/actions deliberately: it is
// glue between two products, and putting it in the shared action library would
// teach that library what a job is.

var CALLBACK_UNREACHABLE =
  'This step starts a job and waits for it to report back, but WORKFLOW_PUBLIC_URL ' +
  'is not set, so there is no address to give the job to call. Set it to the base ' +
  'URL this service is reachable on (including any mount path — e.g. ' +
  'https://bi.example.com/workflow) and run this again.';

module.exports = {
  name: 'job-run',
  description: 'Run a saved job and wait for it to finish. The job reports its outcome back, ' +
               'so the next step runs only once it has actually completed.',
  requires: [],

  inputSchema: [
    { name: 'jobsUrl', type: 'string', order: 1,
      description: 'Base URL of the jobs API — e.g. https://bi.example.com/api. Not needed when ' +
                   'the host connected jobs in-process (startEngine\'s startJob).' },
    { name: 'jobId', type: 'string', required: true, order: 2,
      description: 'The job to run.' },
    { name: 'callbackUrl', type: 'string', order: 3,
      description: 'Where the job reports its outcome. Bind this to {resumeUrl}; it is the ' +
                   'address of this step\'s own resume key. Needed only when the job is started ' +
                   'over HTTP — an in-process start reports back through the same key directly.' },
    { name: 'inputs', type: 'object', order: 4, group: 'Advanced',
      description: 'Values to override the job\'s saved inputs, for this run only. The job row ' +
                   'is not changed. Commonly a window: { window: { from, to } }.' },
    { name: 'timeoutMs', type: 'number', default: 30000, order: 5, group: 'Advanced',
      description: 'How long to wait for the TRIGGER call to be accepted. Nothing to do with ' +
                   'how long the job itself may run — that is the job\'s own timeout.' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};

    // THE HOST'S OWN WAY OF STARTING A JOB, when it gave one (startEngine's
    // startJob — @xeplr/jobs' trigger() in the same process). No HTTP, no
    // jobsUrl and no credentials: the call runs inside this run's tenant
    // context, which is the job's. Without it this step falls back to the
    // jobs API over HTTP below.
    var startJob = require('../jobChains').jobStarter();
    if (startJob) {
      var started = await startJob(input.jobId, {
        inputs: input.inputs || null,
        callbackUrl: input.callbackUrl || null,
        chain: { resumeKey: (ctx.system && ctx.system.resumeKey) || null }
      });
      return {
        jobId: input.jobId,
        occurrenceId: (started && started.occurrenceId) || null,
        startedAt: new Date().toISOString(),
        status: 'running'
      };
    }

    // The binding resolved to nothing, which means WORKFLOW_PUBLIC_URL is
    // unset (see workflowRunner's publicResumeUrl). Caught HERE, before the
    // job is started, because the alternative is a job that runs perfectly for
    // twenty minutes and then has nowhere to report to — leaving the step
    // waiting forever on work that actually succeeded.
    if (!input.callbackUrl) throw new Error(CALLBACK_UNREACHABLE);

    // THE SAME CHECK FOR THE OTHER BINDING, and it needs its own message.
    //
    // The canvas fills jobsUrl with `{env.JOBS_API_URL}`, and the engine
    // resolves an unknown binding to the EMPTY STRING rather than failing —
    // so an unset (or unexposed) variable arrives here as '' and satisfies
    // `required`, which only rejects null and undefined. Left alone that
    // becomes fetch('/jobs/j1/trigger') and a "Failed to parse URL" nobody can
    // trace back to an environment variable.
    //
    // Both halves are named because either one alone is the cause: the
    // variable can be set and simply not listed in WORKFLOW_ENV_EXPOSED, which
    // is exactly as invisible.
    var jobsUrl = String(input.jobsUrl || '').trim();
    if (!/^https?:\/\//i.test(jobsUrl)) {
      throw new Error('This step needs the address of the jobs API and got ' +
        (jobsUrl ? '"' + jobsUrl + '"' : 'nothing') + '. It is normally bound to ' +
        '{env.JOBS_API_URL}, which resolves to an empty string unless JOBS_API_URL is set ' +
        'AND named in WORKFLOW_ENV_EXPOSED — check both. It must be absolute, e.g. ' +
        'https://bi.example.com/api');
    }

    var base = jobsUrl.replace(/\/+$/, '');
    var url = base + '/jobs/' + encodeURIComponent(input.jobId) + '/trigger';

    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, input.timeoutMs || 30000);
    if (timer.unref) timer.unref();

    var res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputs: input.inputs || undefined,
          callbackUrl: input.callbackUrl
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    // BUSY IS A FAILURE, NOT A WAIT.
    //
    // A job holds one lock and runs one at a time. Treating 409 as "try again
    // shortly" would mean a chain that quietly continues past a movement that
    // never ran, and the step after it aggregating a period nothing loaded.
    // Failing here stops the run, which is what the step's own onError already
    // defaults to.
    if (res.status === 409) {
      throw new Error('Job ' + input.jobId + ' is already running, so this step cannot start it. ' +
        'Wait for the current run to finish, or schedule these so they do not overlap.');
    }

    if (!res.ok) {
      var detail = await res.text().catch(function() { return ''; });
      throw new Error('Could not start job ' + input.jobId + ' — the jobs API answered ' +
        res.status + (detail ? ': ' + detail.slice(0, 300) : '') + '.');
    }

    var body = await res.json().catch(function() { return {}; });
    var row = (body.dataArray && body.dataArray[0]) || {};

    // WHAT THIS STEP KNOWS SO FAR — the handle, not the result.
    //
    // The occurrence's outcome arrives later, through the callback, and
    // resumeByKey MERGES it over this. So a downstream binding of
    // {steps.<key>.output.occurrenceId} works from the moment the job starts,
    // and {steps.<key>.output.output.totalRows} works once it has finished.
    return {
      jobId: input.jobId,
      occurrenceId: row.occurrenceId || null,
      startedAt: new Date().toISOString(),
      status: 'running'
    };
  }
};

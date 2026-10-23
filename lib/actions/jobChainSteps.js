// THE TWO STEPS OF A JOB CHAIN — see lib/jobChains.js.
//
// Registered but HIDDEN from GET /actions, like screen-show: only the facade
// that generates a chain's workflow knows how to build these steps, and one
// dropped onto the canvas by hand would have no rules and no finished job to
// read.

var db = require('../db');
var jobChains = require('../jobChains');

var NOT_CONNECTED =
  'This step starts a job, but this install has not connected jobs to workflow. ' +
  'The host must pass startJob to startEngine()/registerWorkflow() — with @xeplr/jobs ' +
  'in the same process that is (jobId, body) => jobs.trigger(jobId, body).';

// `decide` does nothing. Its transitions are the job's rules, and the engine
// evaluates them against the run's params once it returns.
var decide = {
  name: jobChains.DECIDE_ACTION,
  description: 'Choose which job runs next from how the last one ended. Its transitions are the rules.',
  requires: [],
  inputSchema: [{ name: 'rules', type: 'array', order: 1, description: 'The rules as written on the job.' }],
  outputSchema: null,
  execute: async function() { return {}; }
};

// `run_n` starts one job and parks until it reports back. The rule's inputs and
// carry are resolved HERE against the run's own params (typed — see
// resolveTyped), not by the engine's text interpolation, so a window or a
// number passes as itself.
var next = {
  name: jobChains.NEXT_ACTION,
  description: 'Start the next job of a chain with the period and values carried so far, and wait for it.',
  requires: [],
  inputSchema: [
    { name: 'jobId', type: 'string', required: true, order: 1 },
    { name: 'inputs', type: 'object', order: 2 },
    { name: 'carry', type: 'object', order: 3 },
    { name: 'callbackUrl', type: 'string', order: 4 }
  ],
  outputSchema: null,

  execute: async function(ctx) {
    var input = ctx.input || {};
    var startJob = jobChains.jobStarter();
    if (!startJob) throw new Error(NOT_CONNECTED);

    // The STEP's values as saved, not the interpolated input: `inputs` and
    // `carry` hold `{output.x}` bindings that only resolveTyped keeps typed.
    var step = await db.model('WorkflowStep').query().findById(ctx.system.stepId);
    var run = await db.model('WorkflowRun').query().findById(ctx.system.runId);
    var call = jobChains.nextJobCall(run && run.params, {
      jobId: input.jobId,
      inputs: step && step.values ? step.values.inputs : input.inputs,
      carry: step && step.values ? step.values.carry : input.carry
    });

    // The resume key travels in the chain, so a host can resume this step
    // in-process when the job ends (jobChains.jobFinished); the callback URL
    // is the same key over HTTP, for a jobs service in another process. Null
    // when WORKFLOW_PUBLIC_URL is unset, which is fine in-process.
    call.chain.resumeKey = (ctx.system && ctx.system.resumeKey) || null;
    var started = await startJob(input.jobId, {
      inputs: call.inputs,
      chain: call.chain,
      callbackUrl: input.callbackUrl || null
    });

    return {
      jobId: input.jobId,
      occurrenceId: (started && started.occurrenceId) || null,
      status: 'running',
      window: call.inputs.window || null,
      carry: call.chain.carry
    };
  }
};

module.exports = { decide: decide, next: next };

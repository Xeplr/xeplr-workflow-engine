// workflow-poll — WHAT A STEP'S OWN JOB RUNS, ON EVERY TICK.
//
// A step that keeps checking (workflow_steps.poll) has a job, and the job's
// schedule is how often. Each tick runs this: the step is run again for
// every run listening on it, and each one that finds something starts a
// child run from the step's arrows (workflowRunner.pollStep). A tick that
// finds nothing starts nothing.
//
// Registered but not offered (actionCatalog HIDDEN): it is a job's action, never
// a step anybody draws.
module.exports = {
  name: 'workflow-poll',
  description: 'Runs a workflow step that keeps checking, for every run listening on it.',
  inputSchema: [
    { name: 'workflowId', type: 'string', required: true, description: 'The workflow the step is in.' },
    { name: 'stepKey', type: 'string', required: true, description: 'The step that keeps checking.' }
  ],
  outputSchema: [
    { name: 'listening', type: 'number', description: 'Runs listening on the step.' },
    { name: 'found', type: 'number', description: 'Of those, how many found something this time.' },
    { name: 'started', type: 'array', description: 'The child runs started, by id.' },
    { name: 'failed', type: 'array', description: '[{ runId, message }] — a check that failed. The run keeps listening.' }
  ],
  execute: async function(ctx) {
    var input = ctx.input || {};
    return require('../workflowRunner').pollStep(input.workflowId, input.stepKey);
  }
};

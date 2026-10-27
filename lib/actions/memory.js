// remember / recall — WHAT A WORKFLOW KNOWS FROM ITS EARLIER RUNS.
//
// One value per key, per workflow (workflow_memory, 0018). The key usually
// carries the period:
//
//   recall    key: bank-recon:{trigger.window.from|date:YYYY-MM}
//             → { found: true, value, at, runId }   (found: false when never set)
//   remember  key: bank-recon:{trigger.window.from|date:YYYY-MM}
//             value: { file: "{steps.save.output.path}" }
//
// so a workflow starts with "is September already done?" (an arrow on
// output.found) and ends by saying it is. Without it, the only answers were
// a file name on disk or a search through run history.
//
// Inside the run's tenant (the runner calls every step in it), so one
// company never reads another's.
var { generateId } = require('@xeplr/utils/lib/helpers');
var db = require('../db');

async function workflowOf(ctx) {
  var runId = ctx && ctx.system && ctx.system.runId;
  var run = runId ? await db.model('WorkflowRun').query().findById(runId) : null;
  if (!run) throw new Error('remember and recall work only inside a workflow run.');
  return run;
}

function keyOf(input) {
  var key = String(input.key == null ? '' : input.key).trim();
  if (!key) {
    var err = new Error('A key is needed, e.g. bank-recon:{trigger.window.from|date:YYYY-MM}.');
    err.code = 'KEY_REQUIRED';
    throw err;
  }
  if (key.length > 255) throw new Error('A key is at most 255 characters.');
  return key;
}

var remember = {
  name: 'remember',
  description: 'Keep a value under a key for this workflow\'s later runs, e.g. that a period is done. ' +
               'Remembering again replaces it; forget: true removes it.',
  requires: [],
  inputSchema: [
    { name: 'key', type: 'string', required: true, order: 1,
      description: 'What it is remembered under, e.g. bank-recon:{trigger.window.from|date:YYYY-MM}.' },
    { name: 'value', type: 'object', order: 2,
      description: 'What to keep, e.g. { "file": "{steps.save.output.path}" }. Empty: just that it happened.' },
    { name: 'forget', type: 'boolean', default: false, order: 3,
      description: 'Remove the key instead, so the next run does the work again.' }
  ],
  outputSchema: [{ name: 'key', type: 'string' }, { name: 'forgotten', type: 'boolean' }],
  execute: async function(ctx) {
    var input = ctx.input || {};
    var key = keyOf(input);
    var run = await workflowOf(ctx);
    var Memory = db.model('WorkflowMemory');
    var existing = await Memory.query().where({ workflowId: run.workflowId, key: key }).first();
    if (input.forget) {
      if (existing) await Memory.query().deleteById(existing.id);
      return { key: key, forgotten: Boolean(existing) };
    }
    var value = input.value === undefined || input.value === null ? { at: new Date().toISOString() } : input.value;
    if (existing) await Memory.query().findById(existing.id).patch({ value: value, runId: run.id });
    else await Memory.query().insert({ id: generateId(), workflowId: run.workflowId, key: key, value: value, runId: run.id });
    return { key: key, forgotten: false };
  }
};

var recall = {
  name: 'recall',
  description: 'Read what this workflow remembered under a key in an earlier run. ' +
               'Returns { found, value, at, runId }; branch on output.found.',
  requires: [],
  inputSchema: [
    { name: 'key', type: 'string', required: true, order: 1,
      description: 'The key, e.g. bank-recon:{trigger.window.from|date:YYYY-MM}.' }
  ],
  outputSchema: [
    { name: 'found', type: 'boolean' }, { name: 'value', type: 'object' },
    { name: 'at', type: 'string', description: 'When it was remembered.' },
    { name: 'runId', type: 'string', description: 'The run that remembered it.' }
  ],
  execute: async function(ctx) {
    var input = ctx.input || {};
    var key = keyOf(input);
    var run = await workflowOf(ctx);
    var row = await db.model('WorkflowMemory').query().where({ workflowId: run.workflowId, key: key }).first();
    if (!row) return { found: false, value: null, at: null, runId: null };
    return { found: true, value: row.value, at: row.recordModifiedDate || row.recordCreatedDate, runId: row.runId };
  }
};

module.exports = { remember: remember, recall: recall };

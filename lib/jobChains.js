// JOB CHAINS — "after this job, run that one", kept as an ordinary workflow.
//
// A job can say what should happen when it finishes: a list of rules, each a
// condition on how it ended and the job to run next. The rules are written on
// the job's own screen, but they are NOT kept by the jobs package and nothing
// in jobs starts another job. Every hand-off between jobs, screens and anything
// else goes through this engine — one rule, one place.
//
// So a job's rules become one hidden workflow (kind 'job-chain', key
// 'job-chain-<jobId>'), generated here the way lib/flows.js generates a
// screens flow:
//
//   decide       does nothing; its transitions are the rules, first match wins
//   run_1 … n    one per rule: start that job and wait for it to finish
//
// and it runs every time the job finishes. The host tells this module when
// that happens (jobFinished — @xeplr/jobs' onFinish hook), and how to start a
// job (setJobStarter — @xeplr/jobs' trigger()). This module never imports
// jobs; the host is the only thing that knows both are present.
//
// ── what travels ────────────────────────────────────────────────────────
//
// A run of the chain starts with params:
//
//   status    'success' | 'failed' — did the finished job's work happen
//   error     its error, when it failed
//   output    the finished job's own output (what its action returned)
//   window    the period it ran for: the range it was given, or — when it
//             was given none — the range its action reports it covered
//   given / used  those two ranges separately, handed to the next job as
//             chain.previous (its parameters can bind either)
//   carry     values carried along the chain, from every job before it
//   jobId     the job that finished
//
// and every rule's `when` reads those (`output.rowsMoved`, `carry.batch`). The
// next job is started with the SAME window unless the rule sets one, so the
// period flows from the first job of a chain to the last. A rule's `inputs`
// fill inputs the next job accepts (its acceptsInputs); its `carry` adds
// values for later jobs. Both may bind `{output.x}`, `{carry.x}`, `{window.x}`.
var { generateId } = require('@xeplr/utils/lib/helpers');
var { interpolate, getPath } = require('@xeplr/schema-handler');
var db = require('./db');
var flows = require('./flows');

var CHAIN_KIND = 'job-chain';
var DECIDE_ACTION = 'job-chain-decide';
var NEXT_ACTION = 'job-chain-next';

// The roots a rule may read — the params a chain run starts with.
var ROOTS = ['status', 'error', 'output', 'carry', 'window', 'jobId'];
var FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+)*$/;
var JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,25}$/;

// A chain longer than this is a loop nobody drew on purpose.
var MAX_DEPTH = 25;

var EDIT_MESSAGE = 'This workflow is made from a job\'s "After this job" rules — change them on the job.';

var fail = flows.fail;

function keyFor(jobId) { return 'job-chain-' + jobId; }

// ── how a job is started ────────────────────────────────────────────────
//
// Supplied by the host: async (jobId, { inputs, chain, callbackUrl }) →
// { occurrenceId }. With @xeplr/jobs in the same process that is
// `jobs.trigger`. Unset, a chain step fails and says what is missing.
var _startJob = null;

function setJobStarter(fn) {
  _startJob = typeof fn === 'function' ? fn : null;
}

function jobStarter() { return _startJob; }

// ── a rule's `when` → the engine's condition node ───────────────────────

function fieldPath(field, where) {
  var f = String(field == null ? '' : field).trim();
  if (!f) throw fail(400, 'CHAIN_INVALID', where + ': `field` is required — e.g. "status" or "output.rowsMoved".');
  if (!FIELD_PATTERN.test(f)) throw fail(400, 'CHAIN_INVALID', where + ': "' + f + '" is not a usable field.');
  var root = f.split('.')[0];
  if (ROOTS.indexOf(root) === -1) {
    throw fail(400, 'CHAIN_INVALID', where + ': "' + f + '" must start with one of ' + ROOTS.join(', ') + '.');
  }
  return 'params.' + f;
}

/**
 * `{ field, op, value }`, `{ all: [...] }` or `{ any: [...] }` → the node the
 * engine evaluates. null/undefined → the catch-all ("otherwise").
 */
function whenToCondition(when, where) {
  if (when === null || when === undefined) return null;
  if (typeof when !== 'object' || Array.isArray(when)) {
    throw fail(400, 'CHAIN_INVALID', where + ': the condition must be an object such as ' +
      '{ "field": "status", "op": "=", "value": "success" }, or empty for "otherwise".');
  }
  if (when.all !== undefined || when.any !== undefined) {
    var groupKey = when.all !== undefined ? 'all' : 'any';
    var list = when[groupKey];
    if (!Array.isArray(list) || !list.length) {
      throw fail(400, 'CHAIN_INVALID', where + ': `' + groupKey + '` needs a non-empty list of conditions.');
    }
    var group = {};
    group[groupKey] = list.map(function(c, i) {
      var node = whenToCondition(c, where + ', ' + groupKey + ' ' + (i + 1));
      if (!node) throw fail(400, 'CHAIN_INVALID', where + ': an empty condition inside `' + groupKey + '`.');
      return node;
    });
    return group;
  }
  return flows.comparisonNode(when, where, fieldPath(when.field, where), 'CHAIN_INVALID');
}

// ── values a rule passes on ─────────────────────────────────────────────

/**
 * Resolve `{path}` bindings against a chain run's params, KEEPING TYPES: a
 * string that is exactly one binding takes the bound value as it is — an
 * object stays an object, a number a number — so `"window": "{window}"` or
 * `"batch": "{carry.batch}"` passes the real thing. Anything else is text,
 * resolved by @xeplr/schema-handler's interpolate like every other binding.
 */
function resolveTyped(value, context) {
  if (value == null) return value;
  if (typeof value === 'string') {
    var whole = /^\{([^{}]+)\}$/.exec(value.trim());
    if (whole) {
      var v = getPath(context, whole[1].trim());
      return v === undefined ? null : v;
    }
    return interpolate(value, context);
  }
  if (Array.isArray(value)) return value.map(function(v) { return resolveTyped(v, context); });
  if (typeof value === 'object') {
    var out = {};
    Object.keys(value).forEach(function(k) { out[k] = resolveTyped(value[k], context); });
    return out;
  }
  return value;
}

function plainObject(value, where, name) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw fail(400, 'CHAIN_INVALID', where + ': `' + name + '` must be an object of name → value.');
  }
  return value;
}

// ── the rules ⇄ the workflow's steps ────────────────────────────────────

/**
 * Validate a job's rules and return them normalised. Every problem is a 400
 * naming the rule; nothing is written until all of them pass.
 */
function normaliseRules(jobId, rules) {
  if (!Array.isArray(rules)) throw fail(400, 'CHAIN_INVALID', '`rules` must be a list.');
  var catchAllAt = -1;
  return rules.map(function(rule, i) {
    var where = 'Rule ' + (i + 1);
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw fail(400, 'CHAIN_INVALID', where + ': must be an object.');
    var run = String(rule.run == null ? '' : rule.run).trim();
    if (!run) throw fail(400, 'CHAIN_INVALID', where + ': choose the job to run.');
    if (!JOB_ID_PATTERN.test(run)) throw fail(400, 'CHAIN_INVALID', where + ': "' + run + '" is not a job id.');
    if (run === jobId) throw fail(400, 'CHAIN_INVALID', where + ': a job cannot run itself when it finishes — that would never stop.');
    if (catchAllAt > -1) {
      throw fail(400, 'CHAIN_INVALID', where + ': rule ' + (catchAllAt + 1) + ' has no condition, so it always matches and nothing after it can run.');
    }
    var when = rule.when === undefined ? null : rule.when;
    var condition = whenToCondition(when, where);
    if (!condition) catchAllAt = i;
    return {
      when: when,
      condition: condition,
      run: run,
      inputs: plainObject(rule.inputs, where, 'inputs'),
      carry: plainObject(rule.carry, where, 'carry')
    };
  });
}

function stepRows(workflowId, rules) {
  var transitions = rules.map(function(r, i) {
    return { condition: r.condition, mode: 'single', target: 'run_' + (i + 1) };
  });
  // No rule matched: the chain simply ends. A job's rules are "if this, run
  // that", and nothing matching is an ordinary outcome, not a failure.
  if (!rules.length || rules[rules.length - 1].condition) {
    transitions.push({ condition: null, mode: 'single', target: 'end_success' });
  }

  var rows = [{
    id: generateId(), workflowId: workflowId, stepKey: 'decide', name: 'Decide what runs next',
    actionName: DECIDE_ACTION, kind: 'auto', onError: 'stop',
    // THE RULES AS WRITTEN live on the step they generated, so GET answers
    // with exactly what was saved — conditions included — rather than
    // reconstructing them from engine nodes.
    values: { rules: rules.map(function(r) { return { when: r.when, run: r.run, inputs: r.inputs, carry: r.carry }; }) },
    transitions: transitions,
    position: 0
  }];

  rules.forEach(function(r, i) {
    rows.push({
      id: generateId(), workflowId: workflowId, stepKey: 'run_' + (i + 1), name: 'Run job ' + r.run,
      actionName: NEXT_ACTION,
      // A wait step: it starts the job and parks until the job reports back,
      // so the run says whether the next job actually worked.
      kind: 'wait', onError: 'stop',
      values: {
        jobId: r.run, inputs: r.inputs, carry: r.carry,
        callbackUrl: '{resumeUrl}'
      },
      transitions: [{ condition: null, mode: 'single', target: 'end_success' }],
      position: i + 1
    });
  });
  return rows;
}

async function loadChain(jobId) {
  return db.model('Workflow').query().where({ key: keyFor(jobId), kind: CHAIN_KIND }).first();
}

function chainView(jobId, workflow, steps) {
  var decide = (steps || []).find(function(s) { return s.stepKey === 'decide'; });
  return {
    jobId: jobId,
    workflowId: workflow ? workflow.id : null,
    rules: decide && decide.values && Array.isArray(decide.values.rules) ? decide.values.rules : []
  };
}

/** GET — a job's rules. A job without any answers an empty list, not a 404. */
async function getChain(jobId) {
  var workflow = await loadChain(jobId);
  if (!workflow || workflow.status !== 'published') return chainView(jobId, null, []);
  var steps = await db.model('WorkflowStep').query().where({ workflowId: workflow.id }).orderBy('position');
  return chainView(jobId, workflow, steps);
}

/**
 * PUT — replace a job's rules. An empty list removes them: the workflow is
 * kept (its runs are history) but set back to draft, so it no longer runs.
 *
 * @param {string} jobId
 * @param {{ rules: object[], jobName?: string }} body
 */
async function putChain(jobId, body) {
  body = body || {};
  if (!JOB_ID_PATTERN.test(String(jobId || ''))) throw fail(400, 'CHAIN_INVALID', 'Not a job id: "' + jobId + '".');
  var rules = normaliseRules(jobId, body.rules === undefined ? [] : body.rules);
  var name = 'After ' + (String(body.jobName || '').trim() || 'job ' + jobId).slice(0, 240);

  var workflow = await loadChain(jobId);
  if (!workflow) {
    if (!rules.length) return chainView(jobId, null, []);
    workflow = await db.model('Workflow').query().insert({
      id: generateId(), name: name, kind: CHAIN_KIND, key: keyFor(jobId), status: 'published',
      description: 'Made from the "After this job" rules of job ' + jobId + '.'
    });
  } else {
    await db.model('Workflow').query().findById(workflow.id)
      .patch({ name: name, status: rules.length ? 'published' : 'draft' });
  }

  // HARD delete, as putFlow does: (workflowId, stepKey) is unique regardless
  // of isActive, and every save regenerates the same keys.
  await db.model('WorkflowStep').query().delete().where({ workflowId: workflow.id });
  if (!rules.length) return chainView(jobId, null, []);

  var rows = stepRows(workflow.id, rules);
  for (var i = 0; i < rows.length; i++) await db.model('WorkflowStep').query().insert(rows[i]);
  return chainView(jobId, workflow, rows);
}

// ── a job has finished ──────────────────────────────────────────────────

function pause(ms) {
  return new Promise(function(resolve) { var t = setTimeout(resolve, ms); if (t.unref) t.unref(); });
}

/**
 * Resume the chain step that started this job.
 *
 * A job can finish before the step that started it has parked — the start is
 * fire-and-forget, and a quick job ends in milliseconds — and the engine
 * answers that with RESUME_KEY_NOT_READY rather than routing a step that is
 * still running. So it is tried again for a few seconds, as @xeplr/jobs'
 * HTTP callback retries. A key already used (that callback got there first)
 * is a settled answer.
 */
async function resumeStep(runner, key, output, opts) {
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
  throw new Error('The chain step waiting on this job never parked, so it could not be told the job finished.');
}

/**
 * Called by the host for EVERY job run that ends (@xeplr/jobs' onFinish), in
 * that job's tenant context, with the jobs envelope { status, error, output }.
 *
 * Two things, independently:
 *
 *   1. If this run was started by a chain step, resume that step, so the
 *      chain run that started it records how it went.
 *   2. If the finished job has rules, start its chain.
 *
 * Never throws for "nothing to do"; a chain that cannot start is logged by
 * the caller's hook guard and recorded as a failed run where possible.
 */
async function jobFinished(report) {
  report = report || {};
  var out = report.output || {};
  var chain = out.chain || {};
  var result = { resumed: false, runId: null };
  var runner = require('./workflowRunner');

  if (chain.resumeKey) {
    result.resumed = await resumeStep(runner, chain.resumeKey, out,
      report.status === 'success' ? {} : { status: 'failed', error: report.error });
  }

  var jobId = out.jobId;
  if (!jobId) return result;
  var workflow = await loadChain(jobId);
  if (!workflow || workflow.status !== 'published') return result;

  var path = Array.isArray(chain.path) ? chain.path.slice() : [];
  path.push(jobId);

  var run = await runner.startRun(workflow.id, {
    jobId: jobId,
    status: report.status === 'success' ? 'success' : 'failed',
    error: report.error || null,
    output: out.output || null,
    // THE PERIOD THAT FLOWS ON: the range the job was given when it was given
    // one; otherwise the range its action reports it actually covered (a
    // movement that started from the copy's own highest value is given none,
    // and reports where it read from). See README "Job chains".
    window: out.window || (out.output && out.output.window) || null,
    // BOTH of the finished job's ranges, as they are, for the next job's
    // parameters to pick from (@xeplr/jobs' run contract, previous.*): what
    // it was given, and what its action reports it actually covered.
    given: out.window || null,
    used: (out.output && out.output.window) || null,
    carry: chain.carry && typeof chain.carry === 'object' ? chain.carry : {},
    path: path
  }, { trigger: 'job' });
  result.runId = run && run.id;
  return result;
}

/**
 * What a chain step hands the job it starts: the inputs (window first, then
 * the rule's own), the carry, and the path so far. Pure — exported to test.
 */
function nextJobCall(params, values) {
  params = params || {};
  values = values || {};
  var path = Array.isArray(params.path) ? params.path : [];
  if (path.indexOf(values.jobId) > -1) {
    throw new Error('Job ' + values.jobId + ' has already run in this chain (' + path.concat(values.jobId).join(' → ') +
      '), so running it again would loop. Change the "After this job" rules so the chain ends.');
  }
  if (path.length >= MAX_DEPTH) {
    throw new Error('This chain has run ' + path.length + ' jobs in a row, which is the most allowed. Check the "After this job" rules for a loop.');
  }

  var inputs = resolveTyped(values.inputs || {}, params);
  // THE PERIOD FLOWS ON unless the rule says otherwise.
  if (inputs.window === undefined && params.window) inputs = Object.assign({ window: params.window }, inputs);

  var carry = Object.assign({}, params.carry || {}, resolveTyped(values.carry || {}, params));
  return {
    inputs: inputs,
    chain: { carry: carry, path: path, previous: { given: params.given || null, used: params.used || null } }
  };
}

/**
 * True when a POST /workflows/save touches a chain's workflow — refused, for
 * the reason flows.touchesScreens gives: these steps are generated, and a hand
 * edit would vanish at the next save of the job's rules.
 */
async function touchesChains(body) {
  var entries = Array.isArray(body) ? body : (body ? [body] : []);
  if (entries.some(function(e) { return e && e.kind === CHAIN_KIND; })) return true;
  var ids = entries.map(function(e) { return e && e.id; }).filter(Boolean);
  if (!ids.length) return false;
  var rows = await db.model('Workflow').query().whereIn('id', ids);
  return rows.some(function(r) { return r.kind === CHAIN_KIND; });
}

module.exports = {
  CHAIN_KIND: CHAIN_KIND,
  DECIDE_ACTION: DECIDE_ACTION,
  NEXT_ACTION: NEXT_ACTION,
  EDIT_MESSAGE: EDIT_MESSAGE,
  ROOTS: ROOTS,
  keyFor: keyFor,

  setJobStarter: setJobStarter,
  jobStarter: jobStarter,

  // Pure, exported to test.
  whenToCondition: whenToCondition,
  normaliseRules: normaliseRules,
  resolveTyped: resolveTyped,
  nextJobCall: nextJobCall,

  getChain: getChain,
  putChain: putChain,
  jobFinished: jobFinished,
  touchesChains: touchesChains
};

// FLOWS — a screen is a step, and an app can design and run one without
// knowing anything about workflows.
//
// A "flow" is a workflow of kind 'screens' (migrations/0013). Every step is a
// `wait` step on the `screen-show` action carrying one screen key, so the
// engine that already exists runs it unchanged: the wait machinery parks the
// run and mints the resume key, resumeByKey merges the submitted values onto
// the step's output, and the ordinary transitions route on `output.<field>`.
//
// NOTHING HERE IS A SECOND ENGINE. This module translates one vocabulary into
// another and back:
//
//   a flow      is  a workflow row with kind 'screens' and a `key`
//   a screen    is  a step with actionName 'screen-show', kind 'wait',
//                   values.screen = the screen key
//   a branch    is  a transition whose condition is an expression-handler node
//   a submit    is  resumeByKey(theRun'sLiveKey, values)
//
// ── WHY THE DESIGNER NEVER SENDS AN EXPRESSION ──────────────────────────
//
// Transitions arrive and leave as `{ when: { field, op, value } | null,
// target }`. `field` is a field NAME on that step's screen; this module is
// what turns it into the path the engine reads (`output.<field>`) and what
// turns the designer's `=` into the engine's `eq`.
//
// That translation is deliberately one-way-in-one-place. The alternative — the
// browser compiling a formula, as the workflow builder does (@xeplr-workflow/ui's src/
// conditions.js) — means the client has to know that a resumed wait step's
// values land under `output`, which is an engine fact that has already changed
// once. A designer that only ever says "the field `type` equals contractor"
// keeps working the day it changes again.
//
// ── WHY A FLOW CANNOT BE EDITED THROUGH /workflows/save ─────────────────
//
// The steps of a flow are generated from a design held somewhere else. A hand
// edit through the workflow builder would be overwritten by the next PUT here
// with no warning and no record, so the workflow document routes refuse a
// 'screens' workflow outright (see touchesScreens; the API's router refuses the save)
// and the builder shows it read-only. Runs and history stay visible, because
// none of that is editing.

var { generateId } = require('@xeplr/utils/lib/helpers');
var db = require('./db');
var workflowRunner = require('./workflowRunner');
var versions = require('./versions');

// The `workflows.kind` value that makes a workflow a flow. Not read by the
// engine — see migrations/0012's note; it decides who is allowed to edit the
// row and which facade lists it.
var FLOW_KIND = 'screens';

// Every step of a flow names this one action. A step on any other action is
// not something this facade can describe, which is why PUT builds the rows
// rather than accepting them.
var SCREEN_ACTION = 'screen-show';

// What the workflow document's own routes say when they refuse a flow. One
// sentence, naming where the thing IS editable — a refusal that does not say
// where to go instead is a dead end.
var SCREENS_EDIT_MESSAGE = 'This flow is designed in Configure UI';

// A flow's key is in its URL (GET /flows/:key), and /flows/runs/:runId shares
// that space. A flow keyed "runs" would make the second unreachable.
var RESERVED_KEYS = ['runs', 'waiting'];

var KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
var STEP_KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
// A field name on a screen. Dots are allowed so a nested value
// (`address.city`) can be branched on — the engine's getPath walks them.
var FIELD_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

// The two sentinels the engine accepts as a transition target besides a step
// key. Restated here because they are part of this facade's contract too.
var END_TARGETS = ['end_success', 'end_failed'];

// A registered function's name — the same rule @xeplr/ui-factory's FUNCTION_NAME applies.
var FUNCTION_NAME = /^[A-Za-z_][\w.-]{0,99}$/;

// Which run statuses mean "still going". `queued` is only ever a fanned-out
// child's starting state, and a screens flow does not fan out — it is in the
// list because the column has it, not because a flow reaches it.
var LIVE_RUN_STATUSES = ['queued', 'running', 'waiting'];

// ── the comparisons a designer may offer ────────────────────────────────
//
// KEY = what the designer sends and what GET hands back; VALUE = the operator
// @xeplr/expression-handler actually evaluates (lib/operators.js). Every one
// of these is an operator that package already has — this table adds no
// semantics, it only spells them the way a person picking from a dropdown
// would.
//
// The spellings are the ones the workflow builder's formula syntax already
// uses for the comparisons that have a symbol — the builder now writes a
// stored condition back with the engine's own `xf.toText` — so the two halves
// of the product do not disagree about what "=" means.
var OPS = {
  '=':           'eq',
  '!=':          'neq',
  '>':           'gt',
  '>=':          'gte',
  '<':           'lt',
  '<=':          'lte',
  'contains':    'contains',
  'notContains': 'notContains',
  'startsWith':  'startsWith',
  'endsWith':    'endsWith',
  'in':          'in',
  'notIn':       'notIn',
  'between':     'between',
  'isEmpty':     'isNull',
  'isNotEmpty':  'isNotNull'
};

// Other spellings of the same comparisons, accepted on the way IN only. A
// designer written against the engine's own vocabulary ('eq') keeps working;
// GET always answers in the canonical spelling above, so a round-trip is
// stable rather than merely lossless.
var OP_ALIASES = {
  eq: '=', equals: '=', '==': '=',
  neq: '!=', notEquals: '!=', '<>': '!=',
  gt: '>', gte: '>=', lt: '<', lte: '<=',
  isNull: 'isEmpty', isNotNull: 'isNotEmpty',
  doesNotContain: 'notContains'
};

// Engine operator → canonical designer spelling, for reading a stored
// condition back out.
var OP_FROM_ENGINE = {};
Object.keys(OPS).forEach(function(op) { OP_FROM_ENGINE[OPS[op]] = op; });

// Take no right-hand value at all (arity 1 in the expression package).
var UNARY_OPS = ['isEmpty', 'isNotEmpty'];
// Take a list rather than a single value.
var LIST_OPS = ['in', 'notIn', 'between'];

/** The comparison names a designer may send, for an error message and for docs. */
function operators() {
  return Object.keys(OPS);
}

// ── errors ──────────────────────────────────────────────────────────────
//
// Same body every other route in this package answers with —
// { message, code, details } — plus an HTTP status carried on the error so the
// router does not have to classify anything. `code` is what a client branches
// on; `message` is what a person reads.
function fail(status, code, message, details) {
  var err = new Error(message);
  err.status = status;
  err.code = code;
  err.details = details || [];
  return err;
}

function uid() { return generateId(); }

// ── a designer's `when` ⇄ the engine's condition node ───────────────────

function canonicalOp(op) {
  var raw = String(op == null ? '' : op).trim();
  if (OPS[raw]) return raw;
  if (OP_ALIASES[raw]) return OP_ALIASES[raw];
  return null;
}

/**
 * `{ field, op, value }` → the expression node the engine evaluates, or null
 * for the catch-all.
 *
 * `field` is a bare field name of the step's own screen and is prefixed here
 * with `output.` — which is where a resumed wait step's submitted values live
 * (resumeByKey merges them onto the step run's output, and routeAfterStep
 * evaluates against `{ output, item, params }`). The designer is never told
 * that; if it ever changes, it changes in this one function.
 *
 * @param {object|null} when
 * @param {string} where  what to call this in an error ("step 'details',
 *   transition 2")
 */
function whenToCondition(when, where) {
  if (when === null || when === undefined) return null;
  if (typeof when !== 'object' || Array.isArray(when)) {
    throw fail(400, 'FLOW_INVALID', where + ': `when` must be an object, or null for the catch-all.');
  }

  var field = String(when.field == null ? '' : when.field).trim();
  if (!field) {
    throw fail(400, 'FLOW_INVALID', where + ': `when.field` is required — the name of a field on this step\'s screen.');
  }
  // A designer that sends `output.type` has learned an engine fact it should
  // not have to know, and storing it would double the prefix. Named rather
  // than silently stripped, so the mistake is fixed where it was made.
  if (/^(output|params|item|steps|previous_step)\./.test(field)) {
    throw fail(400, 'FLOW_INVALID', where + ': `when.field` is a plain field name of this screen, not a path — send "' +
      field.replace(/^[a-z_]+\./, '') + '" rather than "' + field + '".');
  }
  if (!FIELD_PATTERN.test(field)) {
    throw fail(400, 'FLOW_INVALID', where + ': "' + field + '" is not a usable field name (letters, digits, _ - and . only).');
  }

  return comparisonNode(when, where, 'output.' + field, 'FLOW_INVALID');
}

/**
 * `{ op, value }` against the engine path `path` → the expression node the
 * engine evaluates. The comparison half of a `when`, shared by every facade
 * that writes conditions (screens flows here), so
 * "=" means one thing however a condition arrives.
 *
 * @param {object} when   { op, value }
 * @param {string} where  what to call this in an error
 * @param {string} path   the engine path the left side reads
 * @param {string} code   the error code a refusal carries
 */
function comparisonNode(when, where, path, code) {
  var op = canonicalOp(when.op);
  if (!op) {
    throw fail(400, code, where + ': "' + when.op + '" is not a comparison this engine has. One of: ' + operators().join(', ') + '.');
  }

  var node = { left: { field: path }, op: OPS[op] };

  if (UNARY_OPS.indexOf(op) > -1) {
    if (when.value !== undefined && when.value !== null) {
      throw fail(400, code, where + ': "' + op + '" takes no value.');
    }
    return node;
  }

  var value = when.value;

  if (LIST_OPS.indexOf(op) > -1) {
    if (!Array.isArray(value) || !value.length) {
      throw fail(400, code, where + ': "' + op + '" needs `when.value` to be a non-empty list.');
    }
    if (op === 'between' && value.length !== 2) {
      throw fail(400, code, where + ': "between" needs exactly two values, low then high.');
    }
    node.right = { value: value.slice() };
    return node;
  }

  if (value === undefined || value === null) {
    throw fail(400, code, where + ': "' + op + '" needs a `when.value`.');
  }
  var type = typeof value;
  if (type !== 'string' && type !== 'number' && type !== 'boolean') {
    throw fail(400, code, where + ': `when.value` must be a string, number or boolean.');
  }
  node.right = { value: value };
  return node;
}

/**
 * The stored condition node → the `when` the designer sent.
 *
 * The inverse of whenToCondition for everything this facade writes. A node it
 * did not write (a hand-edited row, an older workflow) has no `when` that
 * describes it, so it comes back as null — which reads in the designer as a
 * catch-all rather than as a branch it would silently mistranslate. Publish
 * validation is what stops such a row being created through this facade in the
 * first place.
 */
function conditionToWhen(node) {
  if (!node || typeof node !== 'object') return null;
  var op = OP_FROM_ENGINE[node.op];
  var field = node.left && typeof node.left.field === 'string' ? node.left.field : '';
  if (!op || field.indexOf('output.') !== 0) return null;

  var when = { field: field.slice('output.'.length), op: op };
  if (UNARY_OPS.indexOf(op) === -1) {
    when.value = node.right && Object.prototype.hasOwnProperty.call(node.right, 'value') ? node.right.value : null;
  }
  return when;
}

// ── the flow document ───────────────────────────────────────────────────

function normaliseKey(key) {
  var value = String(key == null ? '' : key).trim();
  if (!value) throw fail(400, 'FLOW_KEY_INVALID', 'A flow needs a `key`.');
  if (!KEY_PATTERN.test(value)) {
    throw fail(400, 'FLOW_KEY_INVALID', '"' + value + '" is not a usable flow key — lowercase letters, digits, _ and -, starting with a letter or digit.');
  }
  if (RESERVED_KEYS.indexOf(value) > -1) {
    throw fail(400, 'FLOW_KEY_INVALID', '"' + value + '" is reserved — /flows/runs/:runId already uses it.');
  }
  return value;
}

/**
 * One step as the designer sees it. `transitions` always comes back as an
 * array (never null) so a client never has to branch on the absence of one.
 */
function stepView(step) {
  var values = step.values || {};
  return {
    stepKey: step.stepKey,
    // What the designer calls the step. Kept in the step's own `name`, so the
    // workflow app shows the same words for it as Configure UI does.
    label: step.name || null,
    screen: values.screen || null,
    layout: step.layout || null,
    transitions: (step.transitions || []).map(function(t) {
      // A function deciding is said as itself: its name, and the steps it may
      // choose from (none listed: any step of the flow).
      if (t.decide) return { when: conditionToWhen(t.condition), decide: t.decide, targets: t.targets || [] };
      return { when: conditionToWhen(t.condition), target: t.target };
    })
  };
}

function flowView(workflow, steps) {
  return {
    id: workflow.id,
    key: workflow.key,
    name: workflow.name,
    status: workflow.status,
    steps: (steps || []).map(stepView)
  };
}

/** The list row. `steps` is a COUNT here, and the whole array on GET /flows/:key. */
function flowSummary(workflow, stepCount) {
  return {
    id: workflow.id,
    key: workflow.key,
    name: workflow.name,
    status: workflow.status,
    steps: stepCount
  };
}

/**
 * The flow row for a key, or a 404.
 *
 * Tenant-scoped by query() — a key that belongs to another company is not
 * found rather than refused, because "no such flow" and "not yours" must read
 * the same from outside. See BaseModel's tenant modifier.
 */
async function loadFlow(key) {
  var flow = await db.model('Workflow').query().where({ key: key, kind: FLOW_KIND }).first();
  if (!flow) throw fail(404, 'FLOW_NOT_FOUND', 'No flow "' + key + '".');
  return flow;
}

/**
 * ANY workflow with that key — the one to RUN, whichever kind it is.
 *
 * A flow used to mean "a workflow of kind 'screens', designed elsewhere". It
 * now also means an ordinary workflow drawn in the designer, addressed by the
 * key its app gave it, whose steps happen to include screens (@xeplr/ui-
 * workflow's Screen type). Both are run the same way and by the same page, so
 * the routes that START and LIST runs ask only for the key.
 *
 * DESIGN is the part that is still kind-gated, and deliberately: putFlow and
 * publishFlow generate the step rows from a screens-only description, and
 * pointing those at a workflow drawn here would delete a design they cannot
 * express. So loadFlow above still guards them, and this is for running.
 */
async function loadRunnable(key) {
  var flow = await db.model('Workflow').query().where({ key: key }).first();
  if (!flow) throw fail(404, 'FLOW_NOT_FOUND', 'No flow "' + key + '".');
  return flow;
}

async function loadSteps(workflowId) {
  return db.model('WorkflowStep').query().where({ workflowId: workflowId }).orderBy('position');
}

// ── the steps a PUT writes ──────────────────────────────────────────────

/**
 * The designer's steps → workflow_steps rows.
 *
 * EVERYTHING IS VALIDATED BEFORE ANYTHING IS WRITTEN. The rows are built
 * completely first and only then does putSteps touch the table, so a PUT that
 * is refused leaves the draft exactly as it was rather than half-replaced.
 *
 * `screen` may be missing here and is required at PUBLISH: a draft is allowed
 * to be unfinished, which is the difference between the two verbs.
 */
function toStepRows(workflowId, steps) {
  if (!Array.isArray(steps)) {
    throw fail(400, 'FLOW_INVALID', '`steps` must be an array.');
  }

  var seen = {};
  return steps.map(function(step, index) {
    var where = 'step ' + (index + 1);
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw fail(400, 'FLOW_INVALID', where + ': each step must be an object.');
    }

    var stepKey = String(step.stepKey == null ? '' : step.stepKey).trim();
    if (!stepKey) throw fail(400, 'FLOW_INVALID', where + ': `stepKey` is required.');
    if (!STEP_KEY_PATTERN.test(stepKey)) {
      throw fail(400, 'FLOW_INVALID', where + ': "' + stepKey + '" is not a usable stepKey (letters, digits, _ and -).');
    }
    // Two steps with one key would make `target: "x"` ambiguous and would
    // collide on workflow_steps' own unique index — caught here so the answer
    // names the step rather than the constraint.
    if (seen[stepKey]) throw fail(400, 'FLOW_INVALID', 'Two steps share the stepKey "' + stepKey + '".');
    seen[stepKey] = true;

    var screen = step.screen == null ? '' : String(step.screen).trim();

    var transitions = step.transitions === undefined || step.transitions === null ? [] : step.transitions;
    if (!Array.isArray(transitions)) {
      throw fail(400, 'FLOW_INVALID', 'step "' + stepKey + '": `transitions` must be an array.');
    }

    var compiled = transitions.map(function(t, ti) {
      var label = 'step "' + stepKey + '", transition ' + (ti + 1);
      if (!t || typeof t !== 'object' || Array.isArray(t)) {
        throw fail(400, 'FLOW_INVALID', label + ': must be an object.');
      }
      // LET A FUNCTION DECIDE: `decide` names a registered function (event
      // 'decide') that returns the next step; `targets`, optional, are the
      // steps it may choose from. Its own arrow has no single target.
      if (t.decide !== undefined && t.decide !== null && t.decide !== '') {
        var fn = String(t.decide).trim();
        if (!FUNCTION_NAME.test(fn)) throw fail(400, 'FLOW_INVALID', label + ': `decide` must be the name of a registered function, e.g. "routeByAmount".');
        var targets = t.targets === undefined || t.targets === null ? [] : t.targets;
        if (!Array.isArray(targets) || !targets.every(function(x) { return typeof x === 'string' && x.trim(); })) {
          throw fail(400, 'FLOW_INVALID', label + ': `targets` must be a list of step keys the function may choose from.');
        }
        return {
          condition: whenToCondition(t.when, label),
          mode: 'single',
          decide: fn,
          targets: targets.map(function(x) { return x.trim(); }),
          target: null
        };
      }
      var target = String(t.target == null ? '' : t.target).trim();
      if (!target) throw fail(400, 'FLOW_INVALID', label + ': `target` is required — or `decide`, to let a function choose.');
      return {
        condition: whenToCondition(t.when, label),
        // Single, always. `each` fans a transition out into one child run per
        // element, which has no meaning for a person filling in a screen —
        // there is one of them and one run.
        mode: 'single',
        target: target
      };
    });

    if (step.layout !== undefined && step.layout !== null &&
        (typeof step.layout !== 'object' || Array.isArray(step.layout))) {
      throw fail(400, 'FLOW_INVALID', 'step "' + stepKey + '": `layout` must be an object or null.');
    }

    return {
      id: uid(),
      workflowId: workflowId,
      stepKey: stepKey,
      name: typeof step.label === 'string' && step.label.trim() ? step.label.trim().slice(0, 255) : null,
      actionName: SCREEN_ACTION,
      // THE TWO FACTS THAT MAKE A SCREEN A STEP. `wait` is what parks the run
      // and mints the resume key before the action runs; `stop` is the engine
      // default, restated because a flow that walked on past a screen nobody
      // filled in would be worse than one that stopped.
      kind: 'wait',
      onError: 'stop',
      values: { screen: screen },
      transitions: compiled.length ? compiled : null,
      layout: step.layout || null,
      position: index
    };
  });
}

// ── what publishing checks ──────────────────────────────────────────────

/** A function in the app's registry (@xeplr/actions), or null. */
function registered(name) {
  return require('@xeplr/actions').get(name) || null;
}

/**
 * Everything that must be true before a flow can be run, as a list of
 * { stepKey, message } — all of them, not the first one. A designer fixing a
 * flow one refusal at a time is a designer publishing five times.
 */
function validateFlow(steps) {
  var problems = [];
  function problem(stepKey, message) { problems.push({ stepKey: stepKey, message: message }); }

  // A flow with no steps has no first step to start a run at.
  if (!steps.length) {
    problem(null, 'This flow has no screens yet.');
    return problems;
  }

  var byKey = {};
  steps.forEach(function(s) { byKey[s.stepKey] = s; });

  steps.forEach(function(step, index) {
    var values = step.values || {};
    if (!values.screen) problem(step.stepKey, 'No screen is chosen for this step.');

    var transitions = step.transitions || [];

    // No transitions means the engine advances by position — which for the
    // LAST step is "end the run", and for any other step is a fall-through
    // nobody drew. A screen with no way out in the middle of a flow is a
    // missing arrow, not a design.
    if (!transitions.length) {
      if (index !== steps.length - 1) {
        problem(step.stepKey, 'This step has no next screen. Give it a transition, or make it the last step.');
      }
      return;
    }

    var catchAlls = 0;
    transitions.forEach(function(t, ti) {
      if (!t.condition) catchAlls++;
      // First match wins (routeAfterStep), so anything after a catch-all can
      // never be reached.
      if (!t.condition && ti !== transitions.length - 1) {
        problem(step.stepKey, 'The catch-all is not the last transition, so nothing after it can ever run.');
      }
      if (t.target && END_TARGETS.indexOf(t.target) === -1 && !byKey[t.target]) {
        problem(step.stepKey, 'Transition ' + (ti + 1) + ' goes to "' + t.target + '", which is not a step of this flow.');
      }
      if (t.decide) {
        var def = registered(t.decide);
        if (!def) problem(step.stepKey, 'Transition ' + (ti + 1) + ' lets "' + t.decide + '" decide, but no function of that name is registered.');
        else if (def.event !== 'decide') problem(step.stepKey, 'Transition ' + (ti + 1) + ' lets "' + t.decide + '" decide, but it is written for ' + (def.event ? '"' + def.event + '"' : 'a workflow step') + ', not "decide".');
        (t.targets || []).forEach(function(x) {
          if (END_TARGETS.indexOf(x) === -1 && !byKey[x]) problem(step.stepKey, 'Transition ' + (ti + 1) + ': "' + t.decide + '" may choose "' + x + '", which is not a step of this flow.');
        });
      }
    });
    if (catchAlls > 1) {
      problem(step.stepKey, 'This step has ' + catchAlls + ' catch-alls; only the first could ever match.');
    }
  });

  // Every run starts at the first step, so a step nothing points at is a
  // screen no one will ever see. Reported rather than pruned — an unreachable
  // step is usually an arrow somebody forgot to draw, not a step they meant to
  // delete.
  var reachable = {};
  var queue = [steps[0].stepKey];
  while (queue.length) {
    var key = queue.shift();
    if (reachable[key] || !byKey[key]) continue;
    reachable[key] = true;
    (byKey[key].transitions || []).forEach(function(t) {
      if (t.target && END_TARGETS.indexOf(t.target) === -1) queue.push(t.target);
      // A function may lead to any step it may choose — all of them, when it lists none.
      if (t.decide) (t.targets && t.targets.length ? t.targets : Object.keys(byKey)).forEach(function(x) { if (END_TARGETS.indexOf(x) === -1) queue.push(x); });
    });
  }
  steps.forEach(function(step) {
    if (!reachable[step.stepKey]) {
      problem(step.stepKey, 'Nothing leads to this step, so it can never be shown.');
    }
  });

  return problems;
}

// ── a run, as the app sees it ───────────────────────────────────────────

// The engine's five statuses collapse to the four an app showing screens can
// act on. 'queued' and 'running' are both "the engine still has it"; a flow
// only ever pauses on a screen, so a caller sees 'waiting' or a terminal.
var STATUS = { queued: 'running', running: 'running', waiting: 'waiting', success: 'done', failed: 'failed' };

/**
 * A step's buttons as [{ key, label }], from what was typed: "Approve, Send
 * back" (each its own key and label), a list of those, or the JSON of a list
 * of { key, label } (what a text field makes of one).
 */
function buttonsOf(raw) {
  var list = raw;
  if (typeof list === 'string') {
    var text = list.trim();
    if (text.charAt(0) === '[') { try { list = JSON.parse(text); } catch (e) { list = []; } }
    else list = text ? text.split(',') : [];
  }
  return (Array.isArray(list) ? list : []).map(function(b) {
    if (typeof b === 'string') return { key: b.trim(), label: b.trim() };
    if (b && typeof b === 'object' && b.key) return { key: String(b.key).trim(), label: String(b.label || b.key).trim() };
    return null;
  }).filter(function(b) { return b && b.key; });
}

/**
 * Whether `user` may answer a screen assigned to `role`: no role is anyone in
 * the company (the tenant gate already said they belong), a Super Admin
 * always may, and otherwise the role must be one the user holds.
 */
function mayAnswer(role, user) {
  if (!role) return true;
  var roles = (user && Array.isArray(user.roles)) ? user.roles : [];
  return roles.indexOf('Super Admin') > -1 || roles.indexOf(role) > -1;
}

/**
 * What the run is parked on, and what that step already holds.
 *
 * `values` merges every step run this run has recorded for that step key, in
 * order. Normally that is the one waiting step run and its output is empty —
 * but a flow that loops back to a screen already filled in reopens it with the
 * answers from last time, which is the only behaviour anyone expects.
 */
function runView(run, steps, stepRuns) {
  var status = STATUS[run.status] || run.status;
  var waiting = null;
  for (var i = stepRuns.length - 1; i >= 0; i--) {
    if (stepRuns[i].status === 'waiting') { waiting = stepRuns[i]; break; }
  }

  var view = {
    runId: run.id,
    status: status,
    stepKey: waiting ? waiting.stepKey : null,
    screen: null,
    values: {},
    // WHAT THE FLOW ALREADY KNOWS, for the screen about to be shown: the
    // step's `values` input, resolved. A containment's complaint comes from
    // {steps.d1.output.recordId}, and the person is never asked for it.
    //
    // Read off the STEP RUN rather than the step row, because that is where
    // the resolved input is kept (workflowRunner patches `input` as it parks)
    // — the step row holds the tokens, and a browser has nothing to resolve
    // them with.
    given: {},
    // WHAT THE SCREENS BEFORE THIS ONE SAVED, by screen key — see previousOf.
    previous: {}
  };
  if (!waiting) {
    if (run.status === 'failed' && run.error) view.error = run.error;
    return view;
  }

  var step = steps.filter(function(s) { return s.stepKey === waiting.stepKey; })[0];
  view.screen = step && step.values ? (step.values.screen || null) : null;
  // What the step is called, for a page's title: "Review the unmatched lines".
  view.stepName = step ? (step.name || step.stepKey) : waiting.stepKey;
  if (waiting.input && typeof waiting.input.values === 'object' && waiting.input.values !== null) {
    view.given = waiting.input.values;
  }
  // Who answers it and with which buttons, as the step was resolved when it
  // parked (bindings already filled).
  var input = waiting.input || {};
  view.assignTo = input.assignTo || null;
  view.buttons = buttonsOf(input.buttons);

  stepRuns.forEach(function(sr) {
    if (sr.stepKey !== waiting.stepKey) return;
    Object.assign(view.values, sr.output || {});
  });
  view.previous = previousOf(steps, stepRuns, waiting);
  return view;
}

/**
 * THE HAND-OVER BETWEEN SCREENS — what every screen submitted earlier in this
 * run, keyed by the SCREEN's key:
 *
 *   { department_edit: { values: { id: "6f2a…", name: "Finance", … } } }
 *
 * A field on the next screen fills itself from it with a default of
 * `{previous.department_edit.values.name}` (@xeplr/ui-factory). By screen and
 * not by step, because the binding lives ON the screen, and a screen is the
 * same form in every flow that shows it. `id` is the row that screen saved —
 * part of the values, as it is of the row.
 *
 * Nothing is checked: a screen not reached on this run's branch is simply
 * absent, and a binding to it comes out empty. A screen shown twice (a loop)
 * hands over its latest. The step being shown now is not its own "previous".
 */
function previousOf(steps, stepRuns, waiting) {
  var screenOf = {};
  steps.forEach(function(st) {
    if (st.actionName === SCREEN_ACTION && st.values && st.values.screen) screenOf[st.stepKey] = st.values.screen;
  });
  var out = {};
  stepRuns.forEach(function(sr) {
    if (sr.status !== 'success' || (waiting && sr.id === waiting.id)) return;
    var screen = screenOf[sr.stepKey];
    if (!screen) return;
    var values = Object.assign({}, sr.output || {});
    if (values.recordId !== undefined) { values.id = values.recordId; delete values.recordId; }
    out[screen] = { values: values };
  });
  return out;
}

async function stepRunsOf(runId) {
  return db.model('WorkflowStepRun').query().where({ runId: runId }).orderBy('recordCreatedDate', 'asc');
}

/**
 * A run of a flow, or a 404.
 *
 * Tenant-scoped by query(), and that IS the isolation: a runId from another
 * company simply is not there, and every route below goes through here before
 * it touches anything.
 */
async function loadRun(runId) {
  var run = await db.model('WorkflowRun').query().findById(runId);
  if (!run) throw fail(404, 'RUN_NOT_FOUND', 'No run "' + runId + '".');
  var flow = await db.model('Workflow').query().findById(run.workflowId);
  if (!flow) throw fail(404, 'RUN_NOT_FOUND', 'No run "' + runId + '".');
  return { run: run, flow: flow };
}

/**
 * ANY workflow's run, not just a flow's.
 *
 * This used to demand kind 'screens', which made a screen inside an ORDINARY
 * workflow a trap: the engine parks the run correctly — it is a wait step
 * like any other — but nothing could ever submit it, because the two routes
 * that show and resume a screen answered 404 for it. A step that can be drawn
 * and can never be finished is worse than one that cannot be drawn.
 *
 * A flow of screens is still designed, validated and published through the
 * facade's own routes (loadFlow, and those keep the kind gate). This is only
 * about a RUN that is sitting on a screen, whichever kind of workflow put it
 * there.
 *
 * The isolation is unchanged and is what it always was: query() is tenant
 * scoped, so a runId from another company is simply not there.
 */

// ── the services the router is a thin wrapper over ──────────────────────

/** GET /flows */
async function listFlows() {
  var flows = await db.model('Workflow').query().where({ kind: FLOW_KIND }).orderBy('name');
  if (!flows.length) return [];
  var steps = await db.model('WorkflowStep').query()
    .whereIn('workflowId', flows.map(function(f) { return f.id; }));
  var counts = {};
  steps.forEach(function(s) { counts[s.workflowId] = (counts[s.workflowId] || 0) + 1; });
  return flows.map(function(f) { return flowSummary(f, counts[f.id] || 0); });
}

/** POST /flows */
async function createFlow(body) {
  body = body || {};
  var key = normaliseKey(body.key);
  var name = String(body.name == null ? '' : body.name).trim() || key;

  var existing = await db.model('Workflow').query().where({ key: key }).first();
  if (existing) throw fail(409, 'FLOW_KEY_TAKEN', 'A flow keyed "' + key + '" already exists.');

  var flow = await db.model('Workflow').query().insert({
    id: uid(),
    key: key,
    name: name,
    kind: FLOW_KIND,
    status: 'draft'
  });
  return flowSummary(flow, 0);
}

/** GET /flows/:key */
async function getFlow(key) {
  var flow = await loadFlow(key);
  return flowView(flow, await loadSteps(flow.id));
}

/**
 * PUT /flows/:key — replace the steps of a DRAFT.
 *
 * A published flow is refused rather than edited. A run in flight is parked on
 * a step row by id; rewriting those rows underneath it would move a person
 * from the screen they are looking at to whatever now sits at that position,
 * with no record that it happened. Publishing a new version is the edit.
 */
async function putFlow(key, body) {
  body = body || {};
  var flow = await loadFlow(key);
  if (flow.status !== 'draft') {
    throw fail(409, 'FLOW_PUBLISHED', 'This flow is published; publish a new version instead of editing it.');
  }

  var rows = toStepRows(flow.id, body.steps);

  var name = body.name === undefined ? null : String(body.name == null ? '' : body.name).trim();
  if (name !== null) {
    if (!name) throw fail(400, 'FLOW_INVALID', '`name` cannot be blank.');
    await db.model('Workflow').query().findById(flow.id).patch({ name: name });
    flow.name = name;
  }

  // HARD delete, not the soft one the document routes use: workflow_steps'
  // unique index is (workflowId, stepKey) and it does not care about
  // isActive, so a soft-deleted step would block a design that still uses its
  // key — which is most of them.
  await db.model('WorkflowStep').query().delete().where({ workflowId: flow.id });
  for (var i = 0; i < rows.length; i++) {
    await db.model('WorkflowStep').query().insert(rows[i]);
  }

  return flowView(flow, await loadSteps(flow.id));
}

/**
 * POST /flows/:key/publish
 *
 * Idempotent: publishing an already-published flow answers with it rather than
 * refusing, because a double click is not a mistake worth an error.
 */
async function publishFlow(key) {
  var flow = await loadFlow(key);
  var steps = await loadSteps(flow.id);
  if (flow.status === 'published') return flowSummary(flow, steps.length);

  var problems = validateFlow(steps);
  if (problems.length) {
    throw fail(400, 'FLOW_INVALID', 'This flow cannot be published yet: ' + problems[0].message, problems);
  }

  await db.model('Workflow').query().findById(flow.id).patch({ status: 'published' });
  flow.status = 'published';
  return flowSummary(flow, steps.length);
}

/**
 * POST /flows/:key/runs
 *
 * A DRAFT IS REFUSED. Everything publish checks — a screen on every step, a
 * target that exists, a way out of every screen — is what stops a run failing
 * halfway through in front of whoever was filling it in. Publishing is cheap;
 * a half-designed run in someone's hands is not.
 */
async function startFlowRun(key, body, user) {
  var flow = await loadRunnable(key);
  // PUBLISHING IS A SCREENS-FLOW IDEA. There, publish is what checks that
  // every step names a screen and every branch leads somewhere — the thing
  // that stops a run failing halfway through in front of whoever is filling
  // it in, and the facade's PUT is the only way its steps get written.
  //
  // A workflow drawn in the designer has no such gate anywhere else: POST
  // /workflows/:id/run starts one as it is. Demanding a status it is never
  // given would make every flow this app draws unrunnable, which is a trap
  // rather than a safeguard.
  if (flow.kind === FLOW_KIND && flow.status !== 'published') {
    throw fail(409, 'FLOW_NOT_PUBLISHED', 'This flow is still a draft — publish it before starting a run.');
  }
  var run;
  try {
    run = await workflowRunner.startRun(flow.id, (body && body.params) || {}, { user: user, trigger: 'flow' });
  } catch (err) {
    throw fail(400, err.code || 'RUN_NOT_STARTED', err.message, err.details);
  }
  return runView(run, await versions.stepsForRun(run), await stepRunsOf(run.id));
}

/** GET /flows/runs/:runId */
async function getRun(runId) {
  var loaded = await loadRun(runId);
  // The steps the run started with: a design saved since must not rename,
  // or lose, the screen it is parked on (lib/versions.js).
  return runView(loaded.run, await versions.stepsForRun(loaded.run), await stepRunsOf(runId));
}

/**
 * POST /flows/runs/:runId/submit
 *
 * THE RESUME KEY NEVER LEAVES THE SERVER. The engine's own resume route is
 * public by design — a key arrives from an email client with no token — but a
 * screen is submitted by somebody who is signed in and looking at the run, so
 * this route is gated like every other and looks the key up from the run.
 * A browser holding a resume key could resume a run it was never shown.
 *
 * `recordId` is kept on the step's output beside the submitted values: the app
 * has already written the record to its own table, and a later step (or a
 * transition) that needs to point at it can read `output.recordId` like any
 * other field.
 */
async function submitRun(runId, body, opts) {
  body = body || {};
  var values = body.values === undefined || body.values === null ? {} : body.values;
  if (typeof values !== 'object' || Array.isArray(values)) {
    throw fail(400, 'SUBMIT_INVALID', '`values` must be an object.');
  }

  var loaded = await loadRun(runId);
  if (loaded.run.status !== 'waiting') {
    throw fail(409, 'RUN_NOT_WAITING', 'This run is not waiting on a screen (it is ' + (STATUS[loaded.run.status] || loaded.run.status) + ').');
  }

  var pending = await db.model('WorkflowResumeKey').query()
    .where({ runId: runId, consumedDate: null }).first();
  if (!pending) {
    throw fail(409, 'RUN_NOT_WAITING', 'This run has no screen waiting to be submitted.');
  }

  // ONLY A SCREEN IS SUBMITTED HERE. Now that a run of any workflow can reach
  // this route, "waiting" is no longer the same thing as "waiting for a
  // person": a step can be parked on an email that has not arrived or a
  // callback nobody has made, and those are resumed by whatever they are
  // waiting FOR, through the engine's own resume route and its key. Letting a
  // signed-in browser post values to one would let somebody standing in front
  // of a run hand it the answer it was waiting for the world to give.
  var steps = await versions.stepsForRun(loaded.run);
  // By id, which is what the resume key carries (0007) — a step key is only
  // unique within a workflow, and the key row points at the row.
  var waitingOn = steps.filter(function(st) { return st.id === pending.stepId; })[0];
  if (waitingOn && waitingOn.actionName !== SCREEN_ACTION) {
    throw fail(409, 'NOT_A_SCREEN',
      'This run is waiting on "' + (waitingOn.name || waitingOn.stepKey) + '", which is not a screen — ' +
      'it resumes when what it is waiting for happens.');
  }

  // WHO MAY ANSWER, AND WITH WHICH BUTTON — as the step was resolved when it
  // parked. A screen for "Accounts" is not answered by whoever has the link.
  var parked = await db.model('WorkflowStepRun').query()
    .where({ runId: runId, stepId: pending.stepId, status: 'waiting' }).orderBy('recordCreatedDate', 'desc').first();
  var parkedInput = (parked && parked.input) || {};
  if (!mayAnswer(parkedInput.assignTo, opts && opts.user)) {
    throw fail(403, 'NOT_YOURS', 'This screen is for ' + parkedInput.assignTo + '. Someone with that role answers it.');
  }
  var buttons = buttonsOf(parkedInput.buttons);
  var action = body.action === undefined || body.action === null ? null : String(body.action);
  if (buttons.length) {
    if (!action) throw fail(400, 'ACTION_REQUIRED', 'Say which button was pressed: ' + buttons.map(function(b) { return b.key; }).join(', ') + '.');
    if (!buttons.some(function(b) { return b.key === action; })) {
      throw fail(400, 'ACTION_UNKNOWN', '"' + action + '" is not a button of this screen. Buttons: ' + buttons.map(function(b) { return b.key; }).join(', ') + '.');
    }
  }

  var output = Object.assign({}, values);
  if (body.recordId !== undefined && body.recordId !== null) {
    output.recordId = body.recordId;
  }
  // The button pressed is the step's output.action, which its arrows test.
  if (action) output.action = action;

  try {
    await workflowRunner.resumeByKey(pending.key, output);
  } catch (err) {
    // RESUME_KEY_NOT_READY is the one worth retrying — the step's action has
    // not finished parking yet. Passed through with its own code rather than
    // flattened, so a client can tell "try again in a moment" from "this was
    // already submitted".
    throw fail(err.code === 'RESUME_KEY_NOT_READY' ? 409 : 400, err.code || 'SUBMIT_FAILED', err.message);
  }

  var run = await db.model('WorkflowRun').query().findById(runId);
  return runView(run, await versions.stepsForRun(run), await stepRunsOf(runId));
}

/**
 * GET /flows/:key/runs?mine=1 — what is still in progress, newest first.
 *
 * `mine=1` is "started by me", which is what an app showing somebody their own
 * unfinished work means by it. Without a signed-in user it is an empty list
 * rather than everybody's runs — the safer reading of an unanswerable question.
 */
async function listRuns(key, opts) {
  opts = opts || {};
  var flow = await loadRunnable(key);

  var query = db.model('WorkflowRun').query()
    .where({ workflowId: flow.id })
    .whereIn('status', LIVE_RUN_STATUSES)
    .orderBy('recordCreatedDate', 'desc');
  if (opts.mine) {
    if (!opts.userId) return [];
    query = query.where({ recordCreatedBy: opts.userId });
  }
  var runs = await query;
  if (!runs.length) return [];

  var steps = await loadSteps(flow.id);
  var stepRuns = await db.model('WorkflowStepRun').query()
    .whereIn('runId', runs.map(function(r) { return r.id; }))
    .orderBy('recordCreatedDate', 'asc');
  var byRun = {};
  stepRuns.forEach(function(sr) { (byRun[sr.runId] = byRun[sr.runId] || []).push(sr); });

  return runs.map(function(run) {
    var view = runView(run, steps, byRun[run.id] || []);
    return {
      runId: view.runId,
      status: view.status,
      stepKey: view.stepKey,
      screen: view.screen,
      startedAt: run.startedAt || run.recordCreatedDate || null
    };
  });
}

/**
 * GET /flows/waiting — every screen waiting for a person, in any workflow of
 * this company, that `user` may answer: assigned to a role they hold, or to
 * anyone. Oldest first, so what has waited longest is at the top.
 *
 * The "waiting for you" list. A screen in an ordinary workflow had no place
 * anybody would find it: only the flow's own runs could be listed, and only
 * by who started them.
 */
async function listWaiting(opts) {
  opts = opts || {};
  var stepRuns = await db.model('WorkflowStepRun').query()
    .where({ status: 'waiting', actionName: SCREEN_ACTION })
    .orderBy('recordCreatedDate', 'asc');
  if (!stepRuns.length) return [];
  var runs = await db.model('WorkflowRun').query()
    .whereIn('id', stepRuns.map(function(sr) { return sr.runId; }))
    .where({ status: 'waiting' });
  var runById = {};
  runs.forEach(function(r) { runById[r.id] = r; });
  var workflows = runs.length ? await db.model('Workflow').query().whereIn('id', runs.map(function(r) { return r.workflowId; })) : [];
  var wfById = {};
  workflows.forEach(function(w) { wfById[w.id] = w; });
  var steps = workflows.length ? await db.model('WorkflowStep').query().whereIn('workflowId', workflows.map(function(w) { return w.id; })) : [];
  var stepById = {};
  steps.forEach(function(st) { stepById[st.id] = st; });

  var out = [];
  stepRuns.forEach(function(sr) {
    var run = runById[sr.runId];
    if (!run) return;
    var input = sr.input || {};
    if (!mayAnswer(input.assignTo, opts.user)) return;
    var step = stepById[sr.stepId] || {};
    var wf = wfById[run.workflowId] || {};
    out.push({
      runId: run.id,
      workflowId: run.workflowId,
      workflowName: wf.name || null,
      stepKey: sr.stepKey,
      stepName: step.name || sr.stepKey,
      screen: input.screen || null,
      assignTo: input.assignTo || null,
      buttons: buttonsOf(input.buttons),
      period: run.triggerData && run.triggerData.window ? run.triggerData.window : null,
      waitingSince: sr.recordCreatedDate
    });
  });
  return out;
}

// ── keeping the workflow document's routes off a flow ───────────────────

/**
 * Does this POST /workflows/save body touch a 'screens' workflow, or try to
 * create one? True means refuse it (SCREENS_EDIT_MESSAGE says why).
 *
 * Not a permission check — whoever is here is allowed to edit workflows. It is
 * that these particular rows are GENERATED from a design held elsewhere, so a
 * hand edit survives only until the next PUT /flows/:key and then vanishes
 * with no record. Refusing is the only outcome that does not lose work.
 * The API's route turns `true` into a 400.
 */
async function touchesScreens(body) {
  var entries = Array.isArray(body) ? body : (body ? [body] : []);
  // Creating one here is refused for the same reason editing one is: a flow
  // whose steps this facade did not generate is a flow the designer cannot
  // open.
  if (entries.some(function(e) { return e && e.kind === FLOW_KIND; })) return true;

  var ids = entries.map(function(e) { return e && e.id; }).filter(Boolean);
  if (!ids.length) return false;

  var rows = await db.model('Workflow').query().whereIn('id', ids);
  return rows.some(function(r) { return r.kind === FLOW_KIND; });
}

module.exports = {
  FLOW_KIND: FLOW_KIND,
  SCREEN_ACTION: SCREEN_ACTION,
  SCREENS_EDIT_MESSAGE: SCREENS_EDIT_MESSAGE,
  OPS: OPS,
  operators: operators,

  // Pure, and exported for their own sake — the translation between what a
  // designer says and what the engine evaluates is the part of this module
  // that can be wrong without anything failing loudly.
  whenToCondition: whenToCondition,
  comparisonNode: comparisonNode,
  fail: fail,
  END_TARGETS: END_TARGETS,
  conditionToWhen: conditionToWhen,
  previousOf: previousOf,
  toStepRows: toStepRows,
  validateFlow: validateFlow,
  runView: runView,

  listFlows: listFlows,
  createFlow: createFlow,
  getFlow: getFlow,
  putFlow: putFlow,
  publishFlow: publishFlow,
  startFlowRun: startFlowRun,
  getRun: getRun,
  submitRun: submitRun,
  listRuns: listRuns,
  listWaiting: listWaiting,
  buttonsOf: buttonsOf,
  mayAnswer: mayAnswer,

  touchesScreens: touchesScreens
};

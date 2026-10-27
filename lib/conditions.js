// AN ARROW'S CONDITION, WRITTEN SIMPLY.
//
// The engine evaluates conditions as nodes — { left: { field }, op: 'eq',
// right: { value } }. A screen of anyone's (the jobs screen's "After this
// job", an app built on this API) can instead write an arrow's `when`:
//
//   { "field": "trigger.status", "op": "=", "value": "success" }
//   { "all": [ … ] }   { "any": [ … ] }   null — "otherwise"
//
// and the engine compiles it into `condition` when the step is saved
// (models/WorkflowStep.js), keeping `when` beside it so a screen reads back
// exactly what it wrote. One compiler, here — the comparisons are the flows
// facade's (flows.comparisonNode), so `=` means one thing everywhere.
var flows = require('./flows');

var FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+)*$/;

function invalid(message) {
  var err = flows.fail(400, 'CONDITION_INVALID', message);
  // A model validation error by name, so the generic save answers it as one.
  err.name = 'ValidationError';
  err.type = 'ModelValidation';
  err.statusCode = 400;
  err.data = { transitions: [{ message: message, keyword: 'when' }] };
  return err;
}

/** `when` → the engine's condition node; null/undefined → null ("otherwise"). */
function whenToCondition(when, where) {
  where = where || 'This condition';
  if (when === null || when === undefined) return null;
  if (typeof when !== 'object' || Array.isArray(when)) {
    throw invalid(where + ': the condition must be an object such as ' +
      '{ "field": "trigger.status", "op": "=", "value": "success" }, or empty for "otherwise".');
  }
  if (when.all !== undefined || when.any !== undefined) {
    var key = when.all !== undefined ? 'all' : 'any';
    var list = when[key];
    if (!Array.isArray(list) || !list.length) throw invalid(where + ': `' + key + '` needs a non-empty list of conditions.');
    var group = {};
    group[key] = list.map(function(c, i) {
      var node = whenToCondition(c, where + ', ' + key + ' ' + (i + 1));
      if (!node) throw invalid(where + ': an empty condition inside `' + key + '`.');
      return node;
    });
    return group;
  }
  var field = String(when.field == null ? '' : when.field).trim();
  if (!field) throw invalid(where + ': `field` is required — e.g. "trigger.status" or "output.rowsMoved".');
  if (!FIELD_PATTERN.test(field)) throw invalid(where + ': "' + field + '" is not a usable field.');
  try {
    return flows.comparisonNode(when, where, field, 'CONDITION_INVALID');
  } catch (err) {
    throw invalid(err.message);
  }
}

/**
 * A step's transitions with every `when` compiled into its `condition`.
 * Transitions without `when` are left exactly as they are.
 */
function compileTransitions(transitions, stepName) {
  if (!Array.isArray(transitions)) return transitions;
  return transitions.map(function(t, i) {
    var where = (stepName ? 'Step "' + stepName + '"' : 'A step') + ', arrow ' + (i + 1);
    checkArrow(t, where);
    if (t.when === undefined) return t;
    var out = Object.assign({}, t);
    out.condition = whenToCondition(t.when, where);
    return out;
  });
}

// What an arrow may be. Each of these used to save and then fail on the live
// run instead: an "each" arrow without its list matched nothing, and the run
// ended with "No transition matched" (workflowRunner's routeAfterStep).
var ARROW_MODES = ['single', 'each'];
var SOURCE_ROOTS = ['output', 'item', 'params', 'trigger'];

function invalidArrow(message) {
  var err = invalid(message);
  err.code = 'TRANSITION_INVALID';
  err.data = { transitions: [{ message: message, keyword: 'transition' }] };
  return err;
}

/** Refuses an arrow the runner could not follow, naming the step and arrow. */
function checkArrow(t, where) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw invalidArrow(where + ': an arrow must be an object such as { "target": "next-step" }.');
  if (t.mode !== undefined && t.mode !== null && ARROW_MODES.indexOf(t.mode) === -1) {
    throw invalidArrow(where + ': "' + t.mode + '" is not a kind of arrow. Kinds: ' + ARROW_MODES.join(', ') + '.');
  }
  if (t.decide !== undefined && t.decide !== null) {
    if (typeof t.decide !== 'string' || !t.decide.trim()) throw invalidArrow(where + ': `decide` names a registered function.');
    if (t.mode === 'each') throw invalidArrow(where + ': an arrow either lets a function decide or goes through a list, not both.');
    if (t.targets !== undefined && t.targets !== null &&
        (!Array.isArray(t.targets) || t.targets.some(function(k) { return typeof k !== 'string' || !k; }))) {
      throw invalidArrow(where + ': `targets` is a list of step keys.');
    }
    return;
  }
  if (typeof t.target !== 'string' || !t.target.trim()) throw invalidArrow(where + ': say where it goes (`target`): a step key, end_success or end_failed.');
  if (t.mode === 'each') {
    if (t.limit !== undefined && t.limit !== null && !(Number.isInteger(t.limit) && t.limit >= 1 && t.limit <= 1000)) {
      throw invalidArrow(where + ': `limit` is how many items run at once, a whole number from 1 to 1000.');
    }
    var source = typeof t.source === 'string' ? t.source.trim() : '';
    if (!source) throw invalidArrow(where + ': an arrow for each item needs the list to go through (`source`), e.g. "output.rows".');
    if (!FIELD_PATTERN.test(source) || SOURCE_ROOTS.indexOf(source.split('.')[0]) === -1) {
      throw invalidArrow(where + ': "' + source + '" is not a list it can read. Start it with ' + SOURCE_ROOTS.join(', ') + ', e.g. "output.rows".');
    }
  }
}

// ── leaving and arriving (migrations/0020) ─────────────────────────────

var LEAVE = ['first', 'every'];
var OTHERS = ['cancel', 'finish'];

function invalidFlow(field, message) {
  var err = invalid(message);
  err.code = 'STEP_FLOW_INVALID';
  var data = {};
  data[field] = [{ message: message, keyword: field }];
  err.data = data;
  return err;
}

/**
 * A step that opens a path for every matching arrow cannot also go through a
 * list: an "each" arrow starts child runs and ends this run's own progress,
 * which leaves the other paths of the split with nowhere to meet.
 */
function checkLeave(leave, transitions, stepName) {
  var where = stepName ? 'Step "' + stepName + '"' : 'A step';
  if (leave === undefined || leave === null) return;
  if (LEAVE.indexOf(leave) === -1) throw invalidFlow('leave', where + ': "' + leave + '" is not a way to leave a step. Ways: ' + LEAVE.join(', ') + '.');
  if (leave === 'every' && Array.isArray(transitions) && transitions.some(function(t) { return t && t.mode === 'each'; })) {
    throw invalidFlow('leave', where + ': a step that follows every matching arrow cannot also have an arrow for each item. ' +
      'Put the list on a step of its own.');
  }
}

/**
 * A meeting point, checked and with its `stopWhen` compiled the way an
 * arrow's `when` is. `stopWhen` reads `arrivals` — `arrivals.rejected`,
 * `arrivals.approved`, `arrivals.arrived`, `arrivals.expected`.
 */
function compileJoin(join, stepName) {
  var where = stepName ? 'Step "' + stepName + '"' : 'A step';
  if (join === null || join === undefined) return join;
  if (typeof join !== 'object' || Array.isArray(join)) {
    throw invalidFlow('join', where + ': a meeting point is an object such as { "wait": "all" }.');
  }
  var wait = join.wait === undefined || join.wait === null ? 'all' : join.wait;
  var atLeast = wait && typeof wait === 'object' ? wait.atLeast : null;
  if (wait !== 'all' && wait !== 'any' && !(Number.isInteger(atLeast) && atLeast >= 1 && atLeast <= 1000)) {
    throw invalidFlow('join', where + ': `wait` is "all", "any", or { "atLeast": N } with N a whole number from 1.');
  }
  if (join.others !== undefined && join.others !== null && OTHERS.indexOf(join.others) === -1) {
    throw invalidFlow('join', where + ': `others` is what happens to the paths still open when it runs: ' + OTHERS.join(' or ') + '.');
  }
  var out = Object.assign({}, join, { wait: wait });
  if (join.stopWhen !== undefined && join.stopWhen !== null) {
    out.stopCondition = whenToCondition(join.stopWhen, where + ', stop early when');
  } else {
    delete out.stopCondition;
  }
  return out;
}

module.exports = {
  whenToCondition: whenToCondition, compileTransitions: compileTransitions, checkArrow: checkArrow, ARROW_MODES: ARROW_MODES,
  compileJoin: compileJoin, checkLeave: checkLeave
};

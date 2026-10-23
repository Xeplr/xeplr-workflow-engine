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
    if (!t || typeof t !== 'object' || t.when === undefined) return t;
    var out = Object.assign({}, t);
    out.condition = whenToCondition(t.when, (stepName ? 'Step "' + stepName + '"' : 'A step') + ', arrow ' + (i + 1));
    return out;
  });
}

module.exports = { whenToCondition: whenToCondition, compileTransitions: compileTransitions };

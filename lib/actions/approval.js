// approval — ASK ONE OR MORE PEOPLE TO APPROVE, AND WAIT FOR THE RULE.
//
// A `wait` step. When it parks, the engine opens one task per approver
// (lib/tasks.js); each answers Approve or Reject from their inbox, and the
// step goes on when the rule is met:
//
//   need      all (default) · any · { atLeast: N }
//   order     together (default) — every approver at once
//             inTurn — the next one's task opens only when the one before approves
//   onReject  stop (default) — the first reject decides it
//             collect — wait for everyone (or until enough have approved)
//
// The step's output is what its arrows read:
//
//   { decision: 'approved' | 'rejected', approved: 2, rejected: 0,
//     answers: [{ by, role, decision, comment, at }] }
//
// The rule is the meeting point's, counted over tasks instead of paths: an
// approval is one box a designer draws, not a split they have to wire.
//
// This action only checks what it was given — who approves, and that the rule
// can be met by them. Opening the tasks happens as the step parks, because a
// task belongs to the step run and its key, which exist only then.

var NEEDS = ['all', 'any'];

/** "QA Head, user:u_7" or [{ role }, { user }] → [{ role } | { user }]. */
function approversOf(raw) {
  // A binding to a list arrives as its JSON: the field is text for a designer
  // typing "QA Head, Production Head", and a text field gets text.
  if (typeof raw === 'string' && raw.trim().charAt(0) === '[') {
    try { raw = JSON.parse(raw); } catch (e) { /* not a list after all: read it as names */ }
  }
  var list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : []);
  return list.map(function(a) {
    if (a && typeof a === 'object') {
      if (a.user) return { user: String(a.user) };
      if (a.role) return { role: String(a.role) };
      return null;
    }
    var text = String(a == null ? '' : a).trim();
    if (!text) return null;
    return text.indexOf('user:') === 0 ? { user: text.slice(5).trim() } : { role: text };
  }).filter(Boolean);
}

/** How many approvals the rule needs from `count` approvers. */
function needed(need, count) {
  if (need === 'any') return 1;
  if (need && typeof need === 'object') return need.atLeast;
  return count;
}

function check(input) {
  var approvers = approversOf(input.approvers);
  if (!approvers.length) throw new Error('Say who approves: a role such as "QA Head", or "user:<id>".');
  var need = input.need === undefined || input.need === null || input.need === '' ? 'all' : input.need;
  if (typeof need === 'string' && /^\d+$/.test(need)) need = { atLeast: Number(need) };
  var atLeast = need && typeof need === 'object' ? need.atLeast : null;
  if (NEEDS.indexOf(need) === -1 && !(Number.isInteger(atLeast) && atLeast >= 1)) {
    throw new Error('`need` is "all", "any", or a number of approvals.');
  }
  if (atLeast && atLeast > approvers.length) {
    throw new Error('It needs ' + atLeast + ' approvals but only ' + approvers.length + ' people are asked.');
  }
  if (input.order && ['together', 'inTurn'].indexOf(input.order) === -1) throw new Error('`order` is together or inTurn.');
  if (input.onReject && ['stop', 'collect'].indexOf(input.onReject) === -1) throw new Error('`onReject` is stop or collect.');
  return { approvers: approvers, need: need };
}

module.exports = {
  name: 'approval',
  description: 'Ask one or more people or roles to approve, and wait until enough have — all, any one, ' +
               'or a number of them. Comes out as output.decision: approved or rejected.',
  requires: [],
  inputSchema: [
    // Typed, not picked from the role list: it is a LIST of roles and
    // people, and a one-role picker could neither hold "QA Head, Production
    // Head" nor show a saved value that is not exactly one of its options.
    { name: 'approvers', type: 'string', required: true, order: 1,
      description: 'Who approves, separated by commas: roles such as "QA Head, Production Head", or "user:<id>". One task each.' },
    { name: 'need', type: 'string', default: 'all', order: 2,
      description: 'How many must approve: all, any, or a number.' },
    { name: 'order', type: 'string', default: 'together', order: 3,
      description: 'together: everyone at once. inTurn: one after another, in the order listed.' },
    { name: 'onReject', type: 'string', default: 'stop', order: 4,
      description: 'stop: the first reject decides it. collect: wait for everyone.' },
    { name: 'title', type: 'string', order: 5,
      description: 'What the approver sees in their inbox, e.g. "Deviation on PO 450103 / 10".' },
    { name: 'notSame', type: 'string', order: 6,
      description: 'Steps whose person may not approve here (four eyes), e.g. "inspect". The person who started the case never may.' },
    { name: 'dueInHours', type: 'number', order: 7,
      description: 'Hours each approver has. Past it the host is told (a reminder), and with escalateTo the task moves.' },
    { name: 'escalateTo', type: 'string', order: 8, optionsFrom: 'roles',
      description: 'The role an overdue task moves to, e.g. "Plant Head".' }
  ],
  outputSchema: [
    { name: 'decision', type: 'string' },
    { name: 'approved', type: 'number' },
    { name: 'rejected', type: 'number' },
    { name: 'answers', type: 'array' }
  ],

  execute: async function(ctx) {
    check(ctx.input || {});
    return {};
  },

  approversOf: approversOf,
  needed: needed,
  check: check
};

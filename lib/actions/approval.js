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

/**
 * "QA Head, asha@acme.com" or [{ role }, { email }] → [{ role } | { email }].
 * Text with an @ is a person, by email (lower-cased); anything else a role.
 * `user:<id>` / { user } still read, for a caller holding ids.
 */
function approversOf(raw) {
  // A binding to a list arrives as its JSON: the field is text for a designer
  // typing "QA Head, Production Head", and a text field gets text.
  if (typeof raw === 'string' && raw.trim().charAt(0) === '[') {
    try { raw = JSON.parse(raw); } catch (e) { /* not a list after all: read it as names */ }
  }
  var list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : []);
  return list.map(function(a) {
    if (a && typeof a === 'object') {
      if (a.email) return { email: String(a.email).trim().toLowerCase() };
      if (a.user) return { user: String(a.user) };
      if (a.role) return { role: String(a.role) };
      return null;
    }
    var text = String(a == null ? '' : a).trim();
    if (!text) return null;
    if (text.indexOf('user:') === 0) return { user: text.slice(5).trim() };
    return text.indexOf('@') > -1 ? { email: text.toLowerCase() } : { role: text };
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
  if (!approvers.length) throw new Error('Say who approves: a role such as "QA Head", or an email address.');
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
    // A LIST of roles and email addresses, kept as text ("QA Head,
    // asha@acme.com"). `pickRoles` asks a designer for a picker that adds
    // roles from the host's role list (optionsFrom: 'roles') and takes typed
    // email addresses; one that does not know it shows a text box.
    { name: 'approvers', type: 'string', required: true, order: 1, pickRoles: true, typeEmails: true,
      description: 'Who approves: roles such as "QA Head", and/or email addresses, separated by commas. One task each.' },
    { name: 'need', type: 'string', default: 'all', order: 2,
      options: [{ value: 'all', label: 'All of them' }, { value: 'any', label: 'Any one' },
        { value: '2', label: 'At least 2' }, { value: '3', label: 'At least 3' }, { value: '4', label: 'At least 4' }, { value: '5', label: 'At least 5' }],
      description: 'How many must approve.' },
    { name: 'order', type: 'string', default: 'together', order: 3,
      options: [{ value: 'together', label: 'Together' }, { value: 'inTurn', label: 'One after another' }],
      description: 'Together: everyone at once. One after another: in the order listed, the next once the one before approves.' },
    { name: 'onReject', type: 'string', default: 'stop', order: 4,
      options: [{ value: 'stop', label: 'Stop at the first reject' }, { value: 'collect', label: 'Wait for everyone' }],
      description: 'Stop at the first reject: it decides the step. Wait for everyone: or until enough have approved.' },
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

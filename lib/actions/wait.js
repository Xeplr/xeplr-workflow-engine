// wait — ONE STEP FOR EVERY KIND OF WAITING THAT IS NOT A PERSON'S TASK.
//
// "Wait until …" with one of three answers, the way a person says it:
//
//   some time has passed   wait 2 hours
//   a date                 wait until the expected delivery date
//   something arrives      a reply, a file in a folder, an email (in the
//                          app's own mailbox)
//
// and, for something arriving, one optional limit: "if it takes longer than
// 3 days", which ends the wait with output.tooLong = true so an arrow of its
// own ("Took too long") can send a reminder and come back.
//
// People's tasks (an approval, a screen) are NOT waited for here: their
// lateness belongs to the task (due dates, reminders), so there is one place
// for "a person is late", not two.
//
// HOW IT WAKES. This action runs once, when the run reaches the step: it
// writes on the step's resume key when to wake it (wakeAt) and what to check
// for (watch), and the run parks as every wait does. lib/waits.js wakes it —
// called from the engine's sweep, the pass that already finds runs nobody is
// moving, so a wait adds no timer of its own — through the same resumeByKey
// every answer goes through, which claims the key in one transaction: two
// processes never both wake it. The step is a wait step whatever it was saved
// as (models/WorkflowStep.js).
var db = require('../db');

var UNITS = { minutes: 60000, hours: 3600000, days: 86400000 };
var DEFAULT_CHECK_MINUTES = 5;

function refuse(message) {
  var err = new Error(message);
  err.code = 'WAIT_INVALID';
  return err;
}

/** n units in milliseconds, or null when not given; refuses nonsense. */
function span(amount, unit, what) {
  if (amount === undefined || amount === null || amount === '') return null;
  var n = Number(amount);
  if (!isFinite(n) || n <= 0) throw refuse(what + ' must be a number above zero, not "' + amount + '".');
  var per = UNITS[unit || 'hours'];
  if (!per) throw refuse(what + ': the unit is minutes, hours or days, not "' + unit + '".');
  return Math.round(n * per);
}

/**
 * The instant a date value means. A whole timestamp is taken as it is; a bare
 * day (2026-12-01) is midnight at the start of that day on this server's
 * clock.
 */
function instantOf(value) {
  if (value instanceof Date) return value;
  var text = String(value == null ? '' : value).trim();
  if (!text) throw refuse('Waiting until a date needs the date.');
  var day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  var at = day ? new Date(+day[1], +day[2] - 1, +day[3]) : new Date(text);
  if (isNaN(at.getTime())) throw refuse('"' + text + '" is not a date this can read. Use 2026-12-01, or a date from an earlier step.');
  return at;
}

/** What to check, for a wait on a file or an email. */
function watchFor(input, startedAt) {
  var everyMs = span(input.checkEveryMinutes || DEFAULT_CHECK_MINUTES, 'minutes', 'Check every');
  if (input.arrives === 'file') {
    if (!input.folder) throw refuse('Waiting for a file needs the folder to look in.');
    var file = { folder: input.folder };
    if (input.named) file.pattern = input.named;
    return { actionName: 'file-list', input: file, everyMs: everyMs };
  }
  if (input.arrives === 'email') {
    // Only mail that came in after the wait began: an old message in the
    // inbox is not the one being waited for.
    var mail = { folder: input.mailboxFolder || 'INBOX', since: startedAt, limit: 20 };
    if (input.fromContains) mail.from_contains = input.fromContains;
    if (input.subjectContains) mail.subject_contains = input.subjectContains;
    return { actionName: 'email-read', input: mail, everyMs: everyMs };
  }
  return null;
}

module.exports = {
  name: 'wait',
  label: 'Wait',
  description: 'Wait until some time has passed, until a date, or until something arrives (a reply, a file, an email).',
  inputSchema: [
    { name: 'until', label: 'Wait until', type: 'string', default: 'time', order: 1,
      options: [
        { value: 'time', label: 'some time has passed' },
        { value: 'date', label: 'a date' },
        { value: 'arrival', label: 'something arrives' }
      ] },
    { name: 'amount', label: 'How long', type: 'number', default: 1, order: 2, showWhen: { until: 'time' } },
    { name: 'unit', label: 'Unit', type: 'string', default: 'hours', order: 3, showWhen: { until: 'time' },
      options: ['minutes', 'hours', 'days'] },
    { name: 'date', label: 'The date', type: 'string', order: 4, showWhen: { until: 'date' },
      description: 'A date from an earlier step, or one typed in (2026-12-01).' },
    { name: 'arrives', label: 'What arrives', type: 'string', default: 'reply', order: 5, showWhen: { until: 'arrival' },
      options: [
        { value: 'reply', label: 'a reply' },
        { value: 'file', label: 'a file' },
        { value: 'email', label: 'an email' }
      ] },
    { name: 'folder', label: 'In the folder', type: 'string', order: 6, showWhen: { arrives: 'file' } },
    { name: 'named', label: 'Named like', type: 'string', order: 7, showWhen: { arrives: 'file' },
      description: 'Optional: *.csv, invoice-*.pdf' },
    { name: 'fromContains', label: 'From', type: 'string', order: 9, showWhen: { arrives: 'email' },
      description: 'Optional: part of the sender\'s address.' },
    { name: 'subjectContains', label: 'Subject has', type: 'string', order: 10, showWhen: { arrives: 'email' } },
    { name: 'tooLongAmount', label: 'If it takes longer than', type: 'number', order: 11, showWhen: { until: 'arrival' },
      description: 'Optional. Then the step follows its "Took too long" arrow.' },
    { name: 'tooLongUnit', label: 'Unit', type: 'string', default: 'days', order: 12, showWhen: { until: 'arrival' },
      options: ['minutes', 'hours', 'days'] },
    { name: 'checkEveryMinutes', label: 'Check every (minutes)', type: 'number', default: DEFAULT_CHECK_MINUTES,
      order: 13, group: 'More', showWhen: { until: 'arrival' } },
    { name: 'mailboxFolder', label: 'Mail folder', type: 'string', default: 'INBOX', order: 14, group: 'More',
      showWhen: { arrives: 'email' } }
  ],
  outputSchema: [
    { name: 'waited', type: 'boolean', description: 'The time or the date was reached.' },
    { name: 'arrived', type: 'boolean', description: 'What was waited for arrived.' },
    { name: 'tooLong', type: 'boolean', description: 'It took longer than allowed — the "Took too long" arrow.' },
    { name: 'files', type: 'array', description: 'A file arrived: [{ name, path, size, modifiedAt }].' },
    { name: 'messages', type: 'array', description: 'An email arrived: the messages.' },
    { name: 'reply', type: 'object', description: 'A reply arrived: what was sent with it.' }
  ],
  // An example of what it hands on, for the designer's pickers (catalog `example`).
  example: { arrived: true, tooLong: false, files: [{ name: 'quote.pdf', path: 'inbox/quote.pdf' }] },

  execute: async function(ctx) {
    var input = ctx.input || {};
    var system = ctx.system || {};
    if (!system.resumeKey) throw refuse('A Wait step parks the run, so it must be saved as a wait step.');
    var now = new Date();
    var patch = { wakeAt: null, wakeOutput: null, watch: null, nextCheckAt: null };
    var output = { since: now.toISOString() };
    var until = input.until || 'time';

    if (until === 'time') {
      var ms = span(input.amount === undefined ? 1 : input.amount, input.unit, 'How long');
      patch.wakeAt = new Date(now.getTime() + ms).toISOString();
      patch.wakeOutput = { waited: true, arrived: false, tooLong: false };
      output.waiting = 'time';
      output.until = patch.wakeAt;
    } else if (until === 'date') {
      patch.wakeAt = instantOf(input.date).toISOString();
      patch.wakeOutput = { waited: true, arrived: false, tooLong: false };
      output.waiting = 'date';
      output.until = patch.wakeAt;
    } else if (until === 'arrival') {
      var arrives = input.arrives || 'reply';
      if (['reply', 'file', 'email'].indexOf(arrives) === -1) throw refuse('What arrives is a reply, a file or an email, not "' + arrives + '".');
      var watch = watchFor(Object.assign({}, input, { arrives: arrives }), now.toISOString());
      if (watch) { patch.watch = watch; patch.nextCheckAt = now.toISOString(); }
      var tooLong = span(input.tooLongAmount, input.tooLongUnit || 'days', 'If it takes longer than');
      if (tooLong) {
        patch.wakeAt = new Date(now.getTime() + tooLong).toISOString();
        patch.wakeOutput = { waited: false, arrived: false, tooLong: true };
        output.tooLongAt = patch.wakeAt;
      }
      output.waiting = arrives;
      // Where a reply is sent: POST <this address> { output }. The run page
      // shows it; null when the host has no public address configured.
      if (arrives === 'reply') output.replyLink = system.resumeUrl || null;
    } else {
      throw refuse('Wait until is "time", "date" or "arrival", not "' + until + '".');
    }

    var written = await db.model('WorkflowResumeKey').query().where({ key: system.resumeKey }).patch(patch);
    if (!written) throw refuse('The wait could not be recorded on its step.');
    return output;
  },

  UNITS: UNITS,
  instantOf: instantOf
};

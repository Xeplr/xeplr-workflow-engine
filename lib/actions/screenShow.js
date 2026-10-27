// screen-show — PARK THE RUN AND LET A PERSON FILL IN A SCREEN.
//
// The step behind every node of a 'screens' flow (see lib/flows.js). It is a
// `wait` step whose action does nothing at all, and the nothing is the whole
// design:
//
//   1. the engine mints the resume key BEFORE the action runs (see
//      workflowRunner's executeFrom) and parks the run at status 'waiting';
//   2. this returns immediately, so there is nothing to undo and nothing that
//      can fail between "the person opened the screen" and "the run is
//      waiting for them";
//   3. the person submits; POST /flows/runs/:runId/submit resumes the step
//      with what they typed, and resumeByKey MERGES that onto this output.
//
// ── why it returns {} and not { screen } ─────────────────────────────────
//
// The step's output IS the submitted values, and nothing else. Transitions on
// a screens flow read `output.<field>` where <field> is a field of the screen,
// so anything this action put in the output would occupy a name a screen might
// legitimately use — a screen with a field called `screen` would then branch on
// this action's own bookkeeping until the moment it was submitted.
//
// Which screen was shown is not lost by returning nothing: the resolved input
// is persisted on the step run (workflow_step_runs.input), so history records
// it, and the facade reads the screen off the STEP row (values.screen) rather
// than off a run, because that is where the flow's design lives.
//
// ── why it is not in the action palette ──────────────────────────────────
//
// It is registered (the engine resolves a step's actionName through the
// registry, so a step could not run without it) but hidden from GET /actions —
// see lib/actionCatalog.js's HIDDEN. Dropping one onto the ordinary workflow
// canvas would produce a step that parks forever: nothing outside the flows
// facade knows how to show a screen or how to resume it.

module.exports = {
  name: 'screen-show',
  description: 'Show a screen to a person and wait for them to submit it. The values they ' +
               'submit become this step\'s output, so a transition can branch on them.',
  requires: [],

  inputSchema: [
    { name: 'screen', type: 'string', required: true, order: 1,
      description: 'Key of the screen to show. The app that owns the screens resolves it; ' +
                   'this engine only carries it.' },

    // WHAT THE SCREEN OPENS WITH — an ordinary step input, resolved by
    // interpolateAll before this runs, like an email's `to`.
    //
    // A screen can declare that a field is filled in by whoever opens the form
    // (@xeplr/ui-factory's `filledBy: 'caller'`): a containment's complaint is
    // known by the flow and is not a question for the person. This is where
    // the flow answers it — { complaintId: '{steps.d1.output.recordId}' } —
    // and the values arrive already substituted, so the facade hands the app a
    // plain object and nothing downstream knows what a token is.
    //
    // Not called "prefill": it is the step's input, and a screen step is an
    // ordinary step whose action happens to park the run.
    { name: 'values', type: 'object', order: 2,
      description: 'What the screen starts with — the fields it says are filled in by ' +
                   'whoever opens it. A person is not asked for these.' },

    // WHO ANSWERS IT. A role's name (e.g. "Accounts"); empty is anyone in the
    // company. The run shows in that role's "waiting for you" list, and only
    // someone holding it (or a Super Admin) can submit it.
    { name: 'assignTo', type: 'string', order: 3,
      description: 'The role that answers this screen, e.g. Accounts. Empty: anyone in the company.' },

    // THE BUTTONS, set on the step so one screen serves several workflows:
    // [{ key: 'approve', label: 'Approve' }, { key: 'send_back', label: 'Send back' }]
    // (a plain string is its own key and label). The one pressed is the
    // step's output.action, so an arrow branches on output.action = "approve".
    // None: a single Next, as before.
    { name: 'buttons', type: 'array', order: 4,
      description: 'The buttons the screen shows, e.g. [{ "key": "approve", "label": "Approve" }]. ' +
                   'The one pressed comes out as output.action. Empty: one Next button.' }
  ],

  // Whatever the person submitted, which is not knowable from here — declared
  // as nothing rather than as a lie. See the note above.
  outputSchema: null,

  execute: async function() {
    return {};
  }
};

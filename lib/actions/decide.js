// decide — A STEP THAT ONLY CHOOSES WHERE TO GO.
//
// It does nothing itself; its arrows (transitions) carry the conditions, first
// match wins, and a blank one is "otherwise". The way to branch on what
// started the run ({trigger.status} after a job) or on anything earlier,
// before any other step has run.
module.exports = {
  name: 'decide',
  description: 'Choose the next step from conditions on its arrows — on what started the run, ' +
               'or on anything earlier. Does nothing itself.',
  requires: [],
  inputSchema: [],
  outputSchema: null,
  execute: async function() { return {}; }
};

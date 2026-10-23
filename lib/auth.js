// THE AUTH DATABASE, for the hooks that grant a creator access to the company
// or workspace they just made (models/Company.js, models/Workspace.js) — the
// standalone server's own tenant screens. An embedded host has its own
// tenants and never inserts these rows.
//
// One connection per process, opened on first use: @xeplr/auth's attach()
// opens a new one every time it is called, and the standalone server reads
// the same database (orchestration/standalone.js uses this too).
var _auth = null;

function get() {
  if (!_auth) _auth = require('@xeplr/auth').attach();
  return _auth;
}

module.exports = {
  ready: function() { return get().ready(); },
  model: function(name) { return get().model(name); }
};

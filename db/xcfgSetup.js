// Single shared instance of @xeplr/actions' attachConfig() — so bin/www (which
// calls ready()) and anything else reading control-plane metadata see the same
// connection. All the bootstrap/bind/metaStore logic lives in @xeplr/actions;
// this file is just the one place xeplr-workflow holds its instance, naming
// itself 'xeplr-workflow'.
var { attachConfig } = require('@xeplr/actions');

module.exports = attachConfig({ service: 'xeplr-workflow' });

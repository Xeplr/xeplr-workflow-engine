var { getConnection, registerMTs } = require('@xeplr/db');
var models = require('../models');

var _registered = false;
var _conn = null;

/**
 * Bind workflow's own models to a connection. Config-driven — never reads
 * process.env; that is orchestration/standalone.js's job when nothing else
 * supplies one.
 *
 * @param {object} config
 * @param {string} config.name - database name (workflow's OWN domain data —
 *   this is always workflow's responsibility, embedded or standalone; that
 *   data belongs to workflow, not whatever it's mounted into)
 * @param {string} config.connection - connection string/encrypted blob, same
 *   shape @xeplr/db's getConnection already expects
 * @param {object} [config.mts] - { l1: {name, header}, ... }. registerMTs()
 *   is PROCESS-GLOBAL — only pass this when nothing else in this process has
 *   already called it. A host app embedding workflow has already registered
 *   its own levels; passing config.mts in that case would silently overwrite
 *   them. Standalone mode passes it; registerWorkflow's embedded branch does
 *   not.
 */
async function connectDb(config) {
  config = config || {};
  if (!config.name || !config.connection) {
    throw new Error('connectDb: { name, connection } are required');
  }
  if (config.mts && !_registered) {
    registerMTs(config.mts);
    _registered = true;
  }

  // bind:false — A SECONDARY CONNECTION, never the process's global one.
  //
  // @xeplr/db's bindModels does `Model.knex(instance)` on OBJECTION'S BASE
  // CLASS, so it is global: the last getConnection with bind:true wins for
  // every model in the process, whoever declared it. Standalone that is
  // harmless, because workflow is the only thing here. Embedded it is not —
  // connecting to workflow's own database re-pointed the HOST's models at it
  // too, and the host's own routes started failing on tables that were never
  // in this database.
  //
  // So workflow binds its OWN models to its OWN connection and leaves the
  // global binding alone. Exactly what @xeplr/auth's attach() does to reach
  // the auth database from the api process, and what @xeplr/actions'
  // attachConfig() does for xeplr_configs — this is the third instance of the
  // same shape, not a new idea.
  _conn = await getConnection(config.name, config.connection, {
    bind: false,
    connectionName: config.connectionName || 'workflow'
  });
  return _conn;
}

function conn() {
  if (!_conn) throw new Error('workflow: connection not ready — await connectDb() first');
  return _conn;
}

/**
 * A workflow model BOUND to workflow's own connection.
 *
 * Every query in this package goes through here rather than through the class
 * exported by models/index.js. An unbound class falls back to the global
 * binding, which belongs to whatever else is in this process — the host app,
 * embedded — so it would read the wrong database and mostly report that
 * workflow's tables do not exist.
 *
 * Objection caches per (Model, knex) pair, so calling this per request costs a
 * map lookup rather than a new class.
 */
function model(name) {
  var M = models[name];
  if (!M) throw new Error('workflow: unknown model "' + name + '"');
  return M.bindKnex(conn());
}

module.exports = connectDb;
module.exports.conn = conn;
module.exports.model = model;

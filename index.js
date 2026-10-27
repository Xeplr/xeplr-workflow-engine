var path = require('path');
var { up } = require('@xeplr/db').sqlMigrator;
var { resolveConfig, registerApplication, getApplicationId, migrationsFor, ensureDatabaseFor } = require('@xeplr/db');
var connectDb = require('./lib/db');
var actionCatalog = require('./lib/actionCatalog');
var envExposed = require('./lib/envExposed');
var workflowRunner = require('./lib/workflowRunner');
var flows = require('./lib/flows');
var jobs = require('./lib/jobs');
var triggers = require('./lib/triggers');
var recovery = require('./lib/recovery');
var versions = require('./lib/versions');
var xcfgSetup = require('./db/xcfgSetup');

// THE WORKFLOW ENGINE — everything that runs a workflow, with no HTTP in it:
// its database and tables, the action catalog, starting and resuming runs, and
// the flows facade (screens as steps). @xeplr/workflow-api puts routes on top
// of this; a host that only RUNS workflows (a job that starts one, a link that
// resumes one) can use this alone.

// Where the engine's SQL lives. Exported so a deployment that ships these
// folders somewhere else (a compiled bundle) and the standalone server read
// the same paths rather than each re-deriving them.
var MIGRATIONS_DIR = path.join(__dirname, 'migrations');
var TENANT_MIGRATIONS_DIR = path.join(__dirname, 'migrations-tenants');

/**
 * Connect workflow's own database, bring its tables up to date and register
 * its actions. Idempotent; the API's registerWorkflow() calls it first.
 *
 * @param {object} config
 * @param {object} config.db - { name, connection, mts?, connectionName?, migrationsTable? } —
 *   see lib/db.js. migrationsTable: workflow's own migration ledger, for a
 *   database it SHARES with its host (default: @xeplr/db's xeplr_migrations).
 * @param {boolean} [config.tenantTables=true] - false: do not create
 *   standalone workflow's own companies / workspaces tables.
 * @param {string} [config.applicationId] - the PRODUCT running this; see below.
 * @param {string|string[]} [config.migrations] - a host's extra migrations
 *   for workflow's database (default: XEPLR_WORKFLOW_MIGRATIONS).
 * @param {boolean} [config.migrate=true] - false: connect without running
 *   migrations, for a second process of an install whose API migrates.
 * @param {Function} [config.startJob] - async (jobId, { inputs, chain,
 *   callbackUrl }) → { occurrenceId }: how this host starts a job. With
 *   @xeplr/jobs in the same process, `(id, body) => jobs.trigger(id, body)`.
 *   Used by the job-run step; unset, it falls back to its jobsUrl over HTTP.
 * @param {Function} [config.resolveConnection] - async (connectionInfoId,
 *   { field, inputs }) → a login, or { dbType, connection }: how this host
 *   turns a saved connection's id into its login. A step then stores
 *   `connectionInfoId` and never a password; the login exists only in the
 *   call to the action (@xeplr/actions' resolveConnections). The same
 *   function a host gives @xeplr/jobs.
 * @param {boolean} [config.schedule=true] - false: do not run the schedule
 *   tick in this process (lib/triggers.js). Two processes may both run it —
 *   a due trigger is claimed, so it starts once — but one is enough.
 * @param {number} [config.scheduleIntervalMs=30000] - how often it looks.
 * @param {boolean} [config.recover=true] - false: do not run the sweeper in
 *   this process (lib/recovery.js). It picks up runs whose process died
 *   mid-step and fails waits past their timeoutMs. Several processes may run
 *   it; a run is taken by one.
 * @param {number} [config.recoverIntervalMs=30000] - how often it looks.
 * @param {object} [config.lease] - { leaseMs, renewMs }: how long a process
 *   holds a run it is moving (default 2 min, renewed every 30 s). A run is
 *   recovered only after its lease has passed, so this is also how long a
 *   crash goes unnoticed.
 */
async function startEngine(config) {
  config = config || {};
  if (config.startJob !== undefined) jobs.setJobStarter(config.startJob);
  if (config.resolveConnection !== undefined) workflowRunner.setConnectionResolver(config.resolveConnection);
  if (!config.db) {
    throw new Error('startEngine: config.db is required — workflow owns its own domain data regardless of how it is mounted');
  }
  // WORKFLOW'S OWN TABLES CARRY NO applicationId. Each host supplies its own
  // database (config.db), so that database is the boundary — a column holding
  // one constant value in every row would buy nothing, which is the same
  // reason xeplr_bi and the auth DBs do not have one either.
  //
  // The identity is still REQUIRED, because this mount also writes to
  // xeplr_configs — the one store that genuinely is shared by every app and
  // cannot be split per consumer (reference data, plus import_meta). Rows
  // there are attributed by applicationId, so a mount that skipped this would
  // quietly file its movement metadata under the package name instead of the
  // product's.
  //
  // Inherited by default: a host registers itself once at boot and every
  // sub-product it mounts picks it up with no further wiring. config
  // .applicationId is accepted for a host that would rather be explicit, and
  // is idempotent under the same value.
  if (config.applicationId) registerApplication(config.applicationId);
  if (!getApplicationId()) {
    throw new Error(
      'startEngine: no application registered. Call registerApplication("<this-product>") ' +
      'from @xeplr/db once at host startup (or pass config.applicationId). It attributes the ' +
      'rows this mount writes to the SHARED xeplr_configs database; workflow\'s own tables are ' +
      'separated by having their own database, not by this.');
  }

  await connectDb(config.db);

  // ITS OWN TABLES, ITS OWN JOB — for the same reason config.db is required in
  // both modes. This lived in orchestration/standalone.js, so a host that
  // embedded workflow got a connection to a database with none of workflow's
  // tables in it, and the first request failed on a missing relation.
  //
  // Idempotent, so a host that also runs them loses nothing by this.
  //
  // The migrator resolves its connection BY NAME from a registry that
  // getConnection above does not populate, so the name has to be resolved
  // explicitly first. Without this an embedded mount died on
  // 'No resolved config for "WORKFLOW"' and the whole product silently did
  // not appear — while every /workflow/* path still answered 401, because the
  // host's auth middleware runs before routing and a missing route never got
  // the chance to 404.
  var migrationConnection = config.db.connectionName || 'workflow';
  await resolveConfig(migrationConnection, config.db.connection);

  // CREATE IT IF IT IS NOT THERE. Each host gives workflow its own database
  // (xeplr_bi_workflow, xeplr_erp_workflow) — that separation is the entire
  // isolation model, so pointing a host at a name that does not exist yet is
  // the NORMAL first boot, not an error state. Without this it failed on
  // "database does not exist" and every host had to run a manual createdb
  // that nothing in the config hinted at. Same as @xeplr/email does.
  // migrate: false — connect only. For a second process of the same install
  // (BI's separate jobs service) that must not race the API's own migration
  // run at deploy: the API migrates, this one uses the tables it made.
  if (config.migrate !== false) {
    var ensured = await ensureDatabaseFor(config.db.connection, config.db.name);
    if (ensured.created) console.log('[workflow] created database ' + config.db.name);
    // XEPLR_WORKFLOW_MIGRATIONS — a host adds its own tables or seed rows to
    // workflow's database without editing this package. Same convention as
    // every other xeplr library (see @xeplr/db's app-migrations.js); config
    // .migrations lets an embedding host pass them directly instead, since a
    // host that already has the paths in code should not have to route them
    // back out through the environment.
    //
    // SHARING A DATABASE. A host may give workflow its OWN database (BI's
    // xeplr_bi_workflow) or put it in the host's (an app from @xeplr/cli). In a
    // shared one, config.db.migrationsTable keeps workflow's record of what ran
    // apart from the host's — both use @xeplr/db's migrator, and one ledger
    // would mix the two histories by filename.
    var ledger = config.db.migrationsTable || undefined;

    // companies / workspaces are STANDALONE workflow's own tenant lists — the
    // lists behind its "pick a company, then a workspace" screens. Nothing in a
    // workflow, step or run references them (runs carry mtId1/mtId2 as plain
    // ids), and an embedded host has its own tenants, or none — so a host says
    // tenantTables: false and they are not created. That is also what lets
    // workflow share a database that already has a "companies" table.
    if (config.tenantTables !== false) {
      var tenants = await up({
        db: config.db.name,
        dir: TENANT_MIGRATIONS_DIR,
        type: 'precede',
        connectionName: migrationConnection,
        tableName: ledger
      });
      if (tenants.migrations.length) console.log('[workflow] ran ' + tenants.migrations.length + ' tenant-table migrations');
    }

    var migrated = await up({
      db: config.db.name,
      dir: MIGRATIONS_DIR,
      extDir: config.migrations || migrationsFor('workflow'),
      type: 'precede',
      connectionName: migrationConnection,
      tableName: ledger
    });
    if (migrated.migrations.length) {
      console.log('[workflow] ran ' + migrated.migrations.length + ' migrations');
    }
  }



  // THE ACTION CATALOG, for the same reason the migrations above moved here.
  // This lived only in orchestration/standalone.js, so an embedded host got a
  // mounted product whose registry was empty: GET /actions answered 200 with
  // an empty list, the step editor's Action dropdown drew nothing, and there
  // was no error anywhere to explain why — the one failure mode the whitelist
  // in lib/actionCatalog.js is otherwise careful to make loud.
  //
  // Idempotent (register() overwrites by name), so a host that somehow also
  // registers them loses nothing.
  //
  // xeplr_configs is best-effort HERE and fail-fast in standalone, and the
  // difference is deliberate: standalone owns its whole process and should
  // refuse to boot half-configured, whereas failing a host's mount over one
  // action that records movement metadata would take down a product that is
  // otherwise entirely functional. The warning names what was lost.
  try {
    await xcfgSetup.ready();
  } catch (err) {
    console.warn('[workflow] xeplr_configs unavailable (' + err.message + ') — actions needing it are not offered');
  }
  var registered = actionCatalog.registerAll();
  console.log('[workflow] registered ' + registered.length + ' actions: ' + registered.join(', '));

  // Say out loud what step templates can read out of the environment. Silent
  // by default (nothing exposed unless WORKFLOW_ENV_EXPOSED names it), so a
  // line here means somebody opted in — and a list that accidentally names a
  // secret is only catchable if it is visible somewhere.
  envExposed.logExposure();

  // Scheduled workflows start themselves from here on. The timer does not
  // keep the process alive.
  if (config.schedule !== false) triggers.startTicking(config.scheduleIntervalMs);

  // Runs whose process died, and waits past their time, are found from here
  // on. Also a timer that does not keep the process alive.
  if (config.lease) workflowRunner.setLeaseTiming(config.lease);
  if (config.recover !== false) recovery.startSweeping(config.recoverIntervalMs);
}

// Env vars a HOST embedding workflow must supply — spread into the host's
// env.required.js so a missing one fails at startup rather than at mount:
//
//   ...require('@xeplr/workflow-engine').embedRequiredEnv,   // DB_WORKFLOW
//
// Named `embedRequiredEnv`, not `requiredEnv`, because it is not the same
// list as this package's OWN standalone process needs (see env.required.js,
// which uses DB_API for the very same database — a standalone deployment
// names its own store, an embedded one is given a separate one by its host).
// Two deployments, two questions, two lists.
//
// DB_WORKFLOW only: the SERVER login comes from the shared
// XEPLR_DB_CONNECTION, and workflow never reads either itself — the host
// passes both into registerWorkflow({ db }). This list exists so the host is
// told what to pass before it boots.
var embedRequiredEnv = [
  'DB_WORKFLOW'
];

/**
 * Resume a run parked on a 'wait' step. THE ENTIRE consumer-side contract for
 * waiting — the caller never needs to know which run or step the key belongs
 * to, because that lookup lives in workflow_resume_keys alone.
 *
 *   var { resumeByKey } = require('@xeplr/workflow-engine');
 *   await resumeByKey(key, { confirmedBy: userId });
 *
 * SERVER-SIDE, IN-PROCESS, DELIBERATELY. This is not something a browser
 * calls. The host's own route — the activation link's landing route, the
 * confirm button's POST — does its own work (activate the account, record the
 * approval) and then calls this in the same request. The key travels out
 * bound into that route's URL via `{resumeKey}` and comes back to the host,
 * never to workflow's own HTTP surface.
 *
 * That is the whole reason it is exported here rather than left as a route: a
 * resume is a step in the host's transaction, not a separate thing a client
 * is trusted to trigger.
 *
 * Throws with `err.code` set, which is what a host should branch on:
 *
 *   RESUME_KEY_INVALID    no live key — already used, unknown, or the run is
 *                         gone. NORMAL for a host route that also serves
 *                         users who never came from a workflow: catch it and
 *                         carry on with your own work.
 *   RESUME_KEY_NOT_READY  the key is real but its step has not parked yet
 *                         (the action that delivers it is still running).
 *                         Nothing is consumed — retry shortly.
 *
 * Requires startEngine() (or the API's registerWorkflow(), which calls it) to have run in this process: it is what
 * connects workflow's database, and this reads through that same connection.
 * Needs no ambient tenant context — the run carries its own mtIds and this
 * re-enters them itself.
 *
 * @param {string} key    the value bound into the step as {resumeKey}
 * @param {object} [output]  merged into the wait step's output, so later
 *   steps can read it as {steps.<stepKey>.output.<name>}
 * @param {object} [opts]
 * @param {'success'|'failed'} [opts.status]  resolve the step as FAILED rather
 *   than succeeded — from there the step's own `onError` decides, defaulting
 *   to stopping the run. Omit for success, which is what every caller that
 *   predates this means (an approval click, a confirmation link).
 * @param {object} [opts.error]  recorded on the step run when status is
 *   'failed'.
 * @returns {Promise<{ runId: string, stepKey: string, status: string }>}
 */
async function resumeByKey(key, output, opts) {
  return workflowRunner.resumeByKey(key, output, opts);
}

// REQUIRED ONLY IF YOU USE STEPS THAT CALL SOMETHING OUTSIDE THIS PROCESS —
// today that is `job-run`. Kept as its own list, the same way @xeplr/email
// separates `requiredEnv` (sending) from `templatesRequiredEnv` (the template
// store): a host that only runs self-contained workflows is never made to
// configure something it does not use.
//
// WORKFLOW_PUBLIC_URL is the base a CALLER can reach this service on, mount
// path included — https://bi.example.com/workflow for an embedded mount. It is
// what {resumeUrl} is built from, so a step can hand a job an address to
// report back to.
//
// NOT DEFAULTED, and that is the point of it being here rather than having a
// fallback: a wrong-but-present address gives a job somewhere to POST that
// nothing is listening on, so the run waits forever on work that actually
// finished. Unset, {resumeUrl} is null and job-run refuses by name before
// starting anything.
var callbackRequiredEnv = [
  'WORKFLOW_PUBLIC_URL'
];

module.exports = {
  startEngine: startEngine,
  resumeByKey: resumeByKey,
  embedRequiredEnv: embedRequiredEnv,
  callbackRequiredEnv: callbackRequiredEnv,
  MIGRATIONS_DIR: MIGRATIONS_DIR,
  TENANT_MIGRATIONS_DIR: TENANT_MIGRATIONS_DIR,

  // The parts the API (and a host's own routes) build on.
  db: connectDb,
  actionCatalog: actionCatalog,
  envExposed: envExposed,
  runner: workflowRunner,
  flows: flows,
  // What starts a workflow: the registry of kinds (manual, api, schedule,
  // job — and a host's own via registerTrigger), the schedule tick, and what
  // a trigger last did.
  triggers: triggers,
  registerTrigger: triggers.registerTrigger,
  // Jobs as steps and as triggers. A host with @xeplr/jobs passes jobs'
  // onFinish to jobFinished, so a finished job starts the workflows it
  // triggers and resumes the step that started it.
  jobs: jobs,
  jobFinished: jobs.jobFinished,
  // An arrow's `when` ({ field, op, value }) → the engine's condition node.
  conditions: require('./lib/conditions'),
  // The sweeper (sweep() runs one pass now) and the steps a run reads.
  recovery: recovery,
  versions: versions,
  xcfgSetup: xcfgSetup,
  auth: require('./lib/auth')
};

// A RUN READS THE STEPS IT STARTED WITH.
//
// Without this every run read the workflow's steps as they are NOW. An edit
// published while forty receipts were half-way through changed what those
// forty did next, and a flow's design — saved by deleting and re-inserting its
// steps under new ids — left a run parked on a screen pointing at a step row
// that no longer existed, so it could never be submitted.
//
// A version is cut the first time a run starts on a set of steps nobody has
// run before, recognised by a hash of them. No save or publish route has to
// remember to cut one, and a workflow saved ten times between two runs gets
// one version, not ten.
//
// Versions are read unscoped, by workflowId: the steps are the workflow's, and
// a workflow shared by several tenants must not get one version per tenant.

var crypto = require('crypto');
var { generateId } = require('@xeplr/utils/lib/helpers');
var db = require('./db');

// What a step does, as opposed to where it is drawn or who saved it last.
// Moving a box on the canvas is not a new version.
var RUNS_ON = ['id', 'stepKey', 'name', 'actionName', 'values', 'kind', 'timeoutMs', 'onError',
  'transitions', 'joinStep', 'position', 'params'];

function snapshotOf(steps) {
  return steps.map(function(step) {
    var out = {};
    RUNS_ON.forEach(function(k) { out[k] = step[k] === undefined ? null : step[k]; });
    return out;
  });
}

function fingerprintOf(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function isDuplicate(err) {
  var code = err && (err.code || (err.nativeError && err.nativeError.code));
  return code === '23505' || (err && err.name === 'UniqueViolationError');
}

/**
 * The id of the version these steps are, cutting it if this is the first run
 * on them. Two runs starting at once on new steps race to insert the same
 * fingerprint; the loser reads the winner's row.
 */
async function pinVersion(workflowId, steps) {
  var snapshot = snapshotOf(steps);
  var fingerprint = fingerprintOf(snapshot);
  for (var attempt = 0; attempt < 3; attempt++) {
    var found = await db.model('WorkflowVersion').unscopedQuery().where({ workflowId: workflowId, fingerprint: fingerprint }).first();
    if (found) return found.id;
    var last = await db.model('WorkflowVersion').unscopedQuery().where({ workflowId: workflowId }).max('version as v').first();
    var id = generateId();
    try {
      await db.model('WorkflowVersion').query().insert({
        id: id, workflowId: workflowId, version: ((last && last.v) || 0) + 1, fingerprint: fingerprint, steps: snapshot
      });
      return id;
    } catch (err) {
      if (!isDuplicate(err)) throw err;
    }
  }
  throw new Error('Could not record a version of workflow ' + workflowId + ' — three runs raced to start it');
}

// A version never changes once written, so what was read once is kept.
var cache = new Map();
var CACHE_LIMIT = 500;

/** The steps a run reads: its version's, or the live ones for a run from before versions. */
async function stepsForRun(run) {
  if (!run.versionId) {
    return db.model('WorkflowStep').query().where({ workflowId: run.workflowId }).orderBy('position');
  }
  if (cache.has(run.versionId)) return cache.get(run.versionId);
  var version = await db.model('WorkflowVersion').unscopedQuery().findById(run.versionId);
  if (!version) throw new Error('Run ' + run.id + ' reads version ' + run.versionId + ', which does not exist');
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(run.versionId, version.steps);
  return version.steps;
}

module.exports = { pinVersion: pinVersion, stepsForRun: stepsForRun, snapshotOf: snapshotOf, fingerprintOf: fingerprintOf };

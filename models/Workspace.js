// Workspace — the second tenancy level, under a company. Plain CRUD record;
// siloed access is granted per workspace in the auth DB. companyId is required
// (a workspace always belongs to a company).
//
// Single MT level (mtLevels: 1) — a workspace row is scoped by its company
// (mtId1) only. It doesn't have a meaningful mtId2 of its own (a workspace
// isn't scoped "by workspace"); resources that live INSIDE a workspace
// (workflows, runs) stay at the app's full registered level count (2: company
// + workspace) via the default.
var { BaseModel } = require('@xeplr/db');
var { generateId } = require('@xeplr/utils/lib/helpers');

// Cross-DB — see Company.js for the identical pattern this mirrors: a
// CompanyAdmin's l1 grant does NOT imply l2 access (mtMembershipMiddleware
// checks each configured level independently), so without this, entering a
// just-created workspace 403s with "Not authorized for workspaceId ..." exactly
// like an ungranted company did before Company.$afterInsert existed.
function auth() { return require('../lib/auth'); }

async function grantWorkspaceCreator(userId, workspaceId) {
  var a = auth();
  await a.ready();
  var Role = a.model('Role');
  var UserTenantsMapping = a.model('UserTenantsMapping');

  var role = await Role.query().where({ name: 'Creator' }).first();
  if (!role) return; // not seeded (yet) — skip rather than throw

  var existing = await UserTenantsMapping.query()
    .where({ userId: userId, level: 'l2', value: workspaceId }).first();
  if (existing) return;

  await UserTenantsMapping.query().insert({
    id: generateId(),
    userId: userId,
    level: 'l2',
    value: workspaceId,
    roleId: role.id,
    isActive: true
  });
}

class Workspace extends BaseModel {
  static get tableName() { return 'workspaces'; }
  static get idColumn() { return 'id'; }
  static get mtLevels() { return 1; }

  static get jsonAttributes() { return ['tags']; }

  static get jsonSchema() {
    return BaseModel.schema({
      required: ['companyId', 'name'],
      properties: { tags: { type: ['array', 'null'] } }
    });
  }

  // Deferred via queryContext.afterCommit — see Company.js's $afterInsert for
  // why this can't grant inline.
  async $afterInsert(queryContext) {
    await super.$afterInsert(queryContext);
    if (queryContext && queryContext.user && queryContext.user.id && Array.isArray(queryContext.afterCommit)) {
      var userId = queryContext.user.id;
      var workspaceId = this.id;
      queryContext.afterCommit.push(async function() {
        try {
          await grantWorkspaceCreator(userId, workspaceId);
        } catch (err) {
          console.error('[Workspace] failed to grant Creator access to creator:', err.message);
        }
      });
    }
  }
}

module.exports = Workspace;

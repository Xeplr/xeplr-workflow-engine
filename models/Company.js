// Company — the top-level tenant (a customer of the workflow product). Plain
// CRUD record; access is granted per user in the auth DB (userTenantsMapping),
// not filtered here. When mt is enabled, BaseModel auto-fills mtId from
// context.
var { BaseModel } = require('@xeplr/db');
var { generateId } = require('@xeplr/utils/lib/helpers');

// Cross-DB — company lives in this app's own DB, userTenantsMapping/roles live
// in auth's. Required lazily inside the hook (not at module load) to sidestep
// any require-order issues between models/ and lib/auth.js at boot.
function auth() { return require('../lib/auth'); }

/**
 * Grants the creator CompanyAdmin on their own new company — otherwise nobody
 * has a userTenantsMapping row for it and every workspace-scoped route 403s
 * immediately (mtMembershipMiddleware has no grant to check against).
 *
 * Best-effort: logs and swallows rather than failing the company creation
 * itself. The company still exists either way, a missing grant is recoverable
 * (an admin can add one), and a rolled-back company creation over a grant
 * hiccup would not be.
 */
async function grantCompanyAdmin(userId, companyId) {
  var a = auth();
  await a.ready();
  var Role = a.model('Role');
  var UserTenantsMapping = a.model('UserTenantsMapping');

  var role = await Role.query().where({ name: 'CompanyAdmin' }).first();
  if (!role) return; // not seeded (yet) — skip rather than throw

  var existing = await UserTenantsMapping.query()
    .where({ userId: userId, level: 'l1', value: companyId }).first();
  if (existing) return;

  await UserTenantsMapping.query().insert({
    id: generateId(),
    userId: userId,
    level: 'l1',
    value: companyId,
    roleId: role.id,
    isActive: true
  });
}

class Company extends BaseModel {
  static get tableName() { return 'companies'; }
  static get idColumn() { return 'id'; }
  static get multiTenant() { return false; }

  static get jsonSchema() {
    return BaseModel.schema({ required: ['name'] });
  }

  // queryContext.user comes from genericController's save() — { user: req.user }
  // set via .context(...) on the insert query. Absent for inserts made outside
  // an authenticated request (e.g. a migration), in which case this no-ops.
  //
  // Deferred via queryContext.afterCommit rather than granted here directly:
  // this hook fires while the Company insert's transaction is still open, but
  // grantCompanyAdmin() writes to the AUTH DB on a separate, non-transactional
  // connection — if a later entry in the same changeset throws and this trx
  // rolls back, an inline grant would already be committed on the other
  // connection, orphaned against a companyId that no longer exists.
  async $afterInsert(queryContext) {
    await super.$afterInsert(queryContext);
    if (!queryContext || !Array.isArray(queryContext.afterCommit)) return;
    if (!queryContext.user || !queryContext.user.id) return;

    var companyId = this.id;
    var userId = queryContext.user.id;
    queryContext.afterCommit.push(async function() {
      try {
        await grantCompanyAdmin(userId, companyId);
      } catch (err) {
        console.error('[Company] failed to grant CompanyAdmin to creator:', err.message);
      }
    });
  }
}

module.exports = Company;

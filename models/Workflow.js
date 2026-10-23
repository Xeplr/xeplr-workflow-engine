var { BaseModel } = require('@xeplr/db');

// The document. Mounted through genericRoute as the parent of `steps` — one
// POST /workflows/save writes the workflow and its whole step list in a
// single transaction (see routes/index.js). Everything about a RUN of this
// document — WorkflowRun, WorkflowStepRun, WorkflowResumeKey,
// WorkflowRunEdge — is deliberately a separate model family, not part of
// this hierarchy: a run is not something you edit by saving the workflow.

class Workflow extends BaseModel {
  static get tableName() { return 'workflows'; }
  static get idColumn() { return 'id'; }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['id', 'name'],
      properties: {
        id: { type: 'string', maxLength: 25 },
        name: { type: 'string', maxLength: 255 },
        // A STABLE, AUTHOR-CHOSEN HANDLE, and only a FLOW has one. The flows
        // facade addresses a flow by key in its URLs (GET /flows/:key), so the
        // app that designs the screens refers to it by a name it chose rather
        // than by an id this database minted. Null for every ordinary
        // workflow — the builder finds those by id. See migrations/0013.
        key: { type: ['string', 'null'], maxLength: 64 },
        description: { type: ['string', 'null'], maxLength: 1000 },
        // [{ name, type, required, default, description, order }]
        params: { type: ['array', 'null'] },
        // WHAT STARTS A RUN — { kind, … }, one shape per kind (migrations/0014),
        // acted on by lib/triggers.js: manual, api, schedule, job, and any kind
        // a host registers. Checked on every write (below), so a trigger that
        // could never fire is refused when it is saved, not discovered later.
        trigger: { type: ['object', 'null'] },
        status: { type: 'string', maxLength: 20 },
        // WHAT THE BUILDER OFFERS, not what the engine does — 'workflow' (the
        // action catalogue), 'jobs' (the job list), or 'screens' (a flow,
        // designed in another app entirely through the /flows facade and
        // read-only in this product's own builder). workflowRunner never reads
        // it. See migrations/0012 and 0013.
        kind: { type: 'string', enum: ['workflow', 'jobs', 'screens'] },
        isActive: { type: 'boolean' },
        recordCreatedDate: { type: ['string', 'null'] },
        recordModifiedDate: { type: ['string', 'null'] },
        recordCreatedBy: { type: ['string', 'null'], maxLength: 25 },
        recordModifiedBy: { type: ['string', 'null'], maxLength: 25 }
      }
    };
  }

  $beforeInsert() {
    super.$beforeInsert();
    if (!this.status) this.status = 'draft';
    if (this.trigger !== undefined) this.trigger = require('../lib/triggers').validate(this.trigger);
  }

  $beforeUpdate(opt, ctx) {
    super.$beforeUpdate(opt, ctx);
    if (this.trigger !== undefined) this.trigger = require('../lib/triggers').validate(this.trigger);
  }

  static get relationMappings() {
    var WorkflowStep = require('./WorkflowStep');
    return {
      steps: {
        relation: BaseModel.HasManyRelation,
        modelClass: WorkflowStep,
        join: { from: 'workflows.id', to: 'workflow_steps.workflowId' }
      }
    };
  }
}

module.exports = Workflow;

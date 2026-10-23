var { BaseModel } = require('@xeplr/db');

// One occurrence of a Workflow. Not part of the workflow document's
// genericRoute hierarchy — a run is created and driven by lib/workflowRunner,
// never hand-edited via a document save. Deliberately independent of
// @xeplr/jobs' Job/JobOccurrence: a workflow ties multiple steps (and, later,
// possibly jobs) together, but owns its own execution bookkeeping rather than
// borrowing theirs.

class WorkflowRun extends BaseModel {
  static get tableName() { return 'workflow_runs'; }
  static get idColumn() { return 'id'; }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['id', 'workflowId', 'status'],
      properties: {
        id: { type: 'string', maxLength: 25 },
        workflowId: { type: 'string', maxLength: 25 },
        status: { type: 'string', enum: ['queued', 'running', 'waiting', 'success', 'failed'] },
        params: { type: ['object', 'null'] },
        // Set only on a child run spawned by an 'each' transition — the one
        // element this occurrence exists to process. See WorkflowRunEdge.
        item: { type: ['object', 'null'] },
        trigger: { type: ['string', 'null'], maxLength: 64 },
        startedAt: { type: ['string', 'null'] },
        finishedAt: { type: ['string', 'null'] },
        durationMs: { type: ['integer', 'null'] },
        error: { type: ['object', 'null'] },
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
    if (!this.status) this.status = 'queued';
    if (!this.trigger) this.trigger = 'manual';
  }

  static get relationMappings() {
    var Workflow = require('./Workflow');
    var WorkflowStepRun = require('./WorkflowStepRun');
    return {
      workflow: {
        relation: BaseModel.BelongsToOneRelation,
        modelClass: Workflow,
        join: { from: 'workflow_runs.workflowId', to: 'workflows.id' }
      },
      stepRuns: {
        relation: BaseModel.HasManyRelation,
        modelClass: WorkflowStepRun,
        join: { from: 'workflow_runs.id', to: 'workflow_step_runs.runId' }
      }
    };
  }
}

module.exports = WorkflowRun;

var { BaseModel } = require('@xeplr/db');

// The only place a run's family tree lives — see 0008_workflow_run_edges.sql.
// workflow_steps stays flat; fan-out ancestry is entirely a run-time fact
// recorded here, never something an authored step definition carries.

class WorkflowRunEdge extends BaseModel {
  static get tableName() { return 'workflow_run_edges'; }
  static get idColumn() { return 'id'; }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['id', 'parentRunId', 'childRunId'],
      properties: {
        id: { type: 'string', maxLength: 25 },
        parentRunId: { type: 'string', maxLength: 25 },
        childRunId: { type: 'string', maxLength: 25 },
        sourceStepKey: { type: ['string', 'null'], maxLength: 64 },
        itemIndex: { type: ['integer', 'null'] },
        itemKey: { type: ['string', 'null'], maxLength: 255 },
        item: { type: ['object', 'null'] },
        isActive: { type: 'boolean' },
        recordCreatedDate: { type: ['string', 'null'] },
        recordModifiedDate: { type: ['string', 'null'] },
        recordCreatedBy: { type: ['string', 'null'], maxLength: 25 },
        recordModifiedBy: { type: ['string', 'null'], maxLength: 25 }
      }
    };
  }

  static get relationMappings() {
    var WorkflowRun = require('./WorkflowRun');
    return {
      parentRun: {
        relation: BaseModel.BelongsToOneRelation,
        modelClass: WorkflowRun,
        join: { from: 'workflow_run_edges.parentRunId', to: 'workflow_runs.id' }
      },
      childRun: {
        relation: BaseModel.BelongsToOneRelation,
        modelClass: WorkflowRun,
        join: { from: 'workflow_run_edges.childRunId', to: 'workflow_runs.id' }
      }
    };
  }
}

module.exports = WorkflowRunEdge;

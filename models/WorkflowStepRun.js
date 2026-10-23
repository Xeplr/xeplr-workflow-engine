var { BaseModel } = require('@xeplr/db');

class WorkflowStepRun extends BaseModel {
  static get tableName() { return 'workflow_step_runs'; }
  static get idColumn() { return 'id'; }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['id', 'runId', 'status'],
      properties: {
        id: { type: 'string', maxLength: 25 },
        runId: { type: 'string', maxLength: 25 },
        stepId: { type: ['string', 'null'], maxLength: 25 },
        stepKey: { type: ['string', 'null'], maxLength: 64 },
        actionName: { type: ['string', 'null'], maxLength: 128 },
        status: { type: 'string', enum: ['pending', 'running', 'waiting', 'success', 'failed', 'skipped'] },
        input: { type: ['object', 'null'] },
        output: { type: ['object', 'null'] },
        error: { type: ['object', 'null'] },
        durationMs: { type: ['integer', 'null'] },
        position: { type: 'integer' },
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
    if (!this.status) this.status = 'pending';
  }

  static get relationMappings() {
    var WorkflowRun = require('./WorkflowRun');
    return {
      run: {
        relation: BaseModel.BelongsToOneRelation,
        modelClass: WorkflowRun,
        join: { from: 'workflow_step_runs.runId', to: 'workflow_runs.id' }
      }
    };
  }
}

module.exports = WorkflowStepRun;

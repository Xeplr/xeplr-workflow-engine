var { BaseModel } = require('@xeplr/db');

// A path reaching a meeting point, with what it brought — see
// 0020_splits_and_meeting_points.sql. Written by lib/workflowRunner.js only.

class WorkflowRunArrival extends BaseModel {
  static get tableName() { return 'workflow_run_arrivals'; }
  static get idColumn() { return 'id'; }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['id', 'runId', 'splitId', 'pathId', 'stepKey'],
      properties: {
        id: { type: 'string', maxLength: 25 },
        runId: { type: 'string', maxLength: 25 },
        splitId: { type: 'string', maxLength: 25 },
        pathId: { type: 'string', maxLength: 25 },
        stepKey: { type: 'string', maxLength: 64 },
        fromStepKey: { type: ['string', 'null'], maxLength: 64 },
        decision: { type: ['string', 'null'], maxLength: 64 },
        output: { type: ['object', 'null'] },
        late: { type: 'boolean' },
        isActive: { type: 'boolean' },
        recordCreatedDate: { type: ['string', 'null'] },
        recordModifiedDate: { type: ['string', 'null'] },
        recordCreatedBy: { type: ['string', 'null'], maxLength: 25 },
        recordModifiedBy: { type: ['string', 'null'], maxLength: 25 }
      }
    };
  }
}

module.exports = WorkflowRunArrival;

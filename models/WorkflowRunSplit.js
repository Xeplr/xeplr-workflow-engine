var { BaseModel } = require('@xeplr/db');

// A step that opened several paths, each time it ran — see
// 0020_splits_and_meeting_points.sql. Written by lib/workflowRunner.js only.

class WorkflowRunSplit extends BaseModel {
  static get tableName() { return 'workflow_run_splits'; }
  static get idColumn() { return 'id'; }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['id', 'runId', 'stepKey', 'opened'],
      properties: {
        id: { type: 'string', maxLength: 25 },
        runId: { type: 'string', maxLength: 25 },
        stepKey: { type: 'string', maxLength: 64 },
        pathId: { type: ['string', 'null'], maxLength: 25 },
        parentSplitId: { type: ['string', 'null'], maxLength: 25 },
        opened: { type: 'integer' },
        joinStepKey: { type: ['string', 'null'], maxLength: 64 },
        joinedAt: { type: ['string', 'null'] },
        isActive: { type: 'boolean' },
        recordCreatedDate: { type: ['string', 'null'] },
        recordModifiedDate: { type: ['string', 'null'] },
        recordCreatedBy: { type: ['string', 'null'], maxLength: 25 },
        recordModifiedBy: { type: ['string', 'null'], maxLength: 25 }
      }
    };
  }
}

module.exports = WorkflowRunSplit;

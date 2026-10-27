var { BaseModel } = require('@xeplr/db');

// A wait a person answers — see 0021_tasks.sql and lib/tasks.js. Written by
// the engine when a screen or an approval parks, never by a document save.

class WorkflowTask extends BaseModel {
  static get tableName() { return 'workflow_tasks'; }
  static get idColumn() { return 'id'; }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['id', 'runId', 'workflowId', 'stepRunId', 'resumeKeyId', 'stepKey', 'kind', 'status'],
      properties: {
        id: { type: 'string', maxLength: 25 },
        runId: { type: 'string', maxLength: 25 },
        workflowId: { type: 'string', maxLength: 25 },
        pathId: { type: ['string', 'null'], maxLength: 25 },
        stepRunId: { type: 'string', maxLength: 25 },
        resumeKeyId: { type: 'string', maxLength: 25 },
        stepKey: { type: 'string', maxLength: 64 },
        title: { type: ['string', 'null'], maxLength: 255 },
        kind: { type: 'string', enum: ['screen', 'approval'] },
        position: { type: 'integer' },
        assigneeUserId: { type: ['string', 'null'], maxLength: 25 },
        assigneeRole: { type: ['string', 'null'], maxLength: 128 },
        status: { type: 'string', enum: ['queued', 'open', 'claimed', 'done', 'withdrawn'] },
        claimedBy: { type: ['string', 'null'], maxLength: 25 },
        claimedAt: { type: ['string', 'null'] },
        decidedBy: { type: ['string', 'null'], maxLength: 25 },
        decidedAt: { type: ['string', 'null'] },
        decision: { type: ['string', 'null'], maxLength: 64 },
        comment: { type: ['string', 'null'] },
        dueAt: { type: ['string', 'null'] },
        remindedAt: { type: ['string', 'null'] },
        escalateTo: { type: ['string', 'null'], maxLength: 128 },
        escalatedAt: { type: ['string', 'null'] },
        history: { type: ['array', 'null'] },
        isActive: { type: 'boolean' },
        recordCreatedDate: { type: ['string', 'null'] },
        recordModifiedDate: { type: ['string', 'null'] },
        recordCreatedBy: { type: ['string', 'null'], maxLength: 25 },
        recordModifiedBy: { type: ['string', 'null'], maxLength: 25 }
      }
    };
  }
}

module.exports = WorkflowTask;

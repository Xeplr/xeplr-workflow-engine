var { BaseModel } = require('@xeplr/db');

// The entire wait/resume mechanism lives behind this one table — see
// 0007_workflow_resume_keys.sql for the reasoning. Nothing outside
// lib/workflowRunner.js should query this model directly; the public surface
// is workflowRunner.resumeByKey(key, output).

class WorkflowResumeKey extends BaseModel {
  static get tableName() { return 'workflow_resume_keys'; }
  static get idColumn() { return 'id'; }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['id', 'runId', 'stepId', 'key'],
      properties: {
        id: { type: 'string', maxLength: 25 },
        runId: { type: 'string', maxLength: 25 },
        stepId: { type: 'string', maxLength: 25 },
        key: { type: 'string', maxLength: 64 },
        consumedDate: { type: ['string', 'null'] },
        isActive: { type: 'boolean' },
        recordCreatedDate: { type: ['string', 'null'] },
        recordModifiedDate: { type: ['string', 'null'] },
        recordCreatedBy: { type: ['string', 'null'], maxLength: 25 },
        recordModifiedBy: { type: ['string', 'null'], maxLength: 25 }
      }
    };
  }
}

module.exports = WorkflowResumeKey;

var { BaseModel } = require('@xeplr/db');

// What a workflow remembers between runs — see 0018_workflow_memory.sql and
// lib/actions/memory.js. Written by its `remember` step, never by a document save.

class WorkflowMemory extends BaseModel {
  static get tableName() { return 'workflow_memory'; }
  static get idColumn() { return 'id'; }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['id', 'workflowId', 'key'],
      properties: {
        id: { type: 'string', maxLength: 25 },
        workflowId: { type: 'string', maxLength: 25 },
        key: { type: 'string', minLength: 1, maxLength: 255 },
        value: {},
        runId: { type: ['string', 'null'], maxLength: 25 },
        isActive: { type: 'boolean' },
        recordCreatedDate: { type: ['string', 'null'] },
        recordModifiedDate: { type: ['string', 'null'] },
        recordCreatedBy: { type: ['string', 'null'], maxLength: 25 },
        recordModifiedBy: { type: ['string', 'null'], maxLength: 25 }
      }
    };
  }
}

module.exports = WorkflowMemory;

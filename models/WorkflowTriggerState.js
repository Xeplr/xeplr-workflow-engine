var { BaseModel } = require('@xeplr/db');

// What a workflow's trigger last did — see 0015_workflow_triggers.sql and
// lib/triggers.js. One row per workflow; written by the engine, never by a
// document save.

class WorkflowTriggerState extends BaseModel {
  static get tableName() { return 'workflow_trigger_states'; }
  static get idColumn() { return 'id'; }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['id', 'workflowId'],
      properties: {
        id: { type: 'string', maxLength: 25 },
        workflowId: { type: 'string', maxLength: 25 },
        kind: { type: ['string', 'null'], maxLength: 32 },
        settings: { type: ['string', 'null'] },
        nextDueAt: { type: ['string', 'null'] },
        lastFiredAt: { type: ['string', 'null'] },
        lastRunId: { type: ['string', 'null'], maxLength: 25 },
        lastSkippedAt: { type: ['string', 'null'] },
        lastSkipReason: { type: ['string', 'null'] },
        isActive: { type: 'boolean' },
        recordCreatedDate: { type: ['string', 'null'] },
        recordModifiedDate: { type: ['string', 'null'] },
        recordCreatedBy: { type: ['string', 'null'], maxLength: 25 },
        recordModifiedBy: { type: ['string', 'null'], maxLength: 25 }
      }
    };
  }
}

module.exports = WorkflowTriggerState;

var { BaseModel } = require('@xeplr/db');

// Where a run is — see 0019_paths_versions_recovery.sql. Written by
// lib/workflowRunner.js as the run moves, never by a document save. A split
// opens several; a meeting point closes them into one.

class WorkflowRunPath extends BaseModel {
  static get tableName() { return 'workflow_run_paths'; }
  static get idColumn() { return 'id'; }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['id', 'runId', 'status'],
      properties: {
        id: { type: 'string', maxLength: 25 },
        runId: { type: 'string', maxLength: 25 },
        parentPathId: { type: ['string', 'null'], maxLength: 25 },
        splitId: { type: ['string', 'null'], maxLength: 25 },
        // On the path that carries on from a meeting point: the split it closed.
        fromSplitId: { type: ['string', 'null'], maxLength: 25 },
        stepKey: { type: ['string', 'null'], maxLength: 64 },
        status: { type: 'string', enum: ['ready', 'running', 'waiting', 'arrived', 'done', 'failed', 'cancelled'] },
        round: { type: 'integer' },
        isActive: { type: 'boolean' },
        recordCreatedDate: { type: ['string', 'null'] },
        recordModifiedDate: { type: ['string', 'null'] },
        recordCreatedBy: { type: ['string', 'null'], maxLength: 25 },
        recordModifiedBy: { type: ['string', 'null'], maxLength: 25 }
      }
    };
  }
}

module.exports = WorkflowRunPath;

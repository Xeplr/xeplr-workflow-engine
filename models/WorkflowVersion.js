var { BaseModel } = require('@xeplr/db');

// The steps a run started with — see 0019_paths_versions_recovery.sql and
// lib/versions.js. Written when a run first starts on a set of steps, never
// edited afterwards.

class WorkflowVersion extends BaseModel {
  static get tableName() { return 'workflow_versions'; }
  static get idColumn() { return 'id'; }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['id', 'workflowId', 'version', 'fingerprint', 'steps'],
      properties: {
        id: { type: 'string', maxLength: 25 },
        workflowId: { type: 'string', maxLength: 25 },
        version: { type: 'integer' },
        fingerprint: { type: 'string', maxLength: 64 },
        steps: { type: 'array' },
        isActive: { type: 'boolean' },
        recordCreatedDate: { type: ['string', 'null'] },
        recordModifiedDate: { type: ['string', 'null'] },
        recordCreatedBy: { type: ['string', 'null'], maxLength: 25 },
        recordModifiedBy: { type: ['string', 'null'], maxLength: 25 }
      }
    };
  }
}

module.exports = WorkflowVersion;

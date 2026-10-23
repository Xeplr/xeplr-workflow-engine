var { BaseModel } = require('@xeplr/db');

class WorkflowStep extends BaseModel {
  static get tableName() { return 'workflow_steps'; }
  static get idColumn() { return 'id'; }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['id', 'workflowId', 'stepKey', 'actionName'],
      properties: {
        id: { type: 'string', maxLength: 25 },
        workflowId: { type: 'string', maxLength: 25 },
        stepKey: { type: 'string', maxLength: 64 },
        name: { type: ['string', 'null'], maxLength: 255 },
        actionName: { type: 'string', maxLength: 128 },
        values: { type: ['object', 'null'] },
        kind: { type: 'string', enum: ['auto', 'wait'] },
        timeoutMs: { type: ['integer', 'null'] },
        onError: { type: 'string', enum: ['stop', 'continue'] },
        // [{ condition: expressionHandlerExpr|null, mode: 'single'|'each', target: stepKey|'end_success'|'end_failed' }]
        transitions: { type: ['array', 'null'] },
        joinStep: { type: ['string', 'null'], maxLength: 64 },
        position: { type: 'integer' },
        // { x, y } canvas pixels — where the builder draws this step. Purely
        // visual; never read by workflowRunner. See migrations/0009.
        layout: { type: ['object', 'null'] },
        // An EXAMPLE of what this step returns, for the builder's field
        // picker — never what it did return (that is on workflow_step_runs),
        // and never read by workflowRunner. See migrations/0010.
        sampleOutput: { type: ['object', 'null'] },
        // What this step needs the CALLER to supply at run start:
        // [{ name, type, required, default, description, order, sample? }] —
        // the same field shape as an action's inputSchema. UNLIKE layout and
        // sampleOutput, workflowRunner DOES read this: every step's
        // declaration unions into the schema a run is validated against
        // before any step executes. See migrations/0011.
        params: { type: ['array', 'null'] },
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
    if (!this.kind) this.kind = 'auto';
    if (!this.onError) this.onError = 'stop';
  }

  static get relationMappings() {
    var Workflow = require('./Workflow');
    return {
      workflow: {
        relation: BaseModel.BelongsToOneRelation,
        modelClass: Workflow,
        join: { from: 'workflow_steps.workflowId', to: 'workflows.id' }
      }
    };
  }
}

module.exports = WorkflowStep;

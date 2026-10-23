// The domain models. Company and Workspace are the tenancy skeleton every
// xeplr app starts from. Workflow/WorkflowStep are the document, mounted as a
// genericRoute hierarchy in routes/index.js. WorkflowRun/WorkflowStepRun/
// WorkflowResumeKey/WorkflowRunEdge are a separate family — an occurrence of
// a workflow, driven by lib/workflowRunner, never hand-edited via a document
// save.
var Company = require('./Company');
var Workspace = require('./Workspace');
var Workflow = require('./Workflow');
var WorkflowStep = require('./WorkflowStep');
var WorkflowRun = require('./WorkflowRun');
var WorkflowStepRun = require('./WorkflowStepRun');
var WorkflowResumeKey = require('./WorkflowResumeKey');
var WorkflowRunEdge = require('./WorkflowRunEdge');

module.exports = {
  Company: Company,
  Workspace: Workspace,
  Workflow: Workflow,
  WorkflowStep: WorkflowStep,
  WorkflowRun: WorkflowRun,
  WorkflowStepRun: WorkflowStepRun,
  WorkflowResumeKey: WorkflowResumeKey,
  WorkflowRunEdge: WorkflowRunEdge
};

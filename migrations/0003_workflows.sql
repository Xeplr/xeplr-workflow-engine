-- 0003_workflows.sql
-- workflows — the product's one document. A workflow is an ordered list of
-- steps, and a step names a registered @xeplr/actions action plus the input to
-- call it with. Binding actions together is the whole of what this app does;
-- everything else exists to make that list savable, runnable and auditable.
--
-- `params` are the workflow's own declared inputs — what a caller supplies at
-- run time (a file path, a customer id). Steps reference them as `{params.x}`
-- in a bound value, so the same workflow runs against different subjects
-- without being edited.

CREATE TABLE "workflows" (
  "id" varchar(25) PRIMARY KEY,
  "name" varchar(255) NOT NULL,
  "description" varchar(1000),
  -- Declared inputs: [{ name, type, required, default, description, order }] —
  -- the same shape @xeplr/actions uses for an action's inputSchema, so a
  -- workflow reads as an action made of actions.
  "params" jsonb,
  -- Draft workflows are editable and not runnable; published ones are what a
  -- trigger is allowed to start. One column rather than a separate table
  -- because it is a property of the workflow, not a thing of its own.
  "status" varchar(20) DEFAULT 'draft',
  "isActive" boolean DEFAULT true,
  "mtId1" varchar(25),
  "mtId2" varchar(25),
  "mtId3" varchar(25),
  "mtId4" varchar(25),
  "recordCreatedDate" timestamp,
  "recordModifiedDate" timestamp,
  "recordCreatedBy" varchar(25),
  "recordModifiedBy" varchar(25)
);

CREATE INDEX "workflows_status_index" ON "workflows" ("status");

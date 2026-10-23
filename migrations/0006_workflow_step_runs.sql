-- 0006_workflow_step_runs.sql
-- workflow_step_runs — what each step actually did while a run happened.
--
-- `stepKey` / `actionName` are COPIED from the step, not joined to it. A step
-- can be renamed, re-pointed at another action, or deleted after this ran;
-- the history has to keep saying what actually happened, which a join would
-- quietly rewrite out from under it.
--
-- `input` is the values object AFTER placeholders were resolved — what the
-- action was really called with, the only version worth keeping when a run
-- has gone wrong for reasons the template explains.
--
-- `status`: pending · running · waiting · success · failed · skipped.
-- 'waiting' mirrors the run's own status while this step holds a live
-- workflow_resume_keys row. 'skipped' is for a step a transition jumped over
-- — it never ran, and saying so plainly is the point of listing it as a
-- distinct status rather than leaving it absent.

CREATE TABLE "workflow_step_runs" (
  "id" varchar(25) PRIMARY KEY,
  "runId" varchar(25) NOT NULL,
  "stepId" varchar(25),
  "stepKey" varchar(64),
  "actionName" varchar(128),
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "input" jsonb,
  "output" jsonb,
  "error" jsonb,
  "durationMs" integer,
  "position" integer DEFAULT 0,
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

CREATE INDEX "workflow_step_runs_run_index" ON "workflow_step_runs" ("runId");

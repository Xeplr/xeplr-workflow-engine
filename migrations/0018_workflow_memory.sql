-- 0018_workflow_memory.sql
--
-- WHAT A WORKFLOW REMEMBERS BETWEEN RUNS: one value per key, per workflow.
-- Written by its `remember` step, read by `recall`. A key usually carries the
-- period ("bank-recon:2026-09"), so "September is already done" is a row to
-- look up, not a guess from file names or run history.
--
-- One row per (workflow, key, tenant): remembering again replaces the value.
-- `runId` is the run that last wrote it, so "who said September was done"
-- has an answer.

CREATE TABLE IF NOT EXISTS "workflow_memory" (
  "id" varchar(25) PRIMARY KEY,
  "workflowId" varchar(25) NOT NULL,
  "key" varchar(255) NOT NULL,
  "value" jsonb,
  "runId" varchar(25),
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
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_memory_key"
  ON "workflow_memory" ("workflowId", "key", COALESCE("mtId1", ''), COALESCE("mtId2", ''));

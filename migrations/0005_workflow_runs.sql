-- 0005_workflow_runs.sql
-- workflow_runs — one occurrence of one workflow: the thread that ties a
-- send-and-wait email, a UI form render, and everything that resumes them
-- back together. Persisted rather than kept in memory, because "what did this
-- do last night" is the question a workflow product exists to answer, and a
-- run that only lives in a process is a run nobody can look at after a
-- restart or a crash mid-wait.
--
-- `params` records the values the run was STARTED WITH, so a result can be
-- reproduced — re-resolving them later would read today's defaults over
-- yesterday's run.
--
-- `item` is set only on a CHILD run — the one element (out of however many an
-- 'each' transition matched) this particular occurrence exists to process.
-- Denormalized here for the runner's own hot-path reads; workflow_run_edges
-- is still the source of truth for the parent/child relationship and its
-- provenance (which step fanned out, which position this was).
--
-- `status`: queued · running · waiting · success · failed. 'waiting' is
-- distinct from 'running' — it means the run is paused on a wait step with a
-- live entry in workflow_resume_keys, not actively doing anything.

CREATE TABLE "workflow_runs" (
  "id" varchar(25) PRIMARY KEY,
  "workflowId" varchar(25) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'queued',
  "params" jsonb,
  "item" jsonb,
  -- Who or what asked: 'manual', or the name of whatever triggers it later.
  "trigger" varchar(64) DEFAULT 'manual',
  "startedAt" timestamp,
  "finishedAt" timestamp,
  "durationMs" integer,
  -- The failure that ended the run, if one did. Per-step detail lives in
  -- workflow_step_runs; this is the summary a list needs without a join.
  "error" jsonb,
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

CREATE INDEX "workflow_runs_workflow_index" ON "workflow_runs" ("workflowId");
CREATE INDEX "workflow_runs_status_index" ON "workflow_runs" ("status");

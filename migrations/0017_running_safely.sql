-- 0017_running_safely.sql
--
-- RUNNING SAFELY: two settings the runner reads.
--
-- workflows."maxStepRuns" — how many times one step may run in one run before
-- the run is stopped as a loop. NULL means the default, 100. An arrow back to
-- an earlier step with no wait step on the way used to spin forever.
--
-- workflow_run_edges."targetStepKey" — the step a fanned-out child starts at.
-- Children beyond an arrow's limit (default 10 at once) wait as 'queued' and
-- are started one by one as others finish, which needs to know where each
-- starts. NULL on edges written before this: the runner then uses the source
-- step's "each" arrow.

ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "maxStepRuns" integer;
ALTER TABLE "workflow_run_edges" ADD COLUMN IF NOT EXISTS "targetStepKey" varchar(64);

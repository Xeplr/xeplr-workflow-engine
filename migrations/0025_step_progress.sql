-- 0025_step_progress.sql
--
-- A RUNNING STEP SAYS HOW FAR IT HAS GOT (lib/stepReport.js). A long step — a
-- 3 GB file loading, a movement of millions of rows — used to show nothing
-- until it ended. The action reports through system.onProgress and
-- system.log; the newest numbers and its log lines are kept here, written at
-- most every two seconds, so the run view can show them while it runs.
--
--   progress  the newest numbers the action gave ({ rowsRead, rowsWritten,
--             percent, … }) and when (`at`)
--   log       its log lines, oldest first: [{ at, level, message }], the
--             newest LOG_LINES kept
ALTER TABLE "workflow_step_runs" ADD COLUMN IF NOT EXISTS "progress" jsonb;
ALTER TABLE "workflow_step_runs" ADD COLUMN IF NOT EXISTS "log" jsonb;

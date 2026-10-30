-- 0023_steps_poll.sql
--
-- A STEP THAT KEEPS CHECKING. `poll` set ({ jobId }) makes a step listen
-- instead of running once: a run that reaches it parks there, and the job
-- named here (its schedule is how often) runs the step on every tick. A tick
-- that finds nothing writes nothing but the time it checked; one that finds
-- something starts a child run from the step's arrows with what it found.
-- See lib/workflowRunner.js pollStep. Null: an ordinary step.
ALTER TABLE "workflow_steps" ADD COLUMN IF NOT EXISTS "poll" jsonb;

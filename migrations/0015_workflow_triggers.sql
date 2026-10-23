-- 0015_workflow_triggers.sql
--
-- TRIGGERS START RUNS — and a job finishing is one of them.
--
-- 0014 recorded what is supposed to start a workflow; nothing acted on it.
-- lib/triggers.js now does, for every kind through one registry: a schedule,
-- a job finishing, and later a folder or a mailbox. Three things here.
--
-- 1. WHAT FIRED A RUN, IN FULL. workflow_runs.trigger is the kind ('job',
--    'schedule'); triggerData is what came with it — a finished job's status,
--    period and output, a schedule's due time — read by steps as {trigger.*}.
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "triggerData" jsonb;

-- 2. WHAT EACH TRIGGER LAST DID: when it fired and which run that was, when
--    it is next due, and when and why it did not start a run (a required
--    parameter nobody supplies, a workflow with no steps). One row per
--    workflow, so "why did this not run last night" is a SELECT.
--
--    Its times are timestamptz: a due time is an instant, and a plain
--    timestamp read back in another server timezone would fire hours off.
--
--    `settings` is the trigger as it was when nextDueAt was computed; a
--    changed schedule is noticed by comparing it, and given a fresh due time
--    rather than firing for one computed from the old expression.
CREATE TABLE IF NOT EXISTS "workflow_trigger_states" (
  "id" varchar(25) PRIMARY KEY,
  "workflowId" varchar(25) NOT NULL,
  "kind" varchar(32),
  "settings" text,
  "nextDueAt" timestamptz,
  "lastFiredAt" timestamptz,
  "lastRunId" varchar(25),
  "lastSkippedAt" timestamptz,
  "lastSkipReason" text,
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
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_trigger_states_workflow_unique" ON "workflow_trigger_states" ("workflowId");

-- 3. JOB CHAINS BECOME ORDINARY WORKFLOWS.
--
-- A job's "After this job" rules used to be a hidden, locked workflow of
-- kind 'job-chain' with two private actions and their own routes. It is now
-- what it always was underneath: a workflow, triggered by the job finishing.
--
--   kind 'job-chain'           → 'workflow', with trigger
--                                { kind: 'job', jobId, when: 'finished' }
--                                (the decide step still routes on status)
--   key 'job-chain-<jobId>'    → none; the trigger says which job
--   'job-chain-decide' step    → 'decide' (a plain branching step)
--   'job-chain-next' steps     → 'job-run', which carries the period on
--   conditions on params.x     → trigger.x  (status, output, window, carry…)
--   bindings {output.x} etc.   → {trigger.output.x}
--
-- A rule input of exactly "{window}" is dropped: job-run passes the finished
-- job's period on by itself, as an object, which a binding would turn into
-- text.
UPDATE "workflow_steps" s
   SET "actionName" = 'decide',
       "values" = '{}'::jsonb,
       "transitions" = replace(s."transitions"::text, '"params.', '"trigger.')::jsonb
  FROM "workflows" w
 WHERE w."id" = s."workflowId" AND w."kind" = 'job-chain' AND s."actionName" = 'job-chain-decide';

UPDATE "workflow_steps" s
   SET "actionName" = 'job-run',
       "values" = regexp_replace(
         (CASE WHEN s."values"->'inputs'->>'window' = '{window}'
               THEN s."values" #- '{inputs,window}' ELSE s."values" END)::text,
         '\{\s*(status|error|output|carry|window|jobId|given|used)\M', '{trigger.\1', 'g')::jsonb
  FROM "workflows" w
 WHERE w."id" = s."workflowId" AND w."kind" = 'job-chain' AND s."actionName" = 'job-chain-next';

UPDATE "workflows"
   SET "trigger" = jsonb_build_object('kind', 'job', 'jobId', substring("key" from 11), 'when', 'finished'),
       "kind" = 'workflow',
       "key" = NULL
 WHERE "kind" = 'job-chain' AND "key" LIKE 'job-chain-%';

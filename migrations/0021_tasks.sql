-- 0021_tasks.sql
--
-- A WAIT THAT A PERSON ANSWERS IS A TASK. Before this a wait was an anonymous
-- key: nothing said who it was for, who had taken it, or who answered it, so
-- "what is waiting for me", "approved by Meera", and "Neil is on leave, give
-- it to Chen" had nowhere to live.
--
-- A task is written when a step parks that a person answers: a screen
-- (screen-show) or an approval (one task per approver). Machine waits — an
-- email link, a job finishing — stay key-only.
--
--   status    queued    an approver after the current one, in turn
--             open      anyone it is assigned to may take or answer it
--             claimed   one person took it; only they answer it
--             done      answered (decidedBy, decision, comment)
--             withdrawn no longer needed: the step went ahead without it
--
--   assigneeUserId / assigneeRole — one or the other; neither means anyone in
--   the company. dueAt, remindedAt, escalatedAt drive the sweeper.
--   history: who did what to it and why — reassignments, escalations.
CREATE TABLE IF NOT EXISTS "workflow_tasks" (
  "id" varchar(25) PRIMARY KEY,
  "runId" varchar(25) NOT NULL,
  "workflowId" varchar(25) NOT NULL,
  "pathId" varchar(25),
  "stepRunId" varchar(25) NOT NULL,
  "resumeKeyId" varchar(25) NOT NULL,
  "stepKey" varchar(64) NOT NULL,
  "title" varchar(255),
  "kind" varchar(20) NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  "assigneeUserId" varchar(25),
  "assigneeRole" varchar(128),
  "status" varchar(20) NOT NULL DEFAULT 'open',
  "claimedBy" varchar(25),
  "claimedAt" timestamptz,
  "decidedBy" varchar(25),
  "decidedAt" timestamptz,
  "decision" varchar(64),
  "comment" text,
  "dueAt" timestamptz,
  "remindedAt" timestamptz,
  "escalateTo" varchar(128),
  "escalatedAt" timestamptz,
  "history" jsonb,
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
-- The inbox: my open tasks, and my roles' open tasks.
CREATE INDEX IF NOT EXISTS "workflow_tasks_user_inbox" ON "workflow_tasks" ("assigneeUserId", "status");
CREATE INDEX IF NOT EXISTS "workflow_tasks_role_inbox" ON "workflow_tasks" ("assigneeRole", "status");
CREATE INDEX IF NOT EXISTS "workflow_tasks_run_index" ON "workflow_tasks" ("runId");
CREATE INDEX IF NOT EXISTS "workflow_tasks_key_index" ON "workflow_tasks" ("resumeKeyId");
CREATE INDEX IF NOT EXISTS "workflow_tasks_due_index" ON "workflow_tasks" ("dueAt") WHERE "status" IN ('open', 'claimed');

-- WHO ANSWERED a waiting step. A screen submit or an approval used to record
-- what was answered and never by whom.
ALTER TABLE "workflow_step_runs" ADD COLUMN IF NOT EXISTS "actorUserId" varchar(25);

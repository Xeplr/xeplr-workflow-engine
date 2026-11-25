-- 0027_task_reminders.sql
--
-- REMINDERS & ESCALATION ON A TASK (lib/tasks.js planNudges / sweepNudges).
-- An approval or a screen step carries `reminders` in its values:
--
--   { remind:   [{ after, unit, by: ['email','app','phone'] }, …],
--     escalate: { after, unit, to: { kind, value }, keep } }
--
-- When a task opens, that becomes its own plan, in real times:
--
--   nudges        { remind: [{ at, after, unit, by, sentAt }], escalate:
--                   { at, after, unit, to, keep, doneAt } } — what is due when,
--                   and what has already happened
--   nextNudgeAt   the soonest thing still to happen, or null. The sweep finds
--                   tasks by it and CLAIMS one by moving it with a conditional
--                   update, so several processes send a reminder once
--   alsoFor       who else may answer, after an escalation that kept the task
--                   with the first person: [{ email } | { userId } | { role }]
--
-- A task that is answered, withdrawn or cancelled leaves the 'open'/'claimed'
-- statuses, and the sweep reads only those — so nothing is sent after a
-- decision, with nothing to remove.
ALTER TABLE "workflow_tasks" ADD COLUMN IF NOT EXISTS "nudges" jsonb;
ALTER TABLE "workflow_tasks" ADD COLUMN IF NOT EXISTS "nextNudgeAt" timestamptz;
ALTER TABLE "workflow_tasks" ADD COLUMN IF NOT EXISTS "alsoFor" jsonb;
CREATE INDEX IF NOT EXISTS "workflow_tasks_nudge_index" ON "workflow_tasks" ("nextNudgeAt") WHERE "status" IN ('open', 'claimed');

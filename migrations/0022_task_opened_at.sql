-- 0022_task_opened_at.sql
--
-- WHEN A TASK OPENED, AS AN INSTANT. The inbox showed "waiting 6 hours" on a
-- task opened a minute ago: recordCreatedDate is a plain timestamp, and read
-- back in a server timezone other than UTC it moves by the offset (India:
-- 5½ hours). Every other time on a task (dueAt, claimedAt, decidedAt) is
-- already timestamptz; this one is now too. Tasks from before keep reading
-- recordCreatedDate.
ALTER TABLE "workflow_tasks" ADD COLUMN IF NOT EXISTS "openedAt" timestamptz;

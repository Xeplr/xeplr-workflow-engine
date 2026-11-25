-- 0026_waits.sql
--
-- WAITING ON TIME, AND FOR SOMETHING TO ARRIVE (lib/actions/wait.js,
-- lib/waits.js). A Wait step parks the run on its resume key, as every wait
-- does, and says on that key when to wake it:
--
--   wakeAt       when the wait ends by itself: the time or date waited for,
--                or — for a wait on something arriving — when it has taken
--                too long. Null: only an answer (a reply, an arrival) ends it
--   wakeOutput   what the step hands on when wakeAt passes: { waited: true }
--                or { arrived: false, tooLong: true }
--   watch        for a wait on something arriving: what to check
--                ({ actionName, input, everyMs }) — a folder (file-list) or a
--                mailbox (email-read)
--   nextCheckAt  when that check is next due. Claimed by moving it forward
--                with a conditional update, so two processes check once
--
-- A WATCH TRIGGER ("start when a file arrives / an email arrives") remembers
-- what it has already started runs for, so a file still in the folder is not
-- started again on the next check:
--
--   workflow_trigger_states.seen         keys of what was found (newest kept)
--   workflow_trigger_states.lastCheckedAt
ALTER TABLE "workflow_resume_keys" ADD COLUMN IF NOT EXISTS "wakeAt" timestamptz;
ALTER TABLE "workflow_resume_keys" ADD COLUMN IF NOT EXISTS "wakeOutput" jsonb;
ALTER TABLE "workflow_resume_keys" ADD COLUMN IF NOT EXISTS "watch" jsonb;
ALTER TABLE "workflow_resume_keys" ADD COLUMN IF NOT EXISTS "nextCheckAt" timestamptz;
CREATE INDEX IF NOT EXISTS "workflow_resume_keys_wake_index" ON "workflow_resume_keys" ("wakeAt") WHERE "consumedDate" IS NULL;
CREATE INDEX IF NOT EXISTS "workflow_resume_keys_check_index" ON "workflow_resume_keys" ("nextCheckAt") WHERE "consumedDate" IS NULL;

ALTER TABLE "workflow_trigger_states" ADD COLUMN IF NOT EXISTS "seen" jsonb;
ALTER TABLE "workflow_trigger_states" ADD COLUMN IF NOT EXISTS "lastCheckedAt" timestamptz;

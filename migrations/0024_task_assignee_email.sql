-- 0024_task_assignee_email.sql
--
-- AN APPROVER BY EMAIL. An approval step names roles ("QA Head") or people by
-- their email address (asha@acme.com) — never a user id, which nobody
-- designing a workflow knows or should have to look up. A task for an email
-- is that person's: matched against the signed-in user's email, the way a
-- task for a role is matched against their roles.
ALTER TABLE "workflow_tasks" ADD COLUMN IF NOT EXISTS "assigneeEmail" varchar(320);

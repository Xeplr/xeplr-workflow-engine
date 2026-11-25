-- 0028_run_times_are_instants.sql
--
-- A RUN'S TIMES AS INSTANTS. The run list said a 1½-minute run took
-- "5 h 31 min". workflow_runs.startedAt / finishedAt (and a resume key's
-- consumedDate) were plain `timestamp`: the runner writes an ISO instant
-- ("…Z"), Postgres drops the zone and keeps the UTC wall time, and a server
-- in another timezone reads it back as LOCAL time — India: 5½ hours early.
-- So a run's start moved back by the offset, and its duration grew by it.
--
-- timestamptz, reading what is stored as the UTC it always was. The same fix
-- 0022 made for a task's openedAt.
ALTER TABLE "workflow_runs" ALTER COLUMN "startedAt" TYPE timestamptz USING "startedAt" AT TIME ZONE 'UTC';
ALTER TABLE "workflow_runs" ALTER COLUMN "finishedAt" TYPE timestamptz USING "finishedAt" AT TIME ZONE 'UTC';
ALTER TABLE "workflow_resume_keys" ALTER COLUMN "consumedDate" TYPE timestamptz USING "consumedDate" AT TIME ZONE 'UTC';

-- 0019_paths_versions_recovery.sql
--
-- A RUN SURVIVES A CRASH AND A DESIGN EDIT, and has room to be in more than
-- one place at once. Four things.
--
-- 1. PATHS. Where a run is, as a row, instead of something inferred from its
--    step runs. Today every run has exactly one path, so nothing behaves
--    differently; this is the shape the next change needs, where one case
--    waits on two approvers at the same time and each wait is its own path.
--    `splitId`, `parentPathId` and `round` are written by that change and stay
--    null / 0 until then.
--
--    status: ready · running · waiting · done · failed · cancelled
CREATE TABLE IF NOT EXISTS "workflow_run_paths" (
  "id" varchar(25) PRIMARY KEY,
  "runId" varchar(25) NOT NULL,
  "parentPathId" varchar(25),
  "splitId" varchar(25),
  "stepKey" varchar(64),
  "status" varchar(20) NOT NULL DEFAULT 'ready',
  "round" integer NOT NULL DEFAULT 0,
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
CREATE INDEX IF NOT EXISTS "workflow_run_paths_run_index" ON "workflow_run_paths" ("runId");

ALTER TABLE "workflow_step_runs" ADD COLUMN IF NOT EXISTS "pathId" varchar(25);
ALTER TABLE "workflow_resume_keys" ADD COLUMN IF NOT EXISTS "pathId" varchar(25);

-- 2. VERSIONS. A run reads the steps it STARTED with for its whole life. A
--    flow's design is saved by deleting and re-inserting its steps, so a run
--    parked on a screen whose step was re-inserted under a new id could not
--    be resumed at all, and an ordinary edit changed what half-finished runs
--    did next. A version is written the first time a run starts on a set of
--    steps nobody has run before (`fingerprint` = a hash of them), so no save
--    route has to remember to cut one.
--
--    Runs from before this have no versionId and keep reading live steps.
CREATE TABLE IF NOT EXISTS "workflow_versions" (
  "id" varchar(25) PRIMARY KEY,
  "workflowId" varchar(25) NOT NULL,
  "version" integer NOT NULL,
  "fingerprint" varchar(64) NOT NULL,
  "steps" jsonb NOT NULL,
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
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_versions_number_unique" ON "workflow_versions" ("workflowId", "version");
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_versions_fingerprint_unique" ON "workflow_versions" ("workflowId", "fingerprint");

ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "versionId" varchar(25);

-- 3. THE LEASE. A process moving a run holds it until `lockedUntil` and
--    renews it while a step is working. A process that dies stops renewing,
--    and the sweeper (lib/recovery.js) finds a run still 'running' whose lease
--    has passed. Before this a crash mid-step left the run 'running' forever.
--    An instant, so timestamptz — read back in another timezone a plain
--    timestamp would expire hours early or late.
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "lockedUntil" timestamptz;
CREATE INDEX IF NOT EXISTS "workflow_runs_lease_index" ON "workflow_runs" ("lockedUntil") WHERE "status" = 'running';

-- 4. A WAIT THAT EXPIRES. workflow_steps.timeoutMs existed and nothing read
--    it. The moment a wait step parks, its key gets `expiresAt`; the sweeper
--    resolves an expired key as failed, and the step's onError and arrows
--    decide what happens next.
ALTER TABLE "workflow_resume_keys" ADD COLUMN IF NOT EXISTS "expiresAt" timestamptz;
CREATE INDEX IF NOT EXISTS "workflow_resume_keys_expiry_index" ON "workflow_resume_keys" ("expiresAt") WHERE "consumedDate" IS NULL;

-- Every run not yet finished gets its one path, at the step it is on, and its
-- live key is tied to that path. Finished runs are history and get none.
INSERT INTO "workflow_run_paths" ("id", "runId", "stepKey", "status", "round", "mtId1", "mtId2", "mtId3", "mtId4", "recordCreatedDate")
SELECT
  'p' || substr(md5(r."id"), 1, 24),
  r."id",
  (SELECT sr."stepKey" FROM "workflow_step_runs" sr WHERE sr."runId" = r."id" ORDER BY sr."recordCreatedDate" DESC LIMIT 1),
  CASE r."status" WHEN 'waiting' THEN 'waiting' WHEN 'running' THEN 'running' ELSE 'ready' END,
  0, r."mtId1", r."mtId2", r."mtId3", r."mtId4", now()
FROM "workflow_runs" r
WHERE r."status" IN ('queued', 'running', 'waiting')
  AND NOT EXISTS (SELECT 1 FROM "workflow_run_paths" p WHERE p."runId" = r."id");

UPDATE "workflow_resume_keys" k
SET "pathId" = p."id"
FROM "workflow_run_paths" p
WHERE p."runId" = k."runId" AND k."consumedDate" IS NULL AND k."pathId" IS NULL;

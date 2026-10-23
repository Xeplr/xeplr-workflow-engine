-- 0007_workflow_resume_keys.sql
-- workflow_resume_keys — the whole mechanism behind a 'wait' step, in one
-- table. When a wait step starts, the engine mints a random opaque `key`
-- here (NOT encrypted, NOT signed — just a securely random, one-time id, same
-- as every other row's `id` in this app) and hands it to the step's own
-- values as `{resumeKey}`, so the command can embed it wherever its channel
-- needs it: a confirmation link, a hidden field, an approval URL.
--
-- The consumer-side contract is exactly one call:
--   workflowRunner.resumeByKey(key, output)
-- It never needs to know which run or step the key belongs to — that lookup
-- lives entirely in this table, keyed by `key` alone. This is what lets
-- fan-out (see workflow_run_edges) work with zero changes to this mechanism:
-- once each matching item is its own child run, each one only ever has ONE
-- live pending key at a time, so there is never a collision to resolve.
--
-- `consumedDate` is set the moment resumeByKey succeeds OR the run advances
-- past this step by any other path (a transition routing elsewhere, the step
-- timing out) — a consumed or superseded key must not resolve a second call,
-- whether that call is a genuine retry or a stale/replayed link (an email
-- security scanner pre-fetching a confirmation URL is the case this is
-- actually for).

CREATE TABLE "workflow_resume_keys" (
  "id" varchar(25) PRIMARY KEY,
  "runId" varchar(25) NOT NULL,
  "stepId" varchar(25) NOT NULL,
  "key" varchar(64) NOT NULL,
  "consumedDate" timestamp,
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

CREATE UNIQUE INDEX "workflow_resume_keys_key_unique" ON "workflow_resume_keys" ("key");
CREATE INDEX "workflow_resume_keys_run_index" ON "workflow_resume_keys" ("runId");

-- 0020_splits_and_meeting_points.sql
--
-- ONE CASE, SEVERAL PLACES AT ONCE. A refund waits on Meera and Neil at the
-- same time; the case moves on when both have answered, or as soon as one
-- rejects. Before this a run could wait on one thing only, and parallel work
-- existed only as separate child runs (an `each` arrow).
--
-- 1. HOW A STEP LEAVES AND ARRIVES.
--    leave: 'first' (null, the default — the first matching arrow, as always)
--           'every' — every matching arrow opens its own path
--    join:  null — every path that arrives runs the step (as always)
--           { wait: 'all' | 'any' | { atLeast: N }, stopWhen?, others? } —
--           a MEETING POINT: it runs once, when enough of the paths opened by
--           the split before it have arrived.
ALTER TABLE "workflow_steps" ADD COLUMN IF NOT EXISTS "leave" varchar(10);
ALTER TABLE "workflow_steps" ADD COLUMN IF NOT EXISTS "join" jsonb;

-- 2. A SPLIT: a step that opened paths, each time it ran. `opened` is what it
--    actually opened — an arrow whose condition was false opened nothing, so
--    no meeting point ever waits for it. Going back to the split step later
--    is a new row, so a meeting point counts afresh. `joinedAt` says the
--    meeting point has run for it; arrivals after that are late and move
--    nothing.
CREATE TABLE IF NOT EXISTS "workflow_run_splits" (
  "id" varchar(25) PRIMARY KEY,
  "runId" varchar(25) NOT NULL,
  "stepKey" varchar(64) NOT NULL,
  "pathId" varchar(25),
  "parentSplitId" varchar(25),
  "opened" integer NOT NULL,
  "joinStepKey" varchar(64),
  "joinedAt" timestamptz,
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
CREATE INDEX IF NOT EXISTS "workflow_run_splits_run_index" ON "workflow_run_splits" ("runId");

-- 3. AN ARRIVAL: a path reaching a meeting point, with what it brought — the
--    output of the step before, and its decision when it had one
--    (`decision`, or a screen's button as `action`). One per path per split.
CREATE TABLE IF NOT EXISTS "workflow_run_arrivals" (
  "id" varchar(25) PRIMARY KEY,
  "runId" varchar(25) NOT NULL,
  "splitId" varchar(25) NOT NULL,
  "pathId" varchar(25) NOT NULL,
  "stepKey" varchar(64) NOT NULL,
  "fromStepKey" varchar(64),
  "decision" varchar(64),
  "output" jsonb,
  "late" boolean NOT NULL DEFAULT false,
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
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_run_arrivals_path_unique" ON "workflow_run_arrivals" ("splitId", "pathId");

-- 4. The path that carries on from a meeting point says which split it
--    closed, so the meeting step and its arrows can read `arrivals`.
ALTER TABLE "workflow_run_paths" ADD COLUMN IF NOT EXISTS "fromSplitId" varchar(25);

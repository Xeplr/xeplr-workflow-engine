-- 0004_workflow_steps.sql
-- workflow_steps — one call to one registered action, plus what happens after
-- it. `actionName` is a REFERENCE INTO THE @xeplr/actions REGISTRY, not a copy
-- of the action: no code, no endpoint, no credentials live here. A step whose
-- action the registry does not have cannot run, which is reported rather than
-- guessed at.
--
-- `values` is the argument object, and its string values may carry
-- placeholders — `{previous_step.output.x}`, `{steps.<key>.output.x}`,
-- `{params.x}`, and for a `kind = 'wait'` step, `{resumeKey}` — resolved by
-- @xeplr/schema-handler's templating against the run's context before the
-- action is called.
--
-- `kind`: 'auto' runs and advances the moment it finishes; 'wait' pauses the
-- run after starting — the command it calls is responsible for eventually
-- resolving the pause via workflowRunner.resumeByKey(key, output). See
-- 0007_workflow_resume_keys.sql for how that key is tracked.
--
-- `transitions` is an ordered array of
--   { condition, mode: 'single' | 'each', target }
-- evaluated top to bottom — first match wins. `condition` is a structured
-- @xeplr/expression-handler expression ({ left, op, right }) or null/absent,
-- which always matches (the catch-all row). `target` is another step's
-- `stepKey`, or the sentinel 'end_success' / 'end_failed'. A step with no
-- transitions at all keeps the old default: advance to the next step by
-- `position`. A step WITH transitions that finds no match (and has no
-- catch-all row) fails — silently falling through would hide a branch nobody
-- accounted for.
--
-- A transition marked 'each' fans the rest of that branch out once per
-- matching element instead of running it once — see workflow_run_edges for
-- how the resulting child runs relate back to this one. `joinStep`, if set,
-- names a step to run a single time once every one of those children has
-- finished (e.g. batch-move everything that was downloaded, instead of once
-- per item); only meaningful when at least one transition here is 'each'.
--
-- `onError` is unrelated to transitions — it governs what happens when the
-- action call itself throws (bad input, unreachable endpoint), not how a
-- successful result is routed: 'stop' (default) halts the run, 'continue'
-- lets the rest of the steps proceed regardless.
--
-- `stepKey` is how another step's transition or a later step's bound value
-- addresses this one. Author-facing and stable across reordering, which
-- `position` is not — insert a step in the middle and every position below it
-- changes, so a reference by position would silently start reading a
-- different step's output.

CREATE TABLE "workflow_steps" (
  "id" varchar(25) PRIMARY KEY,
  "workflowId" varchar(25) NOT NULL,
  "stepKey" varchar(64) NOT NULL,
  "name" varchar(255),
  "actionName" varchar(128) NOT NULL,
  "values" jsonb,
  -- auto · wait
  "kind" varchar(20) NOT NULL DEFAULT 'auto',
  -- Only meaningful for kind = 'wait'. Milliseconds; null means no expiry.
  "timeoutMs" integer,
  -- stop · continue — what an execution failure of THIS step means for the
  -- rest of the run.
  "onError" varchar(20) DEFAULT 'stop',
  "transitions" jsonb,
  "joinStep" varchar(64),
  "position" integer DEFAULT 0,
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

CREATE INDEX "workflow_steps_workflow_index" ON "workflow_steps" ("workflowId");
-- Two steps with one key would make a `steps.<key>.output` reference (and a
-- transition `target`) ambiguous — resolving to whichever the reader picks.
CREATE UNIQUE INDEX "workflow_steps_key_unique" ON "workflow_steps" ("workflowId", "stepKey");

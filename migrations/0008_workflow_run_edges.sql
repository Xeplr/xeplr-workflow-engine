-- 0008_workflow_run_edges.sql
-- workflow_run_edges — the ONLY place a workflow run's family tree lives.
-- workflow_steps stays flat by design (fan-out is a run-time decision, never
-- an authoring-time one — see the 'each' transition mode in
-- 0004_workflow_steps.sql), so nothing about a run's ancestry belongs on the
-- step definition. This table is the edge itself: one row per parent → child
-- run relationship, created once when an 'each' transition matches more than
-- zero elements.
--
-- `sourceStepKey` names which step's transition did the fanning out, so a
-- parent's timeline can say "this child came from check_unread_mail" without
-- guessing. `itemIndex` / `itemKey` position the child within that fan-out —
-- `itemKey` is a stable identifier from the item itself when one exists (an
-- email's message-id, say) rather than just an index, so a retry or a re-run
-- can still tell which item is which. `item` is the same value the child run
-- also carries on its own `item` column — kept here too because this table,
-- not the run, is what a parent's UI would actually join through to list
-- "everything this step fanned out into."
--
-- One child never has two parents: `childRunId` is unique. A parent can have
-- many children, which is the whole point.

CREATE TABLE "workflow_run_edges" (
  "id" varchar(25) PRIMARY KEY,
  "parentRunId" varchar(25) NOT NULL,
  "childRunId" varchar(25) NOT NULL,
  "sourceStepKey" varchar(64),
  "itemIndex" integer,
  "itemKey" varchar(255),
  "item" jsonb,
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

CREATE INDEX "workflow_run_edges_parent_index" ON "workflow_run_edges" ("parentRunId");
CREATE UNIQUE INDEX "workflow_run_edges_child_unique" ON "workflow_run_edges" ("childRunId");

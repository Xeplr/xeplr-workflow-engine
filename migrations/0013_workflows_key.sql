-- 0013_workflows_key.sql
-- `key` — HOW AN APP THAT IS NOT THIS ONE NAMES A WORKFLOW.
--
-- Added for kind = 'screens' (a "flow"): a workflow whose every step shows a
-- screen to a person and waits for them to submit it. A flow is designed and
-- run through the /flows facade (lib/flows.js) by a different app —
-- the one that owns the screens — and that app knows its flows by names it
-- chose ('onboard_employee'), not by ids minted here. Every /flows route is
-- addressed by this key.
--
-- ── why 'screens' needs no column of its own ────────────────────────────
--
-- `workflows.kind` (0012) is already an unconstrained VARCHAR(32) with no
-- CHECK and no enum type — it was written that way deliberately, because the
-- next kind after 'jobs' was already visible. 'screens' is that next kind, so
-- it lands with no DDL at all; the list of accepted values lives in the
-- model's jsonSchema, where a bad value is refused with the field named rather
-- than as a constraint violation.
--
-- The engine still never reads `kind` — a screen step is an ordinary wait step
-- whose action happens to do nothing. What the value decides is WHO MAY EDIT
-- THE ROW: the workflow document's own save route refuses a 'screens'
-- workflow, because those steps are generated from a design held in the other
-- app and a hand edit here would be silently overwritten by the next PUT
-- /flows/:key. Reading and running are untouched, so runs and history stay
-- visible in the builder.
--
-- ── the uniqueness rule ─────────────────────────────────────────────────
--
-- A key identifies a flow WITHIN A TENANT, not globally: two companies each
-- having an 'onboard_employee' flow is the normal case, and making the key
-- globally unique would let the first company to use a word take it from
-- everyone. So the index is over the tenant slots plus the key.
--
-- COALESCE on the mt columns because Postgres treats NULLs as distinct in a
-- unique index: an app that registered only one tenant level leaves mtId2
-- null, and without this every row would look unique to the index and the
-- duplicate it exists to prevent would be inserted happily.
--
-- Partial (WHERE "key" IS NOT NULL) because ordinary workflows and jobs
-- canvases have no key and never will — they are found by id — and hundreds of
-- null-keyed rows should not have to fit through this index.

ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "key" varchar(64);

CREATE UNIQUE INDEX IF NOT EXISTS "workflows_key_unique"
  ON "workflows" (COALESCE("mtId1", ''), COALESCE("mtId2", ''), "key")
  WHERE "key" IS NOT NULL;

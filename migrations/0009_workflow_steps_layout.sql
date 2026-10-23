-- 0009_workflow_steps_layout.sql
-- Canvas position is NOT execution order. `position` (0004) is an integer
-- used to sequence steps when a step has no transitions of its own — insert
-- one in the middle and every position below it shifts. Where a step sits on
-- the builder's free-form canvas is a separate, purely visual concern: two
-- steps can be dragged anywhere relative to each other without changing what
-- runs after what. `layout` is { x, y } in canvas pixels; null until a step
-- has been placed by hand, at which point the builder can lay new steps out
-- automatically (e.g. left to right by `position`).

ALTER TABLE "workflow_steps" ADD COLUMN "layout" jsonb;

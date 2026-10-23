-- 0010_workflow_steps_sample_output.sql
-- What this step is EXPECTED to return, as an example — never what it did
-- return. Purely a builder concern, like `layout` (0009), and never read by
-- workflowRunner: a real run's output lives on workflow_step_runs.
--
-- It exists because binding one step to another is otherwise done from memory.
-- A later step's value binds to {steps.<key>.output.something} and a
-- transition tests output.something, and until now nothing in the product
-- could tell you what `something` is for a given action — you either ran the
-- workflow and read the run record, or you guessed. Recording a sample lets
-- the step editor offer the real field names in a picker, which is also what
-- makes a mistyped binding catchable at build time rather than at run time.
--
-- Nullable, and null simply means the picker has nothing to offer for that
-- step yet — every existing step keeps working untouched.

ALTER TABLE "workflow_steps" ADD COLUMN "sampleOutput" jsonb;

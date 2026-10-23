-- 0016_after_job_shortcut.sql
--
-- CONVERTED CHAINS, READABLE BY THE JOBS SCREEN AGAIN.
--
-- The first release of 0015 converted each job chain into an ordinary
-- workflow, but with no key and with arrows holding only their compiled
-- conditions. The jobs screen's "After this job" finds a job's rules by the
-- key `after-job-<jobId>` and reads each arrow's `when`, so a converted chain
-- showed as "changed in the workflow screens" instead of as its rules. 0015
-- now does both; this repairs a database that ran it before it did. On any
-- other database it changes nothing.
--
-- (No jsonb key-exists operator anywhere: the migrator's driver takes that
-- character as a parameter placeholder. jsonb_typeof(x->'k') is NULL exactly
-- when k is absent.)
--
-- 1. The key, for a converted chain that has none (and only if the job has
--    no shortcut already).
UPDATE "workflows" w
   SET "key" = 'after-job-' || (w."trigger"->>'jobId')
 WHERE w."key" IS NULL
   AND w."trigger"->>'kind' = 'job'
   AND w."description" LIKE 'Made from the "After this job" rules of job %'
   AND NOT EXISTS (
     SELECT 1 FROM "workflows" o
      WHERE o."key" = 'after-job-' || (w."trigger"->>'jobId')
        AND COALESCE(o."mtId1", '') = COALESCE(w."mtId1", '')
        AND COALESCE(o."mtId2", '') = COALESCE(w."mtId2", ''));

-- 2. `when` on each of their decide step's arrows, rebuilt from the compiled
--    condition: none is "otherwise"; a single comparison is { field, op,
--    value } in the jobs screen's own words. A nested all/any is left as it
--    is — the jobs screen then says it was changed elsewhere, and it still
--    runs exactly as before.
UPDATE "workflow_steps" s
   SET "transitions" = (
     SELECT COALESCE(jsonb_agg(
       CASE
         WHEN jsonb_typeof(x.t->'when') IS NOT NULL THEN x.t
         WHEN jsonb_typeof(x.t->'condition') IS NULL OR jsonb_typeof(x.t->'condition') = 'null' THEN x.t || '{"when": null}'::jsonb
         WHEN jsonb_typeof(x.t->'condition'->'left') IS NOT NULL AND (CASE x.t->'condition'->>'op'
                WHEN 'eq' THEN '=' WHEN 'neq' THEN '!=' WHEN 'gt' THEN '>' WHEN 'gte' THEN '>='
                WHEN 'lt' THEN '<' WHEN 'lte' THEN '<=' WHEN 'contains' THEN 'contains'
                WHEN 'notContains' THEN 'notContains' WHEN 'startsWith' THEN 'startsWith'
                WHEN 'endsWith' THEN 'endsWith' WHEN 'in' THEN 'in' WHEN 'notIn' THEN 'notIn'
                WHEN 'between' THEN 'between' WHEN 'isNull' THEN 'isEmpty' WHEN 'isNotNull' THEN 'isNotEmpty'
              END) IS NOT NULL
           THEN x.t || jsonb_build_object('when', jsonb_strip_nulls(jsonb_build_object(
             'field', x.t->'condition'->'left'->>'field',
             'op', CASE x.t->'condition'->>'op'
                WHEN 'eq' THEN '=' WHEN 'neq' THEN '!=' WHEN 'gt' THEN '>' WHEN 'gte' THEN '>='
                WHEN 'lt' THEN '<' WHEN 'lte' THEN '<=' WHEN 'contains' THEN 'contains'
                WHEN 'notContains' THEN 'notContains' WHEN 'startsWith' THEN 'startsWith'
                WHEN 'endsWith' THEN 'endsWith' WHEN 'in' THEN 'in' WHEN 'notIn' THEN 'notIn'
                WHEN 'between' THEN 'between' WHEN 'isNull' THEN 'isEmpty' WHEN 'isNotNull' THEN 'isNotEmpty'
              END,
             'value', x.t->'condition'->'right'->'value')))
         ELSE x.t
       END ORDER BY x.ord), '[]'::jsonb)
     FROM jsonb_array_elements(s."transitions") WITH ORDINALITY AS x(t, ord))
  FROM "workflows" w
 WHERE w."id" = s."workflowId"
   AND w."key" LIKE 'after-job-%'
   AND s."stepKey" = 'decide' AND s."actionName" = 'decide'
   AND s."transitions" IS NOT NULL;

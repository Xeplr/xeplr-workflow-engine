# @xeplr/workflow-engine — map

The free workflow engine: runs, steps (= `@xeplr/actions` actions), arrows/conditions, parallel
paths, waits, tasks/approvals, triggers. No HTTP — `@xeplr/workflow-api` adds the routes; hosts
(BI, CLI apps) embed both. It has NO clock of its own: scheduling and due work go through
`@xeplr/jobs`, reached only through functions the host passes in.

## Where things are
- `index.js` — `startEngine(config)` (connect, migrate, register actions, wire host hooks, keep the due job), `resumeByKey()`, `embedRequiredEnv` (`DB_WORKFLOW`), `callbackRequiredEnv` (`WORKFLOW_PUBLIC_URL`), `MIGRATIONS_DIR`, `TENANT_MIGRATIONS_DIR`; re-exports every lib below
- `lib/workflowRunner.js` — the run loop: `startRun()`, `walk()`, `routeAfterStep()`, `buildContext()`, `stepInput()`/`resolveTyped()`, paths/splits/`meet()`, `underLease()` (lease heartbeat), `resumeByKey()`, `recoverRun()`, `cancelRun()`, `retryRun()`, `pollStep()`, `runCheck()`, `resolveParams()`/`collectParams()`, `setConnectionResolver()`
- `lib/flows.js` — the facade the API's `/flows` routes call: `listFlows`, `createFlow`, `putFlow`, `publishFlow`, `startFlowRun`, `getRun`, `submitRun`, `listRuns`, `listWaiting`, `validateFlow()`, `toStepRows()`, `whenToCondition()`
- `lib/triggers.js` — trigger kinds registry (`registerTrigger`, `catalog`, `validate`), `fire()`, `emit()`, `checkWatches()`, `windowFor(period, at, zone)`, `isOn()`
- `lib/schedules.js` — jobs as the clock: `specFor(workflow)`, `sync()`/`syncLater()` (called from `models/Workflow.js` after writes, after commit), `keepDueJob()`, `DUE_JOB` (`workflow-due`, `* * * * *`, system), `jobActions` = `workflow-scheduled` + `workflow-due`
- `lib/jobs.js` — host hooks `setJobStarter()`/`jobStarter()`, `setScheduleKeeper()`/`scheduleKeeper()`; `jobFinished(report)` (jobs' `onFinish` → resume the job-run step, fire `job` triggers), `nextJobCall()`
- `lib/recovery.js` — `sweep()`: stale runs, expired waits, `tasks.sweepDue`/`sweepNudges`, `waits.wakeDue`, `triggers.checkWatches` (run by the `workflow-due` job)
- `lib/tasks.js` — inbox and approvals: `listMine`, `claim`, `release`, `answer`, `answerApproval`, `reassign`, `afterPark`, `sweepDue`, `sweepNudges`, `setTaskHook()` (host's `onTask`)
- `lib/waits.js` (`wakeDue`), `lib/conditions.js` (arrow `when` → condition, `compileJoin`), `lib/versions.js` (`pinVersion`, `stepsForRun`), `lib/stepReport.js` (`open()` → `onProgress`/`log`/`signal`, `abortRun()`), `lib/envExposed.js` (env names a step may read), `lib/actionCatalog.js` (`registerAll()`: `WANTED` builtins, `LOCAL`, `HIDDEN`, `JOB_ONLY`)
- `lib/actions/` — engine-own actions: `approval`, `decide`, `job-run`, `remember`/memory, `wait`, `screen-show`, `workflow-poll` (hidden)
- `lib/db.js` — `connectDb()` (secondary connection, `bind:false`), `model(name)`; `db/xcfgSetup.js` — `xeplr_configs` meta store
- `models/` — Workflow, WorkflowStep, WorkflowRun, WorkflowStepRun, WorkflowRunPath/Split/Arrival/Edge, WorkflowTask, WorkflowResumeKey, WorkflowTriggerState, WorkflowMemory, WorkflowVersion, Company, Workspace
- `migrations/` (SQL, workflow DB), `migrations-tenants/` (standalone companies/workspaces)

## Flow
- Start: `flows.startFlowRun()` or `triggers.fire()` → `workflowRunner.startRun()` → `walk()` under `underLease()` → each step: `stepInput()` → `actions.runAction()` with `system.{onProgress,log,signal}` → `routeAfterStep()` (conditions, split/meet) → park (wait/task/job-run) or finish.
- Schedule: save Workflow → `models/Workflow.js` hook → `schedules.syncLater()` → host `keepSchedule(workflowId, specFor())` → a job with action `workflow-scheduled` → jobs runs it → `triggers.fire(w, {kind:'schedule', dueAt, window})`.
- Due work: `startEngine` → `keepDueJob()` (system job) → every minute jobs runs `workflow-due` → `recovery.sweep()`.
- Job steps: `job-run` → host `startJob` (or `jobsUrl` HTTP) → parked → host passes jobs' `onFinish` to `jobFinished()` → step resumed.
- Resume: host route → `resumeByKey(key, output)` → runner continues.

## To change X, edit Y
- A new engine step → `lib/actions/<name>.js` + add to `LOCAL` in `lib/actionCatalog.js`
- Offer/hide an `@xeplr/actions` builtin as a step → `lib/actionCatalog.js` → `WANTED` / `HIDDEN`
- A new trigger kind → `lib/triggers.js` → `registerTrigger()` (or host calls it)
- Schedule → job mapping (name, inputs, timezone) → `lib/schedules.js` → `specFor()`
- What the due sweep does → `lib/recovery.js` → `sweep()`
- Arrow conditions / joins → `lib/conditions.js`; flow validation → `lib/flows.js` → `validateFlow()`
- Step input templating / typed values → `lib/workflowRunner.js` → `buildContext()`, `resolveTyped()`
- Approvals, reminders, escalation → `lib/tasks.js`
- Lease timing → `startEngine({lease})` → `workflowRunner.setLeaseTiming()`
- New table/column → new `migrations/00NN_*.sql` + its model

## Rules and traps
- No own timers: the only `setInterval` is the lease heartbeat in `underLease()` (unref'd); `test/oneClock.test.mjs` fails on any other. Time-based work goes in `recovery.sweep()`, run by the `workflow-due` job.
- Without `config.keepSchedule`, schedule triggers are refused on save and nothing is due-checked — pass it in the process that serves the API. The host must also register `jobActions` with its jobs in every process that runs jobs.
- `workflow-scheduled`/`workflow-due` are `JOB_ONLY`: never offered as steps.
- Schedule sync waits for the save's commit (`syncLater` → `afterCommit`): the job lives in another DB.
- `startEngine` refuses without `registerApplication()` (applicationId is only for rows in shared `xeplr_configs`; workflow tables are isolated by their own DB — never share one workflow DB between two hosts).
- Host migrations come via `migrationsFor('workflow')` (`XEPLR_WORKFLOW_MIGRATIONS`); filenames must be unique across dirs.
- Steps store `connectionInfoId`, never a login; the host's `resolveConnection` turns it into one at call time.
- Steps get `system.signal` (`lib/stepReport.js`); a cancel from any process aborts it at the next report — new long-running actions must honour it (workspace rule: stops reach the DB).
- `connectDb` registers `mts` only once and only if given; embedded hosts must not pass it.

## Test
- `npm install && npm test` (`node test/run.mjs`, each `*.test.mjs` in its own process, scratch `XEPLR_DATA_DIR`).
- Real-Postgres suites (tasks, parallel, recovery, waits, polling, triggers, oneClock, …) need `WORKFLOW_TEST_PG='{"host":"localhost","port":5432,"user":"vikasbhandari","password":""}'`; skipped otherwise. Scratch DBs are created and dropped.
- Per-suite coverage: see README → Tests. The flows facade is tested from `@xeplr/workflow-api` (`test/flows.test.mjs`).

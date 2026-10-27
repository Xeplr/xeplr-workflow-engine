# @xeplr/workflow-engine

**The workflow engine, with no HTTP in it.** It owns workflow's database and tables, the action catalog, starting and resuming runs, and the flows facade (screens as steps). [`@xeplr/workflow-api`](https://github.com/Xeplr/xeplr-workflow-api) puts the routes on top.

**Free and open source (MIT, [LICENSE](LICENSE))**, on npm as `@xeplr/workflow-engine` and on GitHub at [Xeplr/xeplr-workflow-engine](https://github.com/Xeplr/xeplr-workflow-engine). With [`@xeplr/workflow-api`](https://github.com/Xeplr/xeplr-workflow-api) it is a complete base to automate with and to build your own workflow screens on: every action in `@xeplr/actions` (databases, files, email…), branching, fan-out, waits, job chains and screens as steps. **X-Flow**, Xeplr's premium workflow product, is built on these two packages and adds the visual designer (steps drawn and connected on a canvas) and data operations between steps; neither is part of this package.

```bash
npm install @xeplr/workflow-engine
```

## Use

```js
var engine = require('@xeplr/workflow-engine');

await engine.startEngine({
  db: { name: 'xeplr_bi_workflow', connection: conn, connectionName: 'workflow' }
});
var run = await engine.runner.startRun(workflowId, params, { user });
await engine.resumeByKey(key, { confirmedBy: userId });
```

Most hosts never call this directly: the API's `registerWorkflow()` calls `startEngine()` first and passes `resumeByKey` and the env lists through.

The shared `@xeplr/*` libraries (`actions`, `db`, `expression-handler`, `schema-handler`, `utils`) are **peer dependencies**. The host supplies them, so the engine reads the same tenant context and the same action registry as the host. Two copies of `@xeplr/db` would mean two tenant contexts, and a run started in one would not see the other's company.

## Exports (`index.js`)

| Export | Purpose |
|---|---|
| `startEngine(config)` | Connect workflow's database (creating it if missing), run its migrations, ready `xeplr_configs`, register the action catalog. Idempotent. `config.db` is required; throws if no application id is registered. Config: `db` (`{ name, connection, connectionName?, mts?, migrationsTable? }`), `applicationId`, `tenantTables`, `migrations`, `migrate` (`false`: connect without migrating — a second process of an install whose API migrates), `startJob` (below), `schedule` (`false`: no schedule tick in this process), `scheduleIntervalMs` (default 30000), `onTask` (`(event, task)`: told when a task opens, falls due, is escalated or reassigned, so the host notifies people), `recover` (`false`: no sweeper in this process — [Surviving a crash](#surviving-a-crash-and-a-design-edit)), `recoverIntervalMs` (default 30000), `lease` (`{ leaseMs, renewMs }`, default 2 min / 30 s) |
| `resumeByKey(key, output?, opts?)` | Server-side, in-process resume of a run parked on a `wait` step. `opts.status: 'failed'` resolves the step as failed. Throws `err.code` `RESUME_KEY_INVALID` (used/unknown, normal for host routes) or `RESUME_KEY_NOT_READY` (step still running; nothing consumed, retry) |
| `embedRequiredEnv` | `['DB_WORKFLOW']`, spread into a host's `env.required.js` |
| `callbackRequiredEnv` | `['WORKFLOW_PUBLIC_URL']`, only for hosts using steps that call out (`job-run`) |
| `MIGRATIONS_DIR`, `TENANT_MIGRATIONS_DIR` | Where the SQL is, for the standalone server and for a bundle that ships the folders |
| `db` | `connectDb`, with `.model(name)` bound to workflow's own connection |
| `runner` | `lib/workflowRunner.js`: `startRun`, `resumeByKey` (`opts.actor`: who answered), `resolveParams`, `collectParams`; admin `cancelRun(runId, { reason, actor })`, `retryRun(runId, { reason, actor })` |
| `tasks` | `lib/tasks.js`: `listMine(user, { limit, offset })`, `claim`, `release`, `answer(id, body, user)`, `reassign(id, { userId \| role }, { reason, actor })`, `sweepDue` ([Tasks](#tasks-and-approvals)) |
| `recovery` | `lib/recovery.js`: the sweeper — `sweep()` runs one pass now; `startSweeping`, `stopSweeping` |
| `versions` | `lib/versions.js`: `stepsForRun(run)` (the steps a run reads), `pinVersion(workflowId, steps)` |
| `flows` | `lib/flows.js`: the flows facade (list, create, put, publish, start, submit, runs) and `touchesScreens` |
| `triggers`, `registerTrigger` | `lib/triggers.js`: what starts a workflow — the registry of kinds, `validate`, `emit`, the schedule `tick`, `describe` ([Triggers](#triggers-libtriggersjs)) |
| `conditions` | `lib/conditions.js`: `whenToCondition`, `compileTransitions` ([Conditions](#conditions-written-simply-libconditionsjs)) |
| `jobs`, `jobFinished` | `lib/jobs.js`: jobs as steps and as triggers — `setJobStarter`, `jobFinished` ([Jobs](#jobs-as-steps-and-as-triggers-libjobsjs)) |
| `actionCatalog`, `envExposed`, `xcfgSetup` | The action whitelist (and `allowRetry(names)`: a host's own actions that are safe to run again after a crash), the `WORKFLOW_ENV_EXPOSED` allowlist, the shared `xeplr_configs` attachment |

The package reads `migrations/` and `migrations-tenants/` from disk (`"xeplr": { "readsFromDisk": [...] }` in `package.json`), so a build that compiles it must ship those folders beside it.

## Structure

```
engine/
├─ index.js                 startEngine, resumeByKey, the env lists, and the parts below
├─ lib/
│  ├─ workflowRunner.js     startRun, resumeByKey, resolveParams, collectParams, recoverRun
│  ├─ versions.js           the steps a run reads: pinned when it starts
│  ├─ recovery.js           the sweeper: runs whose process died, waits past their time, overdue tasks
│  ├─ tasks.js              what people answer: inbox, claim, answer, approvals, reassign
│  ├─ flows.js              the flows facade: screens as steps
│  ├─ triggers.js           what starts a workflow: manual, api, schedule, job, and more
│  ├─ jobs.js               jobs as steps (job-run) and as triggers (jobFinished)
│  ├─ conditions.js         an arrow's `when` compiled into its condition
│  ├─ actionCatalog.js      whitelist of @xeplr/actions built-ins + local actions (data-operation and export-table included)
│  ├─ actions/              local actions: job-run, decide, remember, recall, screen-show, approval
│  ├─ envExposed.js         WORKFLOW_ENV_EXPOSED allowlist for {env.*}
│  └─ db.js                 connectDb + model(name) bound to workflow's own connection
├─ db/xcfgSetup.js          shared @xeplr/actions attachConfig({ service: 'xeplr-workflow' })
├─ models/                  Company, Workspace, Workflow, WorkflowStep, WorkflowRun,
│                           WorkflowStepRun, WorkflowResumeKey, WorkflowRunEdge,
│                           WorkflowTriggerState, WorkflowMemory, WorkflowRunPath,
│                           WorkflowVersion, WorkflowRunSplit, WorkflowRunArrival
├─ migrations/              0003–0020, workflow's own tables
├─ migrations-tenants/      0001–0002: standalone workflow's companies / workspaces
└─ test/                    run.mjs + *.test.mjs
```

## Data model and migrations

Both run against workflow's own database:

| Directory | Target DB | How it runs |
|---|---|---|
| `migrations/` | workflow's own (`DB_API` standalone, `DB_WORKFLOW` in BI) | On every boot inside `startEngine` (and once more in the API's `standalone.js`); idempotent. Also the API's `npm run migrate:up`. Plain `.sql`, ledger-tracked by filename, `precede` order |
| `migrations-tenants/` | the same | Inside `startEngine` unless `tenantTables: false` |

| Migration | Creates |
|---|---|
| `0001_companies` | `companies` (l1 tenant) |
| `0002_workspaces` | `workspaces` (l2, under a company) |
| `0003_workflows` | `workflows` — `name`, `description`, `params` (jsonb), `status` (default `draft`) |
| `0004_workflow_steps` | `workflow_steps` — `stepKey` (unique per workflow), `actionName`, `values`, `kind` (`auto`/`wait`), `timeoutMs`, `onError` (`stop`/`continue`), `transitions`, `joinStep`, `position` |
| `0005_workflow_runs` | `workflow_runs` — `status` (`queued`/`running`/`waiting`/`success`/`failed`), `params`, `item`, `trigger`, timings, `error` |
| `0006_workflow_step_runs` | `workflow_step_runs` — copied `stepKey`/`actionName`, resolved `input`, `output`, `error` |
| `0007_workflow_resume_keys` | `workflow_resume_keys` — unique random `key`, `consumedDate` |
| `0008_workflow_run_edges` | `workflow_run_edges` — parent → child run for `each` fan-out; `childRunId` unique |
| `0009` | `workflow_steps.layout` (canvas `{x, y}`) |
| `0010` | `workflow_steps.sampleOutput` |
| `0011` | `workflow_steps.params` |
| `0012` | `workflows.kind` (`workflow` \| `jobs`, default `workflow`) |
| `0013` | `workflows.key` — a stable name a host addresses a flow by, unique per tenant while it is set |
| `0014` | `workflows.trigger` (jsonb) — **what is supposed to start a run**, beside what comes in with it. One shape per kind: `{kind:'manual'}`, `{kind:'api'}`, `{kind:'schedule',cron}`, `{kind:'file',folder,named}`, `{kind:'email',mailbox,folder}`. NULL means "started however it is called", so every existing workflow behaves exactly as it did. **Nothing arms these yet** — the designer records the intent; the pollers and the hook endpoint read it when they land |

| `0015`–`0018` | `workflows.trigger` state and `triggerData`, the after-job shortcut, `maxStepRuns` + `targetStepKey`, `workflow_memory` |
| `0021` | **Tasks.** `workflow_tasks` (a wait a person answers: assignee user or role, claim, decision, due/escalation, history); `workflow_step_runs.actorUserId` (who answered) |
| `0020` | **Splits and meeting points.** `workflow_steps.leave`, `workflow_steps.join`; `workflow_run_splits` (a step that opened paths, each time it ran: `opened`, `joinedAt`); `workflow_run_arrivals` (a path reaching a meeting point with its `decision` and `output`, `late` once met); `workflow_run_paths.fromSplitId` |
| `0019` | **Paths, versions, leases, expiring waits.** `workflow_run_paths` (where a run is — one per run for now); `workflow_versions` (the steps a run started with); `workflow_runs.versionId`, `workflow_runs.lockedUntil`; `workflow_step_runs.pathId`; `workflow_resume_keys.pathId`, `expiresAt`. Gives every unfinished run its path at upgrade |

Every table carries `mtId1`–`mtId4` and **no `applicationId`**: the database a
host gives workflow is the boundary.

## How a run behaves (`lib/workflowRunner.js`)

- **Step values** are resolved with `@xeplr/schema-handler`'s `resolveAll` against
  `{ params, item, steps.<key>.output, previous_step.output, env, resumeKey, resumeUrl }`.
  `previous_step`/`steps` come from what ran in this run, not array position.
  - **A value that is one binding keeps its type** (`from: "{steps.fetch.output.rows}"` hands over the list; `{params.count}` a number). Text around a binding makes text. A field the action declares `string` always gets text. Why: every value used to be text, so a list arrived as its JSON and the data step saw one row that was a string.
  - **Dates are written as asked:** `{trigger.window.from|date:YYYY-MM:Asia/Kolkata}`. A template that cannot be filled (a pipe on something that is not a date, an unknown zone) **fails the run**, naming the step, instead of running with an empty file name.
- **Routing**: no `transitions` → next step by `position`. With transitions →
  first match wins (`@xeplr/expression-handler`); a blank condition is the
  catch-all; targets are a `stepKey`, `end_success` (this path is done),
  `end_failed` (the run fails) or `end_run` (the whole case is done, whatever
  else is open). No match and no catch-all **fails the run**.
  - **Arrows read earlier steps**: `steps.<key>.output.*` as well as `output`,
    `item`, `params`, `trigger` — what a step's values could always read. A
    path reads its own steps and those before its split, never a parallel
    path's.
- **One case on several paths** ([below](#parallel-paths-and-meeting-points)): `leave: 'every'` and `join`.
- **Screens hand over to screens**: a flow's run view carries `previous` — what
  every screen submitted earlier in the run, keyed by screen key, the saved row
  as `values.id` (`lib/flows.js` `previousOf`). Read-only, built from the step
  runs; nothing new is stored, and nothing is checked between screens.
- **Letting a function decide**: a transition `{ decide: 'routeByAmount', targets?: [...] }`
  asks a function the app registered with `@xeplr/actions` under `event: 'decide'`
  where to go. It is called with `{ output, values (= output), params, item, trigger,
  step, runId, targets }` and returns a step key, `end_success` or `end_failed`;
  `targets`, when listed, are the steps it may choose (none: any step). A missing
  function, one written for another event, no answer, or an answer outside
  `targets` **fails the run**, naming the function. Functions registered with an
  `event` are screen functions, never steps: the action catalog leaves them out.
- **Saved connections:** a step stores `connectionInfoId` (and `sourceConnectionInfoId`, `targetConnectionInfoId`), never a password. Just before the action runs, the host's `resolveConnection` (a `startEngine` setting, the same function a host gives `@xeplr/jobs`) turns it into the login, in the call only (`@xeplr/actions`' `resolveConnections`). The step run's recorded `input` keeps the id. A connection that cannot be resolved fails the step (`CONNECTION_NOT_FOUND`), so `onError` and the arrows apply as to any failure. Before, a step needed the login written into it, and every run copied it into its record.
- **A screen inside a workflow** (`screen-show`, a `wait` step): `values` is what it is handed (rows for a table: `{ "lines": "{steps.match.output.rows}" }`), `assignTo` the role that answers it (empty: anyone in the company), `buttons` what it offers (`Approve, Send back`, or `[{ key: 'approve', label: 'Approve' }, …]`). It is in the action catalog now (it was hidden while no host could answer a screen); its `screen` and `assignTo` name option sources `screens` and `roles` for a host's pickers. The run view (`GET /flows/runs/:runId`) carries the step's `stepName` for a page title. `flows.listWaiting({ user })` is every screen waiting for someone with one of the user's roles (a Super Admin sees all). `flows.submitRun(runId, { values, action }, { user })` refuses someone without the role (`NOT_YOURS`), and with buttons it needs one of them (`ACTION_REQUIRED`, `ACTION_UNKNOWN`); the button pressed is the step's `output.action`, so arrows branch on it. No buttons: one Next, as before.
- **Memory between runs** (`remember` / `recall`, migration 0018 `workflow_memory`): one value per key per workflow, in the run's tenant. `recall` gives `{ found, value, at, runId }`; `remember` replaces the value (no value: just when), and `forget: true` removes it. A key usually carries the period (`bank-recon:{trigger.window.from|date:YYYY-MM}`), so a workflow starts by asking "is September already done?" and ends by saying it is.
- **A loop is stopped:** one step may run at most `maxStepRuns` times in one run (the workflow's setting; default 100, migration 0017). Past that the run fails with `LOOP_LIMIT`, saying how to allow more. An arrow back to an earlier step with no wait step on the way used to spin forever.
- **Going on past a failure follows the arrows** (`onError: 'continue'`): the step's output is `{ failed: true, error: { message, code } }`, the arrows are evaluated on it as on any output (`output.failed = true`), and later steps read it as `{steps.<key>.output.error.message}`. No arrows: the next step by position, as before. It used to go by position even when the step had arrows.
- **Fan-out**: a matching `each` transition goes through the list its `source`
  names (`output.rows`, `item.lines`, `params.…`, `trigger.…`) and creates one child run per matching
  element (`item`), recorded in `workflow_run_edges`. With `joinStep` the parent
  waits and resumes at the join once all children are terminal (guarded by an
  atomic `waiting → running` patch); without it the parent finishes.
  - **At most `limit` children run at once** (an arrow setting; default 10). The rest wait as `queued`, and each child that ends starts the next. A list of 500 used to start 500 runs at the same moment.
  - **Every run that ends tells its parent** (`finishRun` → `afterRunFinished`), however it ended. A child that paused on a wait step and finished on resume used to never tell it, so a parent waiting to join waited forever.
- **Wait steps**: the resume key row is written **before** the action runs;
  the run parks with status `waiting`. If the action fails the key is marked
  consumed.
- **Action failure**: `onError: 'continue'` advances by position; otherwise the
  run fails.
- **Run params**: the run schema is the union of every step's `params` (plus
  legacy `workflows.params` first). Any step requiring a name makes it required;
  otherwise first declaration by position wins. Validated with `applySchema`
  **before** the run row is inserted; undeclared keys are dropped; failure has
  `code: 'PARAMS_INVALID'` and `details`. A workflow that declares nothing
  accepts params unchanged.
- **A wait step's own key** reaches its action as `system.resumeKey` (and
  `{resumeKey}` / `{resumeUrl}` in its values), so an action can hand it to
  something in the same process instead of over a URL.
- **Tenant context**: after the first lookup, all DB work runs inside
  `runWithMt()` with the run's stored `mtId`s, because a resume can arrive long
  after the starting request.

Not read by the runner: `workflows.status`, `workflows.kind`,
`workflow_steps.layout`, `workflow_steps.sampleOutput`.

## Tasks and approvals

A wait that a **person** answers is a task (`workflow_tasks`): a screen
(`screen-show`, one task for its `assignTo` role) or an **approval** (one task
per approver). Machine waits — an email link, a job — stay key-only.

- **The `approval` step** (a `wait` step): `approvers` — roles
  (`"QA Head, Production Head"`) or people (`"user:<id>"`); `need` — `all`
  (default), `any`, or a number; `order` — `together` (default) or `inTurn`
  (the next approver's task opens when the one before approves); `onReject` —
  `stop` (default, the first reject decides) or `collect`; `title`; `notSame`;
  `dueInHours`, `escalateTo`. Its output, for its arrows and for a meeting
  point after it: `{ decision: 'approved'|'rejected', approved, rejected,
  answers: [{ by, role, decision, comment, at }] }`. It is the meeting point's
  rule counted over tasks: one box to draw, not a split to wire. Needing more
  approvals than people asked fails the step, saying so.
- **Who may act**: the user on the request (`{ id, roles }`) — a task for a
  user is theirs, for a role anyone's holding it, for neither anyone's in the
  company; a Super Admin any. A claimed task is the claimer's alone
  (`TASK_CLAIMED`). The engine never reads auth tables.
- **Four eyes**: the person who started the case never approves it; nor does
  anyone who acted at the steps `notSame` names; nor does one person answer the
  same approval twice (`NOT_SAME_PERSON`, `ALREADY_ANSWERED`). A reject needs a
  reason (`REASON_REQUIRED`).
- **Who answered** is recorded: `workflow_step_runs.actorUserId`, and the task's
  `decidedBy`, `decision`, `comment`. A screen submitted through
  `flows.submitRun` closes its task the same way.
- **Withdrawn**: when an approval or a meeting point goes ahead without a task,
  when a wait expires, or when the case ends, its open tasks become `withdrawn`
  and leave every inbox; answering one says `TASK_CLOSED`.
- **The inbox** (`listMine`): open and claimed tasks for the user, their roles,
  or anyone; due first, then oldest; paged (`limit` ≤ 200, `offset`, `total`).
  Each carries its screen and buttons, or Approve/Reject, and the case's
  `period` when what started it had one.
- **Overdue**: past `dueAt` the host is told once (`onTask('due')`); with
  `escalateTo` the task moves to that role (`'escalated'`), recorded in its
  `history`.
- **Admin** (needs a reason, kept with who gave it): `tasks.reassign` to a user or
  role; `runner.cancelRun` (the case fails as `CANCELLED`, its tasks withdrawn);
  `runner.retryRun` — runs the step a crash interrupted once a person has
  checked it did not already do its work (one-path cases; a case on several
  paths is started again).

## Parallel paths and meeting points

One case can wait on several things at once — QA and production signing off
the same deviation — and move on when enough of them have answered.

- **Leaving** (`workflow_steps.leave`): `first` (default, as always) follows the
  first matching arrow. `every` follows **every** matching arrow, each opening
  its own path. An arrow whose condition is false opens nothing. A step that
  leaves by `every` cannot also have an `each` arrow (refused when saved).
- **Arriving** (`workflow_steps.join`): none (default) — every path that
  arrives runs the step. A **meeting point** `{ wait, stopWhen?, others? }` runs
  **once** for the split's paths:
  - `wait`: `all` (default), `any`, or `{ atLeast: N }` — counted over the paths
    the split actually opened and that can still arrive. A path that ends
    elsewhere (`end_success`) is not waited for; `atLeast` that can no longer be
    reached fails the run (`JOIN_IMPOSSIBLE`) instead of waiting forever.
  - `stopWhen`: a `when` on `arrivals` — `{ field: 'arrivals.rejected', op: '>=', value: 1 }` — runs it early. Compiled into `stopCondition` on save; a designer that compiles its own formulas (as it does an arrow's condition) may save `stopCondition` directly, and it is kept.
  - `others`: `cancel` (default) withdraws the paths still open (their waits
    become `skipped` with `WITHDRAWN`, their links stop working); `finish` lets
    them finish, and their arrival is recorded as `late` and moves nothing.
- **`arrivals`**, read by the meeting step's values and arrows: `rows` (one per
  path: `{ path, from, decision, output }`), `arrived`, `expected`, `approved`,
  `rejected`. A path's `decision` is its last step's `output.decision`, or a
  screen's button (`output.action`); `approve…`/`reject…` are counted.
- **Two answers in the same second** are serialised by a lock on the run row:
  the meeting point runs exactly once.
- **Going back** to the split step splits again; the new split counts afresh,
  and the earlier rounds' arrivals stay in history.
- **The run** is `waiting` when every open path waits, and finishes when none
  is open. `end_failed` on any path fails it and ends the others; every live
  key is spent when a run ends.
- **Paths run one after another** in the call that moves them; "parallel"
  means waiting in parallel. An `each` arrow reached while other paths are open
  fails the run (`EACH_IN_PARALLEL`): put the list before the split or after
  the meeting point.
- **Screens**: a case may wait on two at once. The run view's `waitingOn` lists
  them; `flows.submitRun` takes `stepKey` to say which, and without it refuses
  with `SAY_WHICH_STEP` when there is more than one.

## Surviving a crash and a design edit

- **A run reads the steps it started with** (`lib/versions.js`). `startRun` pins a
  `workflow_versions` row: the first run on a set of steps nobody has run before
  cuts one (recognised by a hash of what the steps do — moving a box on the canvas
  is not a new version), later runs on the same steps reuse it. A design saved
  while a run waits, even one that re-creates every step under new ids as a flow's
  save does, cannot change or strand it. Fan-out children read their parent's.
  Runs from before 0019 have no version and keep reading the live steps.
- **Whoever moves a run holds a lease** (`workflow_runs.lockedUntil`, 2 min,
  renewed every 30 s while a step works, on a timer that never keeps the process
  alive). A process that dies stops renewing.
- **The sweeper** (`lib/recovery.js`, every 30 s; `recover: false` turns it off in
  a process) takes a `running` run whose lease has passed — one process wins, by
  an atomic conditional patch — and goes on from what the run last recorded:
  nothing yet → start it; a step finished but the next was never chosen → choose
  it (no step is repeated); a step mid-way → **run it again only if it is safe to**
  (it reads, computes or shows: `actionCatalog.SAFE_TO_RETRY`, plus a host's
  `allowRetry(names)`), otherwise the step is marked `interrupted` and the run
  fails with `INTERRUPTED`, naming the step and saying to check it. An email may
  already be sent or a file uploaded; that is for a person to check, not the
  engine to guess. Not after a fan-out had started: some children may exist.
- **A wait expires** after its step's `timeoutMs`: the key carries `expiresAt`,
  and the sweeper resolves it as failed (`TIMED_OUT`, `output.timedOut: true`)
  through `resumeByKey`, so `onError` decides — stop (default) or go on.
- **A resume is one transaction**: the key is spent, the answer recorded and the
  run taken under a lease, or none of it. A crash between them used to leave a
  spent key on a run still `waiting`, which could never be answered again.
- **Where a run is, as rows** (`workflow_run_paths`): each path's step and
  whether it is running, waiting, arrived or done. Step runs and keys carry
  their `pathId`. The sweeper picks up each path that was moving on its own.
- Runs still finish inside the call that moves them, as before: `startRun`
  returns the run as it ended or paused.

## Triggers (`lib/triggers.js`)

**What starts a workflow is its `trigger`**, one shape per kind, and the engine acts on it. Every kind goes through one registry, the way every step goes through the action registry:

| kind | settings | fires |
|---|---|---|
| `manual` | — | someone presses Start (nothing to arm) |
| `api` | — | another system calls the run (nothing to arm) |
| `schedule` | `cron` (`"0 9 * * 1"`), `timezone?` | when the cron expression is due |
| `job` | `jobId`, `when`: `success` (default) \| `failed` \| `finished` | when that job finishes that way |

Every kind also takes `enabled: false`, which switches it off without losing it.

The same rules hold for every kind:

- **Only a published workflow fires.** A draft never does.
- **It is checked when it is saved.** The `Workflow` model validates `trigger` on every insert and update; an unknown kind, a job trigger without `jobId` or a cron expression that cannot be read is a 400 naming the problem.
- **A run gets what fired it.** It is stored as `workflow_runs.triggerData` and read by bindings and by the conditions on arrows as `{trigger.*}`: a job's `{trigger.status}`, `{trigger.window.from}`, `{trigger.output.totalRows}`; a schedule's `{trigger.dueAt}`. A run started by hand has `{trigger.kind}` only.
- **What it did is a row.** `workflow_trigger_states` keeps the last fire and its run, the next due time, and the last skip and why: a required parameter nobody supplies, a workflow with no steps. A workflow that cannot start is recorded and never thrown at the job that finished. `describe(workflow)` answers `{ trigger, on, lastFiredAt, lastRunId, lastSkippedAt, lastSkipReason, nextDueAt }`.

**The schedule tick.** `startEngine` runs it every 30 s, on a timer that does not keep the process alive (`schedule: false` turns it off in a process). It reads every tenant's timed triggers and starts each run in its own workflow's tenant context.
- A trigger seen for the first time, or whose settings changed, is given its next due time and does **not** fire, so publishing never starts a run for a time already past.
- A due trigger is **claimed** by a conditional update of its due time, so two processes running the tick start it once.

**A run for a period.** A schedule can say `period`: `previous-day`, `previous-month`, `previous-quarter`, `previous-year` or `current-month`. The run then has `{trigger.window.from}` (included) and `{trigger.window.to}` (not included), the shape a job hands on, worked out at midnight in the trigger's `timezone` (else the server's). The 1st of October in India gives September: `2026-08-31T18:30Z` to `2026-09-30T18:30Z`.

**A trigger gives the run its inputs** (`params`, any kind): each value a template over what fired it, e.g. `{ "month": "{trigger.window.from|date:YYYY-MM:Asia/Kolkata}" }`. Why: a run a trigger started had no inputs, so a workflow with a required one was refused every time it fired.

**What a designer offers.** `triggers.catalog()` lists every kind as `{ kind, label, description, fields }`, where `fields` are the form's boxes (`{ name, label, placeholder?, help?, required?, options? }`). The API serves it at `GET /workflow/triggers`. A designer builds its trigger form from it, so it never offers a kind this engine refuses (one once offered "A file arrives", which no engine had).

**A host's own kinds.** `registerTrigger(kind, { label?, description?, fields?, validate, due?, matches? })`:
- a time kind gives `due(trigger, from)`, its next due `Date`;
- an event kind gives `matches(trigger, event)`, and the host calls `triggers.emit(kind, event)` when the event happens.

Folder and mailbox watchers are next, as kinds of this registry.

## Conditions written simply (`lib/conditions.js`)

An arrow (a transition) can carry `when` instead of an engine `condition`. The engine compiles it into the `condition` every time the step is saved (`WorkflowStep`'s hooks) and keeps `when` beside it, so a screen reads back exactly what it wrote. `when` is one of:

- `{ "field": "trigger.status", "op": "=", "value": "success" }`
- `{ "all": [ … ] }` or `{ "any": [ … ] }`
- empty, meaning "otherwise"

The comparisons are the flows facade's: `=`, `!=`, `>`, `>=`, `<`, `<=`, `contains`, `notContains`, `startsWith`, `endsWith`, `in`, `notIn`, `between`, `isEmpty`, `isNotEmpty`.

A bad `when` is refused when it is saved, naming the step and the arrow. That is how a screen of your own (and the jobs screen's "After this job") writes branches without knowing the node format.

**An arrow the runner could not follow is refused when it is saved** (`checkArrow`, code `TRANSITION_INVALID`, naming the step and arrow):
- `mode` is `single` (the default) or `each`;
- an arrow needs a `target` (a step key, `end_success` or `end_failed`), unless it names a `decide` function;
- an `each` arrow needs `source`, the list it goes through, starting with `output`, `item`, `params` or `trigger`;
- an arrow either decides or goes through a list, not both, and `targets` is a list of step keys.

Why: each of these used to save, and then the live run ended with "No transition matched". A designer once saved every `each` arrow without its `source`, so nothing ever fanned out.

## Jobs as steps and as triggers (`lib/jobs.js`)

A job meets a workflow in two places, and both are ordinary workflows:

- **As a step:** `job-run` starts a job and parks (a `wait` step) until it reports back. The run carries on with its result.
  - **A busy job is waited for** (`whenBusy: 'wait'`, the default): a job runs one at a time, so the step tries to start it again every `busyRetrySeconds` (30) for up to `busyWaitMinutes` (10), then fails with `JOB_BUSY` saying how long it tried. `whenBusy: 'fail'` fails at once. It only goes on once the job has started, so nothing runs past a job that did not run. The wait is held in the process: a restart during it ends the step.
- **As a trigger:** `{ "kind": "job", "jobId": "…", "when": "success" }` starts the workflow when that job finishes.

Branch on how a job ended with a `decide` step: it does nothing itself, and the conditions on its arrows read `{trigger.*}`.

```json
{ "name": "After the nightly load", "status": "published",
  "trigger": { "kind": "job", "jobId": "<load>", "when": "finished" },
  "steps": [
    { "stepKey": "decide", "actionName": "decide", "transitions": [
        { "when": { "field": "trigger.status", "op": "=", "value": "success" }, "target": "report" },
        { "when": null, "target": "alert" } ] },
    { "stepKey": "report", "actionName": "job-run", "kind": "wait",
      "values": { "jobId": "<report job>", "callbackUrl": "{resumeUrl}" } },
    { "stepKey": "alert", "actionName": "send-email", "values": { "to": "ops@example.com", "subject": "Load failed: {trigger.error.message}" } }
  ] }
```

**A finished job gives the workflow it triggers** `{trigger.*}`:
- `jobId` and `status` (`success` / `failed`)
- `error`, when it failed
- `output`: what its action returned
- `window`: the period it ran for. That is the range it was given or, given none, the range its action reports it covered.
- `given` / `used`: those two ranges separately
- `carry`: values carried from the jobs before it
- `path`: the jobs that led here

**When a job started such a run, `job-run` carries it on:**
- **The period flows.** The next job gets the finished job's `window` unless the step's `inputs` set one, so a chain of workflows covers one period from its first job to its last.
- **The next job is offered both earlier ranges**, as `@xeplr/jobs`' `previous.given` / `previous.used`.
- **`carry`** (a `job-run` input) adds values for the jobs after it.
- **`inputs` and `carry` keep their types.** A binding that is the whole value (`"{trigger.output.totalRows}"`) passes `7`, not `"7"`, and an object stays an object. Every other step's input is text, as bindings make it.
- **Loops stop.** A job already on the path, or a path 25 jobs long, fails the step with a message.

The next job takes only `window` and the inputs it lists in `acceptsInputs`; `@xeplr/jobs` refuses the rest, naming them.

**The host connects jobs, in-process.** The engine never imports jobs:

```js
await engine.startEngine({ db, startJob: (jobId, body) => jobs.trigger(jobId, body) });
await jobs.init({ /* … */ onFinish: (report) => engine.jobFinished(report) });
```

`jobFinished(report)` takes `@xeplr/jobs`' finish envelope. It resumes the `job-run` step that started the job (retrying while that step parks) and starts every workflow the job triggers. Without `startJob`, `job-run` starts jobs over HTTP (`jobsUrl`, and `WORKFLOW_PUBLIC_URL` for the callback).

**Job chains are gone.** Migration 0015 converts each "After this job" chain (kind `job-chain`) into an ordinary workflow:
- it gets a `job` trigger (`when: finished`) and the key `after-job-<jobId>`, the one the jobs screen's shortcut uses;
- its `decide` and `job-run` steps keep the same behaviour, and each arrow keeps its rule's `when`;
- conditions and bindings now read `trigger.*`.

Migration 0016 repairs a database that ran 0015's first release, which left the key empty and the arrows without `when`. A single comparison gets its `when` back. A nested one still runs as before, and the jobs screen says it was changed elsewhere.

## Tests

```bash
npm test          # node test/run.mjs — each *.test.mjs in its own process
```

No database or network needed, except the suites marked "On a real Postgres" and `triggers.test.mjs`, which run on a real Postgres when `WORKFLOW_TEST_PG='{"host":…,"port":…,"user":…,"password":…}'` is set (scratch databases, created and dropped) and is skipped otherwise. CI and the release start a throwaway Postgres and set it, so neither ships on a skipped suite. `npm install` first: the peers install with it.

| Suite | Covers |
|---|---|
| `conditions.test.mjs` | `when` → condition: a comparison, otherwise, nested all/any, every refusal naming the step and arrow, `when` kept beside the compiled condition |
| `triggers.test.mjs` | Triggers with the real `@xeplr/jobs`, wired as a host wires it:
- every refusal when saved
- a job finishing starts the workflows it triggers, B and D running with A's period
- `success`, `failed` and `finished`
- a trigger switched off, and a draft, never firing
- a loop stopped
- a workflow that cannot start, recorded as a skip
- the schedule's first sight, its due time, two ticks starting it once, a changed cron
- migration 0015 turning an old job chain into a workflow that runs, with its key and `when` arrows
- migration 0016 repairing one converted early, and changing nothing on a second run |
| `actionCatalog.test.mjs` | Ready vs placeholder detection; registered names are kebab-case; `spawnProgram` not offered; `decide` and `job-run` offered |
| `runningSafely.test.mjs` | On a real Postgres: a loop stopped at `maxStepRuns`; a failure routed by its arrows with its error readable; an `each` arrow never past its limit, joining once; children that paused and were resumed still letting the parent join; `job-run` waiting for a busy job, failing at once with `whenBusy: fail`, and giving up after `busyWaitMinutes` |
| `screensInWorkflows.test.mjs` | On a real Postgres: a review screen handed rows, assigned to Accounts and listed only for Accounts (and a Super Admin); refused to another role; needing one of its own buttons; Approve and Send back taking their own arrows with the ticked rows; nothing waiting for another company |
| `periodsAndMemory.test.mjs` | On a real Postgres: a monthly schedule firing on the 1st with September's window in India and its required input filled from it; `recall`/`remember` making a second run for the same month do nothing and a new month run; memory per workflow and per company; `forget` |
| `typedValues.test.mjs` | On a real Postgres: an http-request through a saved API connection (token never recorded) and a db-fetch through a saved database connection, its id recorded and never the login, and a deleted connection failing the step; rows from one step filtered by the data step as a list; a period written as a month in a zone; text fields get text, numbers and lists keep their type; a bad template fails the run by step |
| `envExposed.test.mjs` | Nothing exposed by default; exact, case-sensitive matching; globs fail closed (against real `interpolateAll`) |
| `requires.test.mjs` | Every relative `require` in this package points at a file (Node only notices a missing one when the line runs; a bundler refuses it up front) |
| `paths.test.mjs` | `MIGRATIONS_DIR` and `TENANT_MIGRATIONS_DIR` exist inside the package, hold SQL, and are listed in `readsFromDisk` (an undefined one makes the migrator run the HOST's `./migrations` against workflow's database) |
| `runParams.test.mjs` | `resolveParams` / `collectParams`: required, defaults, types, typos, union rules |
| `tasks.test.mjs` | On a real Postgres: an approval by two roles, each seeing only theirs, deciding once both approve and recording who; a reject needing a reason, deciding at once and withdrawing the other; four eyes (requester, `notSame`, one person twice); any one, at least 2, more than asked refused, in turn; claim, refusal to another, release; a screen as a task, by its role, through either route; overdue telling the host once and escalating with history; reassign and cancel needing reasons; retry of an interrupted case; approvals on parallel paths feeding a meeting point; an expired wait withdrawing; the inbox paging |
| `parallel.test.mjs` | On a real Postgres: a split opening a path per arrow and the case waiting on both; one answer not enough, two moving it once, with every answer readable; **two answers in the same instant running the meeting point once**; a reject going back at once, the other approver withdrawn and their link dead; any one of three; at least 2 of 3 with the third finishing late; a false arrow opening nothing to wait for; an unreachable `atLeast` failing; a path not reading a parallel path's steps; arrows reading earlier steps; going back counting afresh; `end_run`, `end_failed`, `end_success` from one path; what cannot be saved; `each` on parallel paths refused; two screens waiting and a submit naming which; a crash with two paths; a plain workflow unchanged |
| `recovery.test.mjs` | On a real Postgres: every run records its path, and its step runs and keys name it; a run waiting while its design was saved over (new step ids) is answered and goes on as it started, a later run reads the new design, unchanged steps reuse a version; a wait past `timeoutMs` fails as `TIMED_OUT`, or goes on with `onError: continue`; **a process killed for real mid-step** (`recovery.child.mjs`, `SIGKILL`): left alone while its lease holds, then a step that may have had an effect stopped as `INTERRUPTED` and not repeated, a step safe to run again run again; a run that died before its first step started, one that died between steps going on without repeating one; a run waiting from before 0019 given its path by the migration and answered |

The flows facade is tested from `@xeplr/workflow-api` (`test/flows.test.mjs`), through its real router.

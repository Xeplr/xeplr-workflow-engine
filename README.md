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
| `startEngine(config)` | Connect workflow's database (creating it if missing), run its migrations, ready `xeplr_configs`, register the action catalog. Idempotent. `config.db` is required; throws if no application id is registered. Config: `db` (`{ name, connection, connectionName?, mts?, migrationsTable? }`), `applicationId`, `tenantTables`, `migrations`, `migrate` (`false`: connect without migrating — a second process of an install whose API migrates), `startJob` (below), `schedule` (`false`: no schedule tick in this process), `scheduleIntervalMs` (default 30000) |
| `resumeByKey(key, output?, opts?)` | Server-side, in-process resume of a run parked on a `wait` step. `opts.status: 'failed'` resolves the step as failed. Throws `err.code` `RESUME_KEY_INVALID` (used/unknown, normal for host routes) or `RESUME_KEY_NOT_READY` (step still running; nothing consumed, retry) |
| `embedRequiredEnv` | `['DB_WORKFLOW']`, spread into a host's `env.required.js` |
| `callbackRequiredEnv` | `['WORKFLOW_PUBLIC_URL']`, only for hosts using steps that call out (`job-run`) |
| `MIGRATIONS_DIR`, `TENANT_MIGRATIONS_DIR` | Where the SQL is, for the standalone server and for a bundle that ships the folders |
| `db` | `connectDb`, with `.model(name)` bound to workflow's own connection |
| `runner` | `lib/workflowRunner.js`: `startRun`, `resumeByKey`, `resolveParams`, `collectParams` |
| `flows` | `lib/flows.js`: the flows facade (list, create, put, publish, start, submit, runs) and `touchesScreens` |
| `triggers`, `registerTrigger` | `lib/triggers.js`: what starts a workflow — the registry of kinds, `validate`, `emit`, the schedule `tick`, `describe` ([Triggers](#triggers-libtriggersjs)) |
| `conditions` | `lib/conditions.js`: `whenToCondition`, `compileTransitions` ([Conditions](#conditions-written-simply-libconditionsjs)) |
| `jobs`, `jobFinished` | `lib/jobs.js`: jobs as steps and as triggers — `setJobStarter`, `jobFinished` ([Jobs](#jobs-as-steps-and-as-triggers-libjobsjs)) |
| `actionCatalog`, `envExposed`, `xcfgSetup` | The action whitelist, the `WORKFLOW_ENV_EXPOSED` allowlist, the shared `xeplr_configs` attachment |

The package reads `migrations/` and `migrations-tenants/` from disk (`"xeplr": { "readsFromDisk": [...] }` in `package.json`), so a build that compiles it must ship those folders beside it.

## Structure

```
engine/
├─ index.js                 startEngine, resumeByKey, the env lists, and the parts below
├─ lib/
│  ├─ workflowRunner.js     startRun, resumeByKey, resolveParams, collectParams
│  ├─ flows.js              the flows facade: screens as steps
│  ├─ triggers.js           what starts a workflow: manual, api, schedule, job, and more
│  ├─ jobs.js               jobs as steps (job-run) and as triggers (jobFinished)
│  ├─ conditions.js         an arrow's `when` compiled into its condition
│  ├─ actionCatalog.js      whitelist of @xeplr/actions built-ins + local actions
│  ├─ actions/              local actions: job-run, decide, screen-show
│  ├─ envExposed.js         WORKFLOW_ENV_EXPOSED allowlist for {env.*}
│  └─ db.js                 connectDb + model(name) bound to workflow's own connection
├─ db/xcfgSetup.js          shared @xeplr/actions attachConfig({ service: 'xeplr-workflow' })
├─ models/                  Company, Workspace, Workflow, WorkflowStep, WorkflowRun,
│                           WorkflowStepRun, WorkflowResumeKey, WorkflowRunEdge,
│                           WorkflowTriggerState
├─ migrations/              0003–0016, workflow's own tables
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

Every table carries `mtId1`–`mtId4` and **no `applicationId`**: the database a
host gives workflow is the boundary.

## How a run behaves (`lib/workflowRunner.js`)

- **Step values** are interpolated with `@xeplr/schema-handler` against
  `{ params, item, steps.<key>.output, previous_step.output, env, resumeKey, resumeUrl }`.
  `previous_step`/`steps` come from what ran in this run, not array position.
- **Routing**: no `transitions` → next step by `position`. With transitions →
  first match wins (`@xeplr/expression-handler`); a blank condition is the
  catch-all; targets are a `stepKey`, `end_success` or `end_failed`. No match
  and no catch-all **fails the run**.
- **Letting a function decide**: a transition `{ decide: 'routeByAmount', targets?: [...] }`
  asks a function the app registered with `@xeplr/actions` under `event: 'decide'`
  where to go. It is called with `{ output, values (= output), params, item, trigger,
  step, runId, targets }` and returns a step key, `end_success` or `end_failed`;
  `targets`, when listed, are the steps it may choose (none: any step). A missing
  function, one written for another event, no answer, or an answer outside
  `targets` **fails the run**, naming the function. Functions registered with an
  `event` are screen functions, never steps: the action catalog leaves them out.
- **Fan-out**: a matching `each` transition creates one child run per matching
  element (`item`), recorded in `workflow_run_edges`. With `joinStep` the parent
  waits and resumes at the join once all children are terminal (guarded by an
  atomic `waiting → running` patch); without it the parent finishes.
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
`workflow_steps.layout`, `workflow_steps.sampleOutput`, `workflow_steps.timeoutMs`.

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

**A host's own kinds.** `registerTrigger(kind, { validate, due?, matches? })`:
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

## Jobs as steps and as triggers (`lib/jobs.js`)

A job meets a workflow in two places, and both are ordinary workflows:

- **As a step:** `job-run` starts a job and parks (a `wait` step) until it reports back. The run carries on with its result.
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

No database or network needed, except `triggers.test.mjs`, which runs on a real Postgres when `WORKFLOW_TEST_PG='{"host":…,"port":…,"user":…,"password":…}'` is set (scratch databases, created and dropped) and is skipped otherwise. CI and the release start a throwaway Postgres and set it, so neither ships on a skipped suite. `npm install` first: the peers install with it.

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
| `envExposed.test.mjs` | Nothing exposed by default; exact, case-sensitive matching; globs fail closed (against real `interpolateAll`) |
| `requires.test.mjs` | Every relative `require` in this package points at a file (Node only notices a missing one when the line runs; a bundler refuses it up front) |
| `paths.test.mjs` | `MIGRATIONS_DIR` and `TENANT_MIGRATIONS_DIR` exist inside the package, hold SQL, and are listed in `readsFromDisk` (an undefined one makes the migrator run the HOST's `./migrations` against workflow's database) |
| `runParams.test.mjs` | `resolveParams` / `collectParams`: required, defaults, types, typos, union rules |

The flows facade is tested from `@xeplr/workflow-api` (`test/flows.test.mjs`), through its real router.

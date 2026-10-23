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
| `startEngine(config)` | Connect workflow's database (creating it if missing), run its migrations, ready `xeplr_configs`, register the action catalog. Idempotent. `config.db` is required; throws if no application id is registered. Config: `db` (`{ name, connection, connectionName?, mts?, migrationsTable? }`), `applicationId`, `tenantTables`, `migrations`, `migrate` (`false`: connect without migrating — a second process of an install whose API migrates), `startJob` (below) |
| `resumeByKey(key, output?, opts?)` | Server-side, in-process resume of a run parked on a `wait` step. `opts.status: 'failed'` resolves the step as failed. Throws `err.code` `RESUME_KEY_INVALID` (used/unknown, normal for host routes) or `RESUME_KEY_NOT_READY` (step still running; nothing consumed, retry) |
| `embedRequiredEnv` | `['DB_WORKFLOW']`, spread into a host's `env.required.js` |
| `callbackRequiredEnv` | `['WORKFLOW_PUBLIC_URL']`, only for hosts using steps that call out (`job-run`) |
| `MIGRATIONS_DIR`, `TENANT_MIGRATIONS_DIR` | Where the SQL is, for the standalone server and for a bundle that ships the folders |
| `db` | `connectDb`, with `.model(name)` bound to workflow's own connection |
| `runner` | `lib/workflowRunner.js`: `startRun`, `resumeByKey`, `resolveParams`, `collectParams` |
| `flows` | `lib/flows.js`: the flows facade (list, create, put, publish, start, submit, runs) and `touchesScreens` |
| `jobChains` | `lib/jobChains.js`: a job's "After this job" rules as a workflow — `getChain`, `putChain`, `jobFinished`, `setJobStarter`, `touchesChains` ([Job chains](#job-chains-libjobchainsjs)) |
| `actionCatalog`, `envExposed`, `xcfgSetup` | The action whitelist, the `WORKFLOW_ENV_EXPOSED` allowlist, the shared `xeplr_configs` attachment |

The package reads `migrations/` and `migrations-tenants/` from disk (`"xeplr": { "readsFromDisk": [...] }` in `package.json`), so a build that compiles it must ship those folders beside it.

## Structure

```
engine/
├─ index.js                 startEngine, resumeByKey, the env lists, and the parts below
├─ lib/
│  ├─ workflowRunner.js     startRun, resumeByKey, resolveParams, collectParams
│  ├─ flows.js              the flows facade: screens as steps
│  ├─ jobChains.js          a job's "After this job" rules, kept as a workflow
│  ├─ actionCatalog.js      whitelist of @xeplr/actions built-ins + local actions
│  ├─ actions/              local actions: job-run, screen-show, job-chain-decide/-next
│  ├─ envExposed.js         WORKFLOW_ENV_EXPOSED allowlist for {env.*}
│  └─ db.js                 connectDb + model(name) bound to workflow's own connection
├─ db/xcfgSetup.js          shared @xeplr/actions attachConfig({ service: 'xeplr-workflow' })
├─ models/                  Company, Workspace, Workflow, WorkflowStep, WorkflowRun,
│                           WorkflowStepRun, WorkflowResumeKey, WorkflowRunEdge
├─ migrations/              0003–0014, workflow's own tables
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

## Job chains (`lib/jobChains.js`)

**Every hand-off between jobs goes through this engine.** `@xeplr/jobs` never
starts another job; a job's screen keeps a list of "After this job" rules, and
`putChain(jobId, { rules, jobName })` turns them into one hidden workflow,
kind `job-chain`, key `job-chain-<jobId>`:

- `decide` (`job-chain-decide`, does nothing): its transitions are the rules, first match wins, and no match ends the run successfully;
- `run_1 … run_n` (`job-chain-next`, wait steps): start that rule's job and park until it reports back.

A rule is `{ when, run, inputs?, carry? }`:

```json
[
  { "when": { "field": "output.totalRows", "op": ">", "value": 0 }, "run": "<jobId>",
    "inputs": { "region": "{output.region}" }, "carry": { "rows": "{output.totalRows}" } },
  { "when": { "all": [ { "field": "status", "op": "=", "value": "failed" } ] }, "run": "<jobId>" },
  { "run": "<jobId>" }
]
```

- **`when`** is `{ field, op, value }`, `{ all: [...] }`, `{ any: [...] }`, or empty for "otherwise" (last only). Fields start with `status` (`success`/`failed`), `output.` (what the finished job's action returned), `window.`, `carry.`, `error.` or `jobId`. The comparisons are the flows facade's (`flows.comparisonNode`), so `=` means one thing everywhere.
- **The period flows on.** The next job is started with the finished job's `window` unless the rule's `inputs` set one, so a chain covers one period from its first job to its last.
- **`inputs`** fill inputs of the next job — only `window` and the names that job lists in `acceptsInputs` (`@xeplr/jobs` refuses the rest, and the run fails saying which).
- **`carry`** adds values for later jobs, read as `carry.<name>`. Bindings like `{output.x}` keep their type when they are the whole value.
- **Loops stop**: a job that has already run in this chain, or a chain 25 jobs long, fails the step with a message.

`putChain` with an empty list sets the workflow back to draft (its runs stay). `getChain` answers the rules as written (kept on the `decide` step). A `job-chain` workflow cannot be saved through `/workflows/save` (`touchesChains`), like a screens flow.

**The host connects jobs, in-process.** The engine never imports jobs:

```js
await engine.startEngine({ db, startJob: (jobId, body) => jobs.trigger(jobId, body) });
await jobs.init({ /* … */ onFinish: (report) => engine.jobChains.jobFinished(report) });
```

`jobFinished(report)` takes `@xeplr/jobs`' finish envelope. If the run was started by a chain step it resumes that step (retrying while the step parks), and if the finished job has rules it starts its chain with params `{ jobId, status, error, output, window, carry, path }`. With `startJob` set, the canvas's `job-run` step starts jobs the same way, with no `jobsUrl` and no HTTP call.

## Tests

```bash
npm test          # node test/run.mjs — each *.test.mjs in its own process
```

No database or network needed, except `jobChains.test.mjs`, which runs on a real Postgres when `WORKFLOW_TEST_PG='{"host":…,"port":…,"user":…,"password":…}'` is set (scratch databases, created and dropped) and is skipped otherwise. CI and the release start a throwaway Postgres and set it, so neither ships on a skipped suite. `npm install` first: the peers install with it.

| Suite | Covers |
|---|---|
| `jobChains.test.mjs` | "After this job" with the real `@xeplr/jobs` (a dev dependency) wired as a host wires it: rules ⇄ workflow, every refusal, A → B → D with A's period and carried values, otherwise, no match, a failed job followed, loops and over-long chains stopped, an input the next job does not accept, `job-run` in-process, rules removed |
| `actionCatalog.test.mjs` | Ready vs placeholder detection; registered names are kebab-case; `spawnProgram` not offered |
| `envExposed.test.mjs` | Nothing exposed by default; exact, case-sensitive matching; globs fail closed (against real `interpolateAll`) |
| `requires.test.mjs` | Every relative `require` in this package points at a file (Node only notices a missing one when the line runs; a bundler refuses it up front) |
| `paths.test.mjs` | `MIGRATIONS_DIR` and `TENANT_MIGRATIONS_DIR` exist inside the package, hold SQL, and are listed in `readsFromDisk` (an undefined one makes the migrator run the HOST's `./migrations` against workflow's database) |
| `runParams.test.mjs` | `resolveParams` / `collectParams`: required, defaults, types, typos, union rules |

The flows facade is tested from `@xeplr/workflow-api` (`test/flows.test.mjs`), through its real router.

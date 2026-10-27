// A process that starts a run and stops answering in the middle of a step, so
// recovery.test.mjs can kill it for real. Not a suite (run.mjs only runs
// *.test.*): the parent starts it with what to run in the environment.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const { registerApplication, runWithMt } = require('@xeplr/db')
const actions = require('@xeplr/actions')
const engine = require('../index.js')

const PG = JSON.parse(process.env.RC_PG)
const MT = JSON.parse(process.env.RC_MT)

registerApplication('xeplr-workflow-test')
// Hangs once it has said it started: the parent kills the process here.
const hang = async (ctx) => { console.log('STEP_RUNNING ' + ctx.system.runId); return new Promise(() => {}) }
actions.register({ name: 'rc-send', inputSchema: [], execute: hang })
actions.register({ name: 'rc-read', inputSchema: [], execute: hang })
engine.actionCatalog.allowRetry('rc-read')

await engine.startEngine({
  db: {
    name: process.env.RC_DB, connection: PG, connectionName: 'workflow_recovery_child',
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } }
  },
  migrate: false, schedule: false, recover: false,
  lease: { leaseMs: 600, renewMs: 150 }
})
// A hung promise holds nothing open by itself; this does, until the kill.
setInterval(() => {}, 1000)
await runWithMt(MT, () => engine.runner.startRun(process.env.RC_WORKFLOW, {}))

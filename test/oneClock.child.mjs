// The second process of oneClock.test.mjs: the same engine and jobs, on the
// same databases, running its own jobs scheduler — as an install's API and its
// separate jobs service both do. Prints "ready" once it is picking.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const PG = JSON.parse(process.env.OC_PG)
const { registerApplication } = require('@xeplr/db')
const jobs = require('@xeplr/jobs')
const engine = require('../index.js')

registerApplication('xeplr-workflow-test')
engine.jobActions.forEach((a) => jobs.registerAction(a))
await jobs.init({ database: process.env.OC_JOBS_DB, connection: PG, connectionName: 'jobs_oneclock_child', defaultActions: false })
await engine.startEngine({
  db: { name: process.env.OC_WF_DB, connection: PG, connectionName: 'workflow_oneclock_child',
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } } },
  migrate: false
})
jobs.startScheduler({ intervalMs: 100, handleSignals: false })
console.log('ready')
process.on('SIGTERM', () => { jobs.stopScheduler(); setTimeout(() => process.exit(0), 300) })
setInterval(() => {}, 1000)

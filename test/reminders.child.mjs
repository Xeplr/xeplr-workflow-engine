// A second process that sends due reminders once and exits — reminders.test.mjs
// runs two at the same instant to show a reminder is sent once. Not a suite
// (run.mjs only runs *.test.*).
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const { registerApplication } = require('@xeplr/db')
const engine = require('../index.js')

registerApplication('xeplr-workflow-test')
const told = []
await engine.startEngine({
  db: {
    name: process.env.WT_DB, connection: JSON.parse(process.env.WT_PG), connectionName: 'workflow_reminders_child_' + process.pid,
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } }
  },
  migrate: false, schedule: false, recover: false,
  onTask: (event, task, info) => { told.push({ event, taskId: task.id, info }) }
})
const at = Number(process.env.WT_AT || 0)
if (at > Date.now()) await new Promise((r) => setTimeout(r, at - Date.now()))
const out = await engine.tasks.sweepNudges(new Date(Number(process.env.WT_NOW)))
await new Promise((r) => setTimeout(r, 100))
console.log('NUDGED ' + JSON.stringify({ out, told }))
await engine.db.conn().destroy()
process.exit(0)

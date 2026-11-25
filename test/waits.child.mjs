// A second process that wakes due waits once and exits — waits.test.mjs runs
// it to show a wait outlives the process that parked it, and that two
// processes waking at the same moment wake it once. Not a suite (run.mjs
// only runs *.test.*).
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const { registerApplication } = require('@xeplr/db')
const engine = require('../index.js')

registerApplication('xeplr-workflow-test')
await engine.startEngine({
  db: {
    name: process.env.WT_DB, connection: JSON.parse(process.env.WT_PG), connectionName: 'workflow_waits_child_' + process.pid,
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } }
  },
  migrate: false
})
// Both children start the pass at the same instant.
const at = Number(process.env.WT_AT || 0)
if (at > Date.now()) await new Promise((r) => setTimeout(r, at - Date.now()))
const out = await engine.waits.wakeDue()
console.log('WOKE ' + JSON.stringify(out))
await engine.db.conn().destroy()
process.exit(0)

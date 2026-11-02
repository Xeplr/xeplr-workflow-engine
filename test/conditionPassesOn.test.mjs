// A CONDITION BOX DECIDES ON WHAT CAME INTO IT, and hands that same data on:
// `output.count` in a Condition box is the count the step before produced,
// a rule on each row goes through `output.rows`, and the step after it reads
// the data as if the box were not there. Reached first, it has {}.
// Through the real engine on a real Postgres.
//
// Needs WORKFLOW_TEST_PG = '{"host":"localhost","port":5432,"user":"…","password":"…"}'.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const PG = process.env.WORKFLOW_TEST_PG ? JSON.parse(process.env.WORKFLOW_TEST_PG) : null
if (!PG) {
  console.log('  skipped — set WORKFLOW_TEST_PG to run against Postgres')
  process.exit(0)
}

const { registerApplication, runWithMt } = require('@xeplr/db')
const { generateId } = require('@xeplr/utils/lib/helpers')
const actions = require('@xeplr/actions')
const engine = require('../index.js')

const results = []
const check = (n, c, extra) => { results.push(c); console.log((c ? '  ok   ' : '  FAIL ') + n + (c || extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 600))) }

const STAMP = Date.now()
const WF_DB = 'xeplr_wf_condition_test_' + STAMP
const MT = { mtId1: 'c' + (STAMP % 100000), mtId2: 'w' + (STAMP % 100000) }

registerApplication('xeplr-workflow-test')
const seen = []
actions.register({ name: 'cp-read', inputSchema: [{ name: 'n', type: 'number' }],
  execute: async (ctx) => ({ count: ctx.input.n, rows: Array.from({ length: ctx.input.n }, (_, i) => ({ id: i + 1, amount: (i + 1) * 100 })) }) })
actions.register({ name: 'cp-note', inputSchema: [{ name: 'what', type: 'string' }], execute: async (ctx) => { seen.push(ctx.input.what); return { noted: ctx.input.what } } })

await engine.startEngine({
  db: { name: WF_DB, connection: PG, connectionName: 'workflow_condition_test',
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } } },
  schedule: false
})
const Workflow = engine.db.model('Workflow')
const Step = engine.db.model('WorkflowStep')
const Run = engine.db.model('WorkflowRun')
const StepRun = engine.db.model('WorkflowStepRun')
async function workflow(name, steps) {
  const w = await Workflow.query().insert({ id: generateId(), name, kind: 'workflow', status: 'published' })
  for (let i = 0; i < steps.length; i++) {
    await Step.query().insert({ id: generateId(), workflowId: w.id, kind: 'auto', onError: 'stop', position: i, ...steps[i] })
  }
  return w
}
const to = (target, condition, extra) => ({ condition: condition || null, mode: 'single', target, ...(extra || {}) })
const gt = (field, value) => ({ left: { field }, op: 'gt', right: { value } })

try {
  await runWithMt(MT, async () => {
    const flow = (n) => workflow('Many or few ' + n, [
      { stepKey: 'read', name: 'Read', actionName: 'cp-read', values: { n: n }, transitions: [to('check')] },
      { stepKey: 'check', name: 'More than 2?', actionName: 'decide', transitions: [to('many', gt('output.count', 2)), to('few')] },
      { stepKey: 'many', name: 'Many', actionName: 'cp-note', values: { what: 'many:{previous_step.output.count}' }, transitions: [to('end_success')] },
      { stepKey: 'few', name: 'Few', actionName: 'cp-note', values: { what: 'few:{previous_step.output.count}' }, transitions: [to('end_success')] }
    ])
    seen.length = 0
    const r3 = await engine.runner.startRun((await flow(3)).id, {})
    check('the rule reads what came in: output.count = 3, more than 2', (await Run.query().findById(r3.id)).status === 'success' && seen.join() === 'many:3', seen)
    const kept = await StepRun.query().where({ runId: r3.id, stepKey: 'check' }).first()
    check('...the Condition box hands on that same data', kept.output && kept.output.count === 3 && kept.output.rows.length === 3, kept.output)
    seen.length = 0
    await engine.runner.startRun((await flow(1)).id, {})
    check('...and the step after it reads it as if the box were not there (few:1)', seen.join() === 'few:1', seen)

    seen.length = 0
    const each = await workflow('Each big row', [
      { stepKey: 'read', name: 'Read', actionName: 'cp-read', values: { n: 4 }, transitions: [to('check')] },
      { stepKey: 'check', name: 'Big ones', actionName: 'decide',
        transitions: [to('note', gt('item.amount', 200), { mode: 'each', source: 'output.rows' }), to('end_success')] },
      { stepKey: 'note', name: 'Note', actionName: 'cp-note', values: { what: 'row:{item.id}' }, transitions: [to('end_success')] }
    ])
    const re = await engine.runner.startRun(each.id, {})
    for (let i = 0; i < 60 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 50))
    check('a rule on each row goes through the rows that came in (amount > 200: rows 3 and 4)', seen.slice().sort().join() === 'row:3,row:4', { seen, status: (await Run.query().findById(re.id)).status })

    const first = await workflow('Condition first', [
      { stepKey: 'check', name: 'Anything?', actionName: 'decide', transitions: [to('end_failed', gt('output.count', 0)), to('end_success')] }
    ])
    const rf = await engine.runner.startRun(first.id, {})
    check('reached first, nothing came in: {} — the otherwise rule', (await Run.query().findById(rf.id)).status === 'success')
  })
} catch (err) {
  check('no error', false, err.stack || err.message)
} finally {
  await engine.db.conn().destroy().catch(() => {})
  const admin = require('knex')({ client: 'pg', connection: { ...PG, database: 'postgres' } })
  await admin.raw(`DROP DATABASE IF EXISTS "${WF_DB}" WITH (FORCE)`).catch(() => {})
  await admin.destroy()
  const failed = results.filter((c) => !c).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}

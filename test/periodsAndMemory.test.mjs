// A scheduled run for a period, and a workflow that remembers what it did,
// through the real engine on a real Postgres.
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
const WF_DB = 'xeplr_wf_period_test_' + STAMP
const MT = { mtId1: 'c' + (STAMP % 100000), mtId2: 'w' + (STAMP % 100000) }
const OTHER = { mtId1: 'x' + (STAMP % 100000), mtId2: 'y' + (STAMP % 100000) }

registerApplication('xeplr-workflow-test')
const worked = []
actions.register({ name: 'period-work', inputSchema: [{ name: 'note', type: 'string' }], execute: async (ctx) => { worked.push(ctx.input.note); return { file: '/data/recon/' + ctx.input.note + '.xlsx' } } })

await engine.startEngine({
  db: { name: WF_DB, connection: PG, connectionName: 'workflow_period_test',
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } } },
  schedule: false
})
const Workflow = engine.db.model('Workflow')
const Step = engine.db.model('WorkflowStep')
const Run = engine.db.model('WorkflowRun')
async function workflow(name, steps, extra) {
  const w = await Workflow.query().insert({ id: generateId(), name, kind: 'workflow', status: 'published', ...extra })
  for (let i = 0; i < steps.length; i++) {
    await Step.query().insert({ id: generateId(), workflowId: w.id, kind: 'auto', onError: 'stop', position: i, ...steps[i] })
  }
  return w
}
const to = (target, condition) => ({ condition: condition || null, mode: 'single', target })

// Recall first; done already → end; else do the work and remember it.
const RECON = [
  { stepKey: 'done', name: 'Already done?', actionName: 'recall', values: { key: 'recon:{params.month}' },
    transitions: [to('end_success', { left: { field: 'output.found' }, op: 'eq', right: { value: true } }), to('work')] },
  { stepKey: 'work', name: 'Reconcile', actionName: 'period-work', values: { note: '{params.month}' }, transitions: [to('mark')] },
  { stepKey: 'mark', name: 'Mark done', actionName: 'remember', values: { key: 'recon:{params.month}', value: { file: '{steps.work.output.file}' } }, transitions: [to('end_success')] }
]

try {
  await runWithMt(MT, async () => {
    console.log('a scheduled run is given its period, and its inputs from it')
    const w = await workflow('Monthly recon', RECON, {
      params: [{ name: 'month', type: 'string', required: true }],
      trigger: { kind: 'schedule', cron: '30 7 1 * *', timezone: 'Asia/Kolkata', period: 'previous-month',
        params: { month: '{trigger.window.from|date:YYYY-MM:Asia/Kolkata}' } }
    })
    // First sight sets the due time; the next tick past it fires.
    await engine.triggers.tick(new Date('2026-09-15T00:00:00Z'))
    const fired = await engine.triggers.tick(new Date('2026-10-01T03:00:00Z'))
    const runs = await Run.query().where({ workflowId: w.id })
    const run = runs[0]
    check('it fired once', fired.length === 1 && fired[0].fired === true && runs.length === 1, fired)
    check('...for September, as the window of the month before, in India', run && run.triggerData.window.from === '2026-08-31T18:30:00.000Z' && run.triggerData.window.to === '2026-09-30T18:30:00.000Z', run && run.triggerData)
    check('...with its required input filled from the period', run && run.params.month === '2026-09' && run.status === 'success', run && { params: run.params, status: run.status, error: run.error })
    check('the work ran for September', worked.join() === '2026-09', worked)

    console.log('\nwhat it remembered stops a second run for the same month')
    const again = await engine.runner.startRun(w.id, { month: '2026-09' })
    check('a second run for September does nothing, and succeeds', (await Run.query().findById(again.id)).status === 'success' && worked.join() === '2026-09', worked)
    const oct = await engine.runner.startRun(w.id, { month: '2026-10' })
    check('October is new, so it runs', (await Run.query().findById(oct.id)).status === 'success' && worked.join() === '2026-09,2026-10', worked)

    const peek = await workflow('Peek', [{ stepKey: 'r', name: 'R', actionName: 'recall', values: { key: 'recon:2026-09' } }])
    const pr = await engine.runner.startRun(peek.id, {})
    const out = (await engine.db.model('WorkflowStepRun').query().where({ runId: pr.id }))[0].output
    check('memory belongs to its own workflow', out.found === false, out)
    const mine = await engine.db.model('WorkflowMemory').query().where({ workflowId: w.id, key: 'recon:2026-09' }).first()
    check('what was remembered, and by which run', mine && mine.value.file === '/data/recon/2026-09.xlsx' && mine.runId === run.id, mine)

    console.log('\nforgetting it lets the work run again')
    const f = await workflow('Mark or forget', [
      { stepKey: 'which', name: 'Which', actionName: 'decide', values: {},
        transitions: [to('forget', { left: { field: 'params.mode' }, op: 'eq', right: { value: 'forget' } }), to('mark')] },
      { stepKey: 'mark', name: 'Mark', actionName: 'remember', values: { key: 'k' }, transitions: [to('end_success')] },
      { stepKey: 'forget', name: 'Forget', actionName: 'remember', values: { key: 'k', forget: true }, transitions: [to('end_success')] }
    ], { params: [{ name: 'mode', type: 'string' }] })
    await engine.runner.startRun(f.id, { mode: 'mark' })
    const kept = await engine.db.model('WorkflowMemory').query().where({ workflowId: f.id, key: 'k' }).first()
    check('remembered with no value: that it happened, and when', kept && typeof kept.value.at === 'string', kept)
    const fr = await engine.runner.startRun(f.id, { mode: 'forget' })
    const forgotOut = (await engine.db.model('WorkflowStepRun').query().where({ runId: fr.id, stepKey: 'forget' }))[0].output
    check('forget removes it, and says it did', forgotOut.forgotten === true && !(await engine.db.model('WorkflowMemory').query().where({ workflowId: f.id, key: 'k' }).first()), forgotOut)
  })
  await runWithMt(OTHER, async () => {
    const theirs = await engine.db.model('WorkflowMemory').query().where({ key: 'recon:2026-09' })
    check('another company sees none of it', theirs.length === 0)
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

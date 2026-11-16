// A RUNNING STEP SAYS HOW FAR IT HAS GOT, AND A CANCEL STOPS IT
// (lib/stepReport.js), through the real engine on a real Postgres:
//
//   - the action's onProgress numbers and log lines are saved on its step run
//     while it runs — readable from outside before it ends — and the last of
//     them once it ends
//   - only the newest numbers are written, at most every two seconds, however
//     often the action reports
//   - cancelling the case aborts the step's signal: the action stops its own
//     work part-way, and the case ends cancelled
//   - a cancel written by another process (straight to the run's row) stops
//     the step at its next report
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const STAMP = Date.now()
const WF_DB = 'xeplr_wf_progress_test_' + STAMP
const MT = { mtId1: 'c' + (STAMP % 100000), mtId2: 'w' + (STAMP % 100000) }
registerApplication('xeplr-workflow-test')

// A load of `rows` rows in batches of 1,000, 40 ms a batch: it reports every
// batch and says each stage, and stops between batches when told to.
let reports = 0
let stoppedAfter = null
actions.register({ name: 'slow-load', inputSchema: [{ name: 'rows', type: 'number' }],
  execute: async (ctx) => {
    const sys = ctx.system || {}
    const total = ctx.input.rows
    sys.log('Loading ' + total + ' rows')
    for (let done = 1000; done <= total; done += 1000) {
      if (sys.signal && sys.signal.aborted) { stoppedAfter = done - 1000; throw sys.signal.reason }
      await sleep(40)
      reports++
      sys.onProgress({ rowsWritten: done, percent: Math.round((done / total) * 100) })
      if (done % 20000 === 0) sys.log(done + ' rows written')
    }
    sys.log('Loaded ' + total + ' rows')
    return { rows: total }
  } })

await engine.startEngine({
  db: { name: WF_DB, connection: PG, connectionName: 'workflow_progress_test',
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } } },
  schedule: false
})
const Workflow = engine.db.model('Workflow')
const Step = engine.db.model('WorkflowStep')
const Run = engine.db.model('WorkflowRun')
const StepRun = engine.db.model('WorkflowStepRun')
async function workflow(name, rows) {
  const w = await Workflow.query().insert({ id: generateId(), name, kind: 'workflow', status: 'published' })
  await Step.query().insert({ id: generateId(), workflowId: w.id, kind: 'auto', onError: 'stop', position: 0, stepKey: 'load', name: 'Load',
    actionName: 'slow-load', values: { rows }, transitions: [{ condition: null, mode: 'single', target: 'end_success' }] })
  return w
}
async function stepOf(runId) { return StepRun.query().where({ runId, stepKey: 'load' }).first() }
async function runningRunOf(w) {
  for (let i = 0; i < 100; i++) {
    const r = await Run.query().where({ workflowId: w.id }).first()
    if (r) return r
    await sleep(50)
  }
  return null
}

try {
  await runWithMt(MT, async () => {
    console.log('its progress and log, while it runs and once it ends')
    reports = 0
    const w1 = await workflow('Load 100k', 100000)          // ~4 s
    const going = engine.runner.startRun(w1.id, {})
    const r1 = await runningRunOf(w1)
    await sleep(2600)
    const mid = await stepOf(r1.id)
    check('while it runs, its numbers are readable from outside', mid && mid.status === 'running' && mid.progress && mid.progress.rowsWritten > 0 && mid.progress.rowsWritten < 100000 && typeof mid.progress.at === 'string', mid && mid.progress)
    check('...and its log so far', mid && Array.isArray(mid.log) && mid.log[0].message === 'Loading 100000 rows' && mid.log[0].level === 'info', mid && mid.log)
    await going
    const end = await stepOf(r1.id)
    check('once it ends: the last numbers and every line, in order', end.status === 'success' && end.progress.rowsWritten === 100000 && end.progress.percent === 100 &&
      end.log.map((l) => l.message).join('|') === 'Loading 100000 rows|20000 rows written|40000 rows written|60000 rows written|80000 rows written|100000 rows written|Loaded 100000 rows', end.log)
    check('100 reports, but only the newest written (not 100 writes)', reports === 100)

    console.log('\ncancelled part-way')
    stoppedAfter = null
    const w2 = await workflow('Load 1M', 1000000)            // ~40 s if left alone
    const started = Date.now()
    const going2 = engine.runner.startRun(w2.id, {})
    const r2 = await runningRunOf(w2)
    await sleep(1500)
    await engine.runner.cancelRun(r2.id, { reason: 'test', actor: 'tester' })
    await going2.catch(() => {})
    const s2 = await stepOf(r2.id)
    const run2 = await Run.query().findById(r2.id)
    check('the step stopped part-way, at once', stoppedAfter !== null && stoppedAfter < 1000000 && Date.now() - started < 10000, { stoppedAfter, ms: Date.now() - started })
    check('...the step failed, the case cancelled', s2.status === 'failed' && run2.status === 'failed' && run2.error.code === 'CANCELLED', { step: s2.status, run: run2.error })

    console.log('\ncancelled from another process')
    stoppedAfter = null
    const w3 = await workflow('Load 1M again', 1000000)
    const t3 = Date.now()
    const going3 = engine.runner.startRun(w3.id, {})
    const r3 = await runningRunOf(w3)
    await sleep(1000)
    // Another worker cancels: only the row changes; nothing in this process is told.
    await Run.query().findById(r3.id).patch({ status: 'failed', error: { code: 'CANCELLED', message: 'Cancelled: elsewhere' } })
    await going3.catch(() => {})
    check('the step reads it at its next report and stops', stoppedAfter !== null && stoppedAfter < 1000000 && Date.now() - t3 < 10000, { stoppedAfter, ms: Date.now() - t3 })
  })
} catch (err) {
  check('no unexpected error', false, err && (err.stack || err.message))
} finally {
  try {
    const knex = engine.db.conn()
    await knex.destroy()
    const admin = require('knex')({ client: 'pg', connection: Object.assign({}, PG, { database: 'postgres' }) })
    await admin.raw('DROP DATABASE IF EXISTS "' + WF_DB + '" WITH (FORCE)')
    await admin.destroy()
  } catch (e) { /* best effort */ }
  const failed = results.filter((r) => !r).length
  console.log('\n' + (results.length - failed) + '/' + results.length + ' passed')
  process.exit(failed ? 1 : 0)
}

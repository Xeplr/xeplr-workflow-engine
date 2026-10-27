// Running safely, through the real engine on a real Postgres: a loop is
// stopped; going on past a failure follows the arrows; an "each" arrow runs a
// limited number at once; a child that paused and finished later still lets
// its parent join; a busy job is waited for.
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
async function until(fn, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(40) }
  return null
}

const STAMP = Date.now()
const WF_DB = 'xeplr_wf_safe_test_' + STAMP
const MT = { mtId1: 'c' + (STAMP % 100000), mtId2: 'w' + (STAMP % 100000) }

registerApplication('xeplr-workflow-test')
const seen = []
let active = 0
let most = 0
actions.register({ name: 'safe-rows', inputSchema: [], execute: async () => ({ rows: [1, 2, 3, 4, 5].map((n) => ({ n })) }) })
actions.register({ name: 'safe-boom', inputSchema: [], execute: async () => { const e = new Error('the bank portal is down'); e.code = 'PORTAL_DOWN'; throw e } })
actions.register({ name: 'safe-seen', inputSchema: [{ name: 'note', type: 'string' }], execute: async (ctx) => { seen.push(ctx.input.note); return {} } })
actions.register({
  name: 'safe-slow', inputSchema: [{ name: 'n', type: 'number' }],
  execute: async (ctx) => { active++; most = Math.max(most, active); await sleep(120); active--; seen.push('item ' + ctx.input.n); return { n: ctx.input.n } }
})
actions.register({ name: 'safe-park', inputSchema: [], execute: async () => ({ parked: true }) })

await engine.startEngine({
  db: {
    name: WF_DB, connection: PG, connectionName: 'workflow_safe_test',
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } }
  },
  schedule: false
})
const Workflow = engine.db.model('Workflow')
const Step = engine.db.model('WorkflowStep')
const Run = engine.db.model('WorkflowRun')
const StepRun = engine.db.model('WorkflowStepRun')
const Key = engine.db.model('WorkflowResumeKey')

async function workflow(name, steps, extra) {
  const w = await Workflow.query().insert({ id: generateId(), name, kind: 'workflow', status: 'published', ...extra })
  for (let i = 0; i < steps.length; i++) {
    await Step.query().insert({ id: generateId(), workflowId: w.id, kind: 'auto', onError: 'stop', position: i, ...steps[i] })
  }
  return w
}
const runOf = (id) => Run.query().findById(id)
const to = (target, condition) => ({ condition: condition || null, mode: 'single', target })

try {
  await runWithMt(MT, async () => {
    console.log('a loop is stopped')
    const loop = await workflow('Loop', [
      { stepKey: 'again', name: 'Again', actionName: 'decide', values: {}, transitions: [to('again')] }
    ], { maxStepRuns: 5 })
    const lr = await engine.runner.startRun(loop.id, {})
    const lrun = await runOf(lr.id)
    check('the run fails as a loop, saying how to allow more', lrun.status === 'failed' && lrun.error.code === 'LOOP_LIMIT' && /has run 5 times.*maxStepRuns \(now 5\)/.test(lrun.error.message), lrun.error)
    check('...after exactly the limit', (await StepRun.query().where({ runId: lr.id }).resultSize()) === 5)

    console.log('\ngoing on past a failure follows the arrows')
    const cont = await workflow('Continue', [
      { stepKey: 'boom', name: 'Boom', actionName: 'safe-boom', values: {}, onError: 'continue',
        transitions: [to('tell', { left: { field: 'output.failed' }, op: 'eq', right: { value: true } }), to('end_success')] },
      { stepKey: 'skipped', name: 'Next by position', actionName: 'safe-seen', values: { note: 'by position' } },
      { stepKey: 'tell', name: 'Tell', actionName: 'safe-seen', values: { note: 'failed: {steps.boom.output.error.message} ({steps.boom.output.error.code})' } }
    ])
    const cr = await engine.runner.startRun(cont.id, {})
    check('the run goes on and succeeds', (await runOf(cr.id)).status === 'success')
    check('...down the arrow for a failure, not to the next step by position', seen.includes('failed: the bank portal is down (PORTAL_DOWN)') && !seen.includes('by position'), seen)

    console.log('\nan "each" arrow runs a limited number at once')
    const fan = await workflow('Fan', [
      { stepKey: 'rows', name: 'Rows', actionName: 'safe-rows', values: {}, joinStep: 'after',
        transitions: [{ condition: null, mode: 'each', source: 'output.rows', target: 'work', limit: 2 }] },
      { stepKey: 'work', name: 'Work', actionName: 'safe-slow', values: { n: '{item.n}' }, transitions: [to('end_success')] },
      { stepKey: 'after', name: 'After all', actionName: 'safe-seen', values: { note: 'joined' }, transitions: [to('end_success')] }
    ])
    const fr = await engine.runner.startRun(fan.id, {})
    const joined = await until(async () => { const r = await runOf(fr.id); return r.status === 'success' ? r : null })
    check('every item ran, and the parent joined once', joined && [1, 2, 3, 4, 5].every((n) => seen.includes('item ' + n)) && seen.filter((s) => s === 'joined').length === 1, seen)
    check('never more than 2 at once', most === 2, { most })

    console.log('\na child that paused and finished later still lets its parent join')
    const park = await workflow('Park', [
      { stepKey: 'rows', name: 'Rows', actionName: 'safe-rows', values: {}, joinStep: 'after',
        transitions: [{ condition: null, mode: 'each', source: 'output.rows', target: 'approve', limit: 3 }] },
      { stepKey: 'approve', name: 'Approve', actionName: 'safe-park', kind: 'wait', values: {}, transitions: [to('end_success')] },
      { stepKey: 'after', name: 'After all', actionName: 'safe-seen', values: { note: 'all approved' }, transitions: [to('end_success')] }
    ])
    const pr = await engine.runner.startRun(park.id, {})
    const firstThree = await until(async () => { const k = await Key.query().whereNull('consumedDate'); return k.length >= 3 ? k : null })
    check('3 wait at once, 2 are queued', firstThree && firstThree.length === 3, firstThree && firstThree.length)
    for (let round = 0; round < 5; round++) {
      const open = await until(async () => { const k = await Key.query().whereNull('consumedDate').first(); return k || null }, 3000)
      if (!open) break
      await engine.runner.resumeByKey(open.key, { approved: true })
    }
    const done = await until(async () => { const r = await runOf(pr.id); return r.status === 'success' ? r : null })
    check('all five approved on resume, and the parent joined', done && seen.includes('all approved'), await runOf(pr.id))

    console.log('\na busy job is waited for')
    let tries = 0
    engine.jobs.setJobStarter(async () => { tries++; if (tries < 3) { const e = new Error('busy'); e.code = 'BUSY'; throw e } return { occurrenceId: 'occ1' } })
    const ok = await actions.runAction({ name: 'job-run', input: { jobId: 'j1', busyRetrySeconds: 0.05 }, system: { runId: 'r', stepId: 's' } })
    check('started once it was free, on the third try', ok.status === 'success' && ok.output.occurrenceId === 'occ1' && tries === 3, ok.error || { tries })
    tries = 0
    const fails = await actions.runAction({ name: 'job-run', input: { jobId: 'j1', whenBusy: 'fail' }, system: { runId: 'r', stepId: 's' } })
    check('whenBusy fail: fails at once, saying so', fails.status === 'failed' && fails.error.code === 'JOB_BUSY' && /set to fail when it is busy/.test(fails.error.message) && tries === 1, fails.error)
    engine.jobs.setJobStarter(async () => { tries++; const e = new Error('busy'); e.code = 'BUSY'; throw e })
    tries = 0
    const gaveUp = await actions.runAction({ name: 'job-run', input: { jobId: 'j1', busyWaitMinutes: 0.002, busyRetrySeconds: 0.03 }, system: { runId: 'r', stepId: 's' } })
    check('still busy past the wait: fails, saying how long it tried', gaveUp.status === 'failed' && /still busy after \d+ tries/.test(gaveUp.error.message) && tries > 1, gaveUp.error)
    engine.jobs.setJobStarter(null)

    console.log('\nthe limit is checked when the arrow is saved')
    const bad = await Step.query().insert({ id: generateId(), workflowId: fan.id, stepKey: 'bad', actionName: 'decide', kind: 'auto', onError: 'stop', position: 9,
      transitions: [{ mode: 'each', source: 'output.rows', target: 'work', limit: 0 }] }).then(() => null, (e) => e)
    check('a limit of 0 is refused', bad && /`limit` is how many items run at once/.test(bad.message), bad && bad.message)
  })
} catch (err) {
  check('no error', false, err.stack || err.message)
} finally {
  await sleep(200)
  await engine.db.conn().destroy().catch(() => {})
  const admin = require('knex')({ client: 'pg', connection: { ...PG, database: 'postgres' } })
  await admin.raw(`DROP DATABASE IF EXISTS "${WF_DB}" WITH (FORCE)`).catch(() => {})
  await admin.destroy()
  const failed = results.filter((c) => !c).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}

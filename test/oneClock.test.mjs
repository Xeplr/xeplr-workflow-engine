// @flags: --preserve-symlinks
//
// ONE CLOCK: the engine runs no timer of its own. On a real Postgres with the
// real @xeplr/jobs scheduler:
//   * starting the engine with keepSchedule keeps the system job of its due
//     work — every company's, every minute, refused to change on any screen
//   * that job, picked by the scheduler, wakes a Wait box whose time has come
//     and answers in counts only (its runs are listed to every company)
//   * two schedulers on one database: each job slot is run once
//   * the source has no setInterval except the lease heartbeat
//
// Needs WORKFLOW_TEST_PG = '{"host":"localhost","port":5432,"user":"…","password":"…"}'.
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const results = []
const check = (n, c, extra) => { results.push(c); console.log((c ? '  ok   ' : '  FAIL ') + n + (c || extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 700))) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50) }
  return null
}

console.log('no timer of its own')
{
  const files = []
  const walk = (dir) => readdirSync(dir).forEach((f) => {
    const p = path.join(dir, f)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.js$/.test(f)) files.push(p)
  })
  walk(path.join(ROOT, 'lib')); walk(path.join(ROOT, 'models')); files.push(path.join(ROOT, 'index.js'))
  const hits = []
  files.forEach((f) => readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    if (/setInterval\s*\(/.test(line) && !/^\s*\/\//.test(line)) hits.push(path.relative(ROOT, f) + ':' + (i + 1))
  }))
  check('the only setInterval is the lease heartbeat in workflowRunner.js', hits.length === 1 && /^lib\/workflowRunner\.js:/.test(hits[0]), hits)
  const runner = readFileSync(path.join(ROOT, 'lib/workflowRunner.js'), 'utf8')
  check('...which renews a lease, and is unref\'d', /lease/i.test(runner.slice(Math.max(0, runner.indexOf('setInterval(') - 1500), runner.indexOf('setInterval(') + 600)) && /\.unref\(\)/.test(runner))
  const engineSrc = require('../index.js')
  check('no loop to start: startTicking / startSweeping are gone', !engineSrc.triggers.startTicking && !engineSrc.recovery.startSweeping)
}

const PG = process.env.WORKFLOW_TEST_PG ? JSON.parse(process.env.WORKFLOW_TEST_PG) : null
if (!PG) {
  console.log('  skipped the database part — set WORKFLOW_TEST_PG to run against Postgres')
  const failed = results.filter((c) => !c).length
  process.exit(failed ? 1 : 0)
}

const { registerApplication, runWithMt } = require('@xeplr/db')
const { generateId } = require('@xeplr/utils/lib/helpers')
const jobs = require('@xeplr/jobs')
const engine = require('../index.js')

const STAMP = Date.now()
const WF_DB = 'xeplr_wf_oneclock_test_' + STAMP
const JOBS_DB = 'xeplr_wf_oneclock_jobs_test_' + STAMP
const MT = { mtId1: 'c' + (STAMP % 100000), mtId2: 'w' + (STAMP % 100000) }

registerApplication('xeplr-workflow-test')
engine.jobActions.forEach((a) => jobs.registerAction(a))
const jobsConn = await jobs.init({ database: JOBS_DB, connection: PG, connectionName: 'jobs_oneclock_test', defaultActions: false, migrate: true })
await engine.startEngine({
  db: { name: WF_DB, connection: PG, connectionName: 'workflow_oneclock_test',
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } } },
  keepSchedule: jobs.keepSchedule
})
const Workflow = engine.db.model('Workflow')
const Step = engine.db.model('WorkflowStep')
const Run = engine.db.model('WorkflowRun')
const { Job, JobOccurrence } = jobs.boundModels()
const to = (target) => ({ condition: null, mode: 'single', target })

try {
  console.log('\nthe due work is a system job')
  const sys = await Job.unscopedQuery().findById(engine.schedules.DUE_JOB.id)
  check('kept on start: every company\'s, every minute, the due-work action', sys && sys.system === true && sys.mtId1 === '*' && sys.mtId2 === '*' &&
    sys.schedule === '* * * * *' && sys.actionName === 'workflow-due' && sys.status === 'ready', sys)
  await jobs.keepSchedule(engine.schedules.DUE_JOB.id, engine.schedules.DUE_JOB, { system: true })
  check('kept again on the next start: still one', (await jobsConn('jobs').where({ id: 'workflow-due' })).length === 1)
  const seen = await runWithMt(MT, () => Job.query().findById('workflow-due'))
  check('a company\'s Jobs screen lists it', Boolean(seen))

  console.log('\na Wait box wakes, with nothing but the jobs scheduler running')
  const runId = await runWithMt(MT, async () => {
    const w = await Workflow.query().insert({ id: generateId(), name: 'Wait a moment', kind: 'workflow', status: 'published' })
    await Step.query().insert({ id: generateId(), workflowId: w.id, kind: 'auto', onError: 'stop', position: 0, stepKey: 'pause', name: 'Wait',
      actionName: 'wait', values: { until: 'time', amount: 1 / 60, unit: 'minutes' }, transitions: [to('after')] })
    await Step.query().insert({ id: generateId(), workflowId: w.id, kind: 'auto', onError: 'stop', position: 1, stepKey: 'after', name: 'After',
      actionName: 'decide', values: {}, transitions: [to('end_success')] })
    return (await engine.runner.startRun(w.id, {})).id
  })
  check('the run parks on the wait', (await Run.unscopedQuery().findById(runId)).status === 'waiting')
  await sleep(1200)
  check('its time passes, and with no clock nothing wakes it', (await Run.unscopedQuery().findById(runId)).status === 'waiting')

  // Two schedulers on one database, as the API and the jobs service are: the
  // due job is due now, and both are picking.
  await jobsConn('jobs').where({ id: 'workflow-due' }).update({ nextRunAt: new Date(Date.now() - 500).toISOString() })
  const { spawn } = await import('node:child_process')
  const other = spawn(process.execPath, ['--preserve-symlinks', path.join(ROOT, 'test/oneClock.child.mjs')], {
    env: { ...process.env, OC_PG: JSON.stringify(PG), OC_WF_DB: WF_DB, OC_JOBS_DB: JOBS_DB }, stdio: ['ignore', 'pipe', 'inherit']
  })
  let ready = false
  other.stdout.on('data', (d) => { if (/ready/.test(String(d))) ready = true })
  await until(() => ready, 20000)
  jobs.startScheduler({ intervalMs: 100 })
  const done = await until(async () => { const r = await Run.unscopedQuery().findById(runId); return r.status === 'success' ? r : null })
  check('the due job woke it, and the run finished', Boolean(done), await Run.unscopedQuery().findById(runId))
  await sleep(600)
  jobs.stopScheduler()
  other.kill('SIGTERM')
  await new Promise((r) => other.on('exit', r))
  const occ = await JobOccurrence.unscopedQuery().where({ jobId: 'workflow-due', status: 'success' }).orderBy('startedAt', 'asc')
  const after = await engine.db.model('WorkflowStepRun').unscopedQuery().where({ runId, stepKey: 'after' })
  check('two schedulers, and the wait was woken once: the step after it ran once', after.length === 1, after.length)
  const woke = occ.reduce((n, o) => n + ((o.output && o.output.woken) || 0), 0)
  check('...the due job\'s runs say one wake between them', occ.length >= 1 && woke === 1, occ.map((o) => o.output))
  const out = occ[0] && occ[0].output
  check('...answering in counts only — no other company\'s run ids', out && Object.keys(out).sort().join() === 'pastDue,recovered,reminded,timedOut,watched,woken' &&
    Object.values(out).every((v) => typeof v === 'number'), out)
  check('...and its runs are every company\'s', occ.every((o) => o.mtId1 === '*'))
} catch (err) {
  check('no error', false, err.stack || err.message)
} finally {
  jobs.stopScheduler()
  await sleep(200)
  await jobsConn.destroy().catch(() => {})
  await engine.db.conn().destroy().catch(() => {})
  const admin = require('knex')({ client: 'pg', connection: { ...PG, database: 'postgres' } })
  await admin.raw(`DROP DATABASE IF EXISTS "${WF_DB}" WITH (FORCE)`).catch(() => {})
  await admin.raw(`DROP DATABASE IF EXISTS "${JOBS_DB}" WITH (FORCE)`).catch(() => {})
  await admin.destroy()
  const failed = results.filter((c) => !c).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}

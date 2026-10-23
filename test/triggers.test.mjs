// @flags: --preserve-symlinks
//
// Triggers on a real Postgres, with the real @xeplr/jobs: ordinary workflows
// started by a job finishing (and running jobs as steps, the period flowing
// on), by a schedule, and never when switched off or still a draft. Wired as
// a host wires it — jobs' onFinish → engine.jobFinished, the engine's
// startJob → jobs.trigger — in this one process. Also: the 0015 migration
// turning an old "job-chain" workflow into an ordinary one that still runs.
//
// Needs WORKFLOW_TEST_PG = '{"host":"localhost","port":5432,"user":"…","password":"…"}'.
// Scratch jobs and workflow databases are created and dropped.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual as same } from 'node:util'
const require = createRequire(import.meta.url)

const PG = process.env.WORKFLOW_TEST_PG ? JSON.parse(process.env.WORKFLOW_TEST_PG) : null
if (!PG) {
  console.log('  skipped — set WORKFLOW_TEST_PG to run against Postgres')
  process.exit(0)
}

const { registerApplication, runWithMt } = require('@xeplr/db')
const { generateId } = require('@xeplr/utils/lib/helpers')
const jobs = require('@xeplr/jobs')
const engine = require('../index.js')
const triggers = engine.triggers

const results = []
const check = (n, c, extra) => { results.push(c); console.log((c ? '  ok   ' : '  FAIL ') + n + (c || extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 500))) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(40) }
  return null
}
const refusal = (p) => p.then(() => null, (e) => e)

const STAMP = Date.now()
const JOBS_DB = 'xeplr_wf_jobs_trig_test_' + STAMP
const WF_DB = 'xeplr_wf_trig_test_' + STAMP
const MT = { mtId1: 'c' + (STAMP % 100000), mtId2: 'w' + (STAMP % 100000) }
const ran = []

registerApplication('xeplr-workflow-test')
jobs.registerAction({
  name: 'wf-trig-echo',
  inputSchema: [{ name: 'label', type: 'string' }, { name: 'n', type: 'number' }, { name: 'region', type: 'string' }, { name: 'window', type: 'object' }],
  execute: async (ctx) => { ran.push({ job: ctx.input.label, input: ctx.input }); return { totalRows: ctx.input.n || 0, region: ctx.input.region || null } }
})
jobs.registerAction({
  name: 'wf-trig-fail',
  inputSchema: [{ name: 'label', type: 'string' }],
  execute: async (ctx) => { ran.push({ job: ctx.input.label }); throw new Error('source went away') }
})

const jobsConn = await jobs.init({
  database: JOBS_DB, connection: PG, connectionName: 'jobs_wf_trig_test', defaultActions: false,
  onFinish: (report) => engine.jobFinished(report)
})
await jobsConn.migrate.latest({ directory: require('node:path').dirname(require.resolve('@xeplr/jobs')) + '/migrations' })
await engine.startEngine({
  db: {
    name: WF_DB, connection: PG, connectionName: 'workflow_trig_test',
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } }
  },
  startJob: (jobId, body) => jobs.trigger(jobId, body, { triggerType: 'workflow' }),
  // The tick is driven by hand below (triggers.tick(now)), so its timing is
  // the test's, not a timer's.
  schedule: false
})
const { Job, JobOccurrence } = jobs.boundModels()
const Workflow = engine.db.model('Workflow')
const Step = engine.db.model('WorkflowStep')
const Run = engine.db.model('WorkflowRun')
const runsOf = (workflowId) => Run.query().where({ workflowId }).orderBy('recordCreatedDate', 'asc')
const runOf = (workflowId, status) => until(async () => {
  const r = (await runsOf(workflowId)).pop()
  return r && r.status === status ? r : null
})

// An ordinary workflow, as any caller of the API saves one.
async function workflow(name, trigger, steps, extra) {
  const w = await Workflow.query().insert({ id: generateId(), name, kind: 'workflow', status: 'published', trigger, ...extra })
  for (let i = 0; i < steps.length; i++) {
    await Step.query().insert({ id: generateId(), workflowId: w.id, kind: 'auto', onError: 'stop', position: i, ...steps[i] })
  }
  return w
}
const runJob = (stepKey, jobId, values) => ({
  stepKey, name: 'Run ' + jobId, actionName: 'job-run', kind: 'wait',
  values: { jobId, callbackUrl: '{resumeUrl}', ...values },
  transitions: [{ condition: null, mode: 'single', target: 'end_success' }]
})
const when = (field, op, value, target) => ({ condition: { left: { field }, op, right: { value } }, mode: 'single', target })
const otherwise = (target) => ({ condition: null, mode: 'single', target })

try {
  await runWithMt(MT, async () => {
    const job = (label, extra) => Job.query().insert({
      id: 'j' + label + (STAMP % 1000000), name: 'Job ' + label, status: 'ready',
      actionName: 'wf-trig-echo', inputs: { label }, ...extra
    })
    const A = await job('A', { inputs: { label: 'A', n: 7, region: 'south' } })
    const B = await job('B', { acceptsInputs: ['region'] })
    const C = await job('C')
    const D = await job('D')
    const F = await job('F', { actionName: 'wf-trig-fail', inputs: { label: 'F' } })
    const X = await job('X')
    const Y = await job('Y')
    const W = { from: '2023-07-01', to: '2023-07-31' }

    console.log('a trigger is checked when it is saved')
    const bad = [
      [{ kind: 'nope' }, /is not a kind of trigger/],
      [{ kind: 'job' }, /needs `jobId`/],
      [{ kind: 'job', jobId: 'not a job!' }, /is not a job id/],
      [{ kind: 'job', jobId: A.id, when: 'sometimes' }, /`when` must be one of success, failed, finished/],
      [{ kind: 'schedule' }, /needs `cron`/],
      [{ kind: 'schedule', cron: 'every tuesday' }, /is not a cron expression/],
      ['schedule', /must be object/]
    ]
    for (const [t, msg] of bad) {
      const err = await refusal(Workflow.query().insert({ id: generateId(), name: 'bad', trigger: t }))
      check('refused: ' + JSON.stringify(t), err && (err.status || err.statusCode) === 400 && msg.test(err.message), err && err.message)
    }
    const norm = await Workflow.query().insert({ id: generateId(), name: 'norm', trigger: { kind: 'job', jobId: A.id, extra: 1 } })
    check('a job trigger defaults to "success" and keeps only its own settings', same(norm.trigger, { kind: 'job', jobId: A.id, when: 'success' }), norm.trigger)
    await Workflow.query().deleteById(norm.id)

    console.log('\na job finishing starts the workflows it triggers')
    // After A: when it moved rows, run B with A's region, carrying the count;
    // otherwise run C. After B: when at least 5 rows were carried, run D.
    const wA = await workflow('After A', { kind: 'job', jobId: A.id, when: 'success' }, [
      { stepKey: 'decide', name: 'Decide', actionName: 'decide',
        transitions: [when('trigger.output.totalRows', 'gt', 0, 'b'), otherwise('c')] },
      runJob('b', B.id, { inputs: { region: '{trigger.output.region}' }, carry: { rows: '{trigger.output.totalRows}' } }),
      runJob('c', C.id)
    ])
    const wB = await workflow('After B', { kind: 'job', jobId: B.id }, [
      { stepKey: 'decide', name: 'Decide', actionName: 'decide',
        transitions: [when('trigger.carry.rows', 'gte', 5, 'd'), otherwise('end_success')] },
      runJob('d', D.id)
    ])
    await jobs.trigger(A.id, { inputs: { window: W } })
    const bRan = await until(() => ran.find((r) => r.job === 'B'))
    check('B ran with A\'s period and the input it accepts', bRan && same(bRan.input.window, W) && bRan.input.region === 'south', bRan)
    const dRan = await until(() => ran.find((r) => r.job === 'D'))
    check('D ran two hops on, same period', dRan && same(dRan.input.window, W), dRan)
    const dOcc = await until(async () => { const o = await JobOccurrence.query().where({ jobId: D.id }).first(); return o && o.status === 'success' ? o : null })
    check('D was handed B\'s ranges and the path', dOcc && same(dOcc.chain.previous.given, W) && same(dOcc.chain.path, [A.id, B.id]), dOcc && dOcc.chain)
    check('...and the carried count as a number, not text', dOcc && dOcc.chain.carry.rows === 7, dOcc && dOcc.chain.carry)
    const runA = await runOf(wA.id, 'success')
    check('"After A" ran as an ordinary workflow and finished once B did', Boolean(runA) && runA.trigger === 'job')
    check('...started with what fired it, as triggerData', runA && runA.triggerData.jobId === A.id && runA.triggerData.status === 'success' && same(runA.triggerData.window, W), runA && runA.triggerData)
    check('C did not run (A moved rows)', !ran.some((r) => r.job === 'C'))
    const sA = await triggers.describe(await Workflow.query().findById(wA.id))
    check('its trigger says when it last fired, and which run', sA.on && Boolean(sA.lastFiredAt) && sA.lastRunId === runA.id, sA)
    check('"After B" also ran', Boolean(await runOf(wB.id, 'success')))

    console.log('\nsuccess, failure, or either')
    const wFailed = await workflow('If F fails', { kind: 'job', jobId: F.id, when: 'failed' }, [runJob('x', X.id)])
    const wFOk = await workflow('If F works', { kind: 'job', jobId: F.id, when: 'success' }, [runJob('y', Y.id)])
    const wFAny = await workflow('After F either way', { kind: 'job', jobId: F.id, when: 'finished' }, [
      { stepKey: 'decide', name: 'Decide', actionName: 'decide', transitions: [otherwise('end_success')] }
    ])
    ran.length = 0
    await jobs.trigger(F.id, {})
    const failedRun = await runOf(wFailed.id, 'success')
    check('"when failed" ran after F failed', Boolean(failedRun) && failedRun.triggerData.status === 'failed' && /source went away/.test(JSON.stringify(failedRun.triggerData.error)), failedRun && failedRun.triggerData)
    check('"finished" ran too', Boolean(await runOf(wFAny.id, 'success')))
    check('"when success" did not', (await runsOf(wFOk.id)).length === 0)

    console.log('\nswitched off, or a draft: nothing starts')
    const off = await workflow('Off', { kind: 'job', jobId: C.id, enabled: false }, [runJob('d', D.id)])
    const draft = await workflow('Draft', { kind: 'job', jobId: C.id }, [runJob('d', D.id)], { status: 'draft' })
    await jobs.trigger(C.id, {})
    await until(async () => { const o = await JobOccurrence.query().where({ jobId: C.id }).first(); return o && o.status === 'success' ? o : null })
    await sleep(400)
    check('a trigger switched off does not fire', (await runsOf(off.id)).length === 0)
    check('a draft does not fire', (await runsOf(draft.id)).length === 0)
    check('...and says it is not on', (await triggers.describe(off)).on === false && (await triggers.describe(draft)).on === false)

    console.log('\na loop is stopped')
    const wX = await workflow('After X', { kind: 'job', jobId: X.id }, [runJob('y', Y.id)])
    const wY = await workflow('After Y', { kind: 'job', jobId: Y.id }, [runJob('x', X.id)])
    await jobs.trigger(X.id, {})
    const loopRun = await runOf(wY.id, 'failed')
    check('X → Y → X is refused at the step that would loop', Boolean(loopRun) && /already run in this chain/.test(JSON.stringify(loopRun.error)), loopRun && loopRun.error)
    check('...after Y ran once', Boolean(await runOf(wX.id, 'success')))

    console.log('\na workflow that cannot start is recorded, not thrown')
    const needs = await workflow('Needs a customer', { kind: 'job', jobId: D.id },
      [{ stepKey: 'decide', name: 'Decide', actionName: 'decide', transitions: [otherwise('end_success')] }],
      { params: [{ name: 'customerId', type: 'string', required: true }] })
    const fin = await engine.jobFinished({ status: 'success', output: { jobId: D.id } })
    const st = await triggers.describe(needs)
    check('the job still finished; the skip names the missing parameter', fin.started.some((s) => s.workflowId === needs.id && !s.fired) && /customerId/.test(st.lastSkipReason || ''), st)

    console.log('\na schedule')
    const T0 = new Date('2030-01-07T08:59:00Z')
    const sched = await workflow('Mondays 9', { kind: 'schedule', cron: '0 9 * * 1', timezone: 'UTC' },
      [{ stepKey: 'decide', name: 'Decide', actionName: 'decide', transitions: [otherwise('end_success')] }])
    const offSched = await workflow('Off schedule', { kind: 'schedule', cron: '* * * * *', enabled: false },
      [{ stepKey: 'decide', name: 'Decide', actionName: 'decide', transitions: [otherwise('end_success')] }])
    const first = await triggers.tick(T0)
    check('first seen: given its next time, nothing fired', first.length === 0 && (await triggers.describe(sched)).nextDueAt && new Date((await triggers.describe(sched)).nextDueAt).toISOString() === '2030-01-07T09:00:00.000Z', await triggers.describe(sched))
    check('not due yet: nothing', (await triggers.tick(new Date('2030-01-07T08:59:30Z'))).length === 0)
    const due = new Date('2030-01-07T09:00:10Z')
    const both = await Promise.all([triggers.tick(due), triggers.tick(due)])
    const firedNow = both.flat().filter((f) => f.workflowId === sched.id && f.fired)
    check('due: two ticks at once start it once', firedNow.length === 1, both)
    const sRun = await runOf(sched.id, 'success')
    check('...with its due time as triggerData', sRun && sRun.trigger === 'schedule' && sRun.triggerData.dueAt === '2030-01-07T09:00:00.000Z', sRun && sRun.triggerData)
    check('...and the next Monday as its next time', new Date((await triggers.describe(sched)).nextDueAt).toISOString() === '2030-01-14T09:00:00.000Z')
    check('a schedule switched off never fires', (await runsOf(offSched.id)).length === 0)
    await Workflow.query().findById(sched.id).patch({ trigger: { kind: 'schedule', cron: '30 9 * * 1', timezone: 'UTC' } })
    const changed = await triggers.tick(new Date('2030-01-14T09:10:00Z'))
    check('a changed schedule gets a fresh time instead of firing on the old one', changed.length === 0 &&
      new Date((await triggers.describe(await Workflow.query().findById(sched.id))).nextDueAt).toISOString() === '2030-01-14T09:30:00.000Z')

    console.log('\nan old job chain becomes an ordinary workflow (migration 0015)')
    const oldId = generateId()
    await Workflow.query().insert({ id: oldId, name: 'After Job Y', kind: 'workflow', status: 'published' })
    await engine.db.conn().raw(`UPDATE workflows SET kind = 'job-chain', key = ? WHERE id = ?`, ['job-chain-' + Y.id, oldId])
    await Step.query().insert({ id: generateId(), workflowId: oldId, stepKey: 'decide', name: 'Decide', actionName: 'decide', kind: 'auto', onError: 'stop', position: 0, values: {}, transitions: [] })
    await engine.db.conn().raw(`UPDATE workflow_steps SET "actionName" = 'job-chain-decide', "values" = ?, transitions = ? WHERE "workflowId" = ? AND "stepKey" = 'decide'`,
      [JSON.stringify({ rules: [{ when: { field: 'status', op: '=', value: 'success' }, run: B.id, inputs: { window: '{window}', region: '{output.region}' }, carry: { n: '{carry.n}' } }] }),
        JSON.stringify([{ condition: { left: { field: 'params.status' }, op: 'eq', right: { value: 'success' } }, mode: 'single', target: 'run_1' }, { condition: null, mode: 'single', target: 'end_success' }]), oldId])
    await Step.query().insert({ id: generateId(), workflowId: oldId, stepKey: 'run_1', name: 'Run job B', actionName: 'decide', kind: 'wait', onError: 'stop', position: 1, values: {}, transitions: [] })
    await engine.db.conn().raw(`UPDATE workflow_steps SET "actionName" = 'job-chain-next', "values" = ?, transitions = ? WHERE "workflowId" = ? AND "stepKey" = 'run_1'`,
      [JSON.stringify({ jobId: B.id, inputs: { window: '{window}', region: '{output.region}' }, carry: { n: '{carry.n}' }, callbackUrl: '{resumeUrl}' }), JSON.stringify([{ condition: null, mode: 'single', target: 'end_success' }]), oldId])
    const sql = readFileSync(new URL('../migrations/0015_workflow_triggers.sql', import.meta.url), 'utf8')
    await engine.db.conn().raw(sql.slice(sql.indexOf('UPDATE "workflow_steps"')))
    const conv = await Workflow.query().findById(oldId)
    const convSteps = await Step.query().where({ workflowId: oldId }).orderBy('position')
    check('kind workflow, a job trigger, the jobs screen\'s key', conv.kind === 'workflow' && same(conv.trigger, { kind: 'job', jobId: Y.id, when: 'finished' }) && conv.key === 'after-job-' + Y.id, conv)
    check('decide and job-run steps', convSteps[0].actionName === 'decide' && convSteps[1].actionName === 'job-run')
    check('each arrow keeps its rule\'s `when`, reading the trigger; the closing one is "otherwise"',
      same(convSteps[0].transitions[0].when, { field: 'trigger.status', op: '=', value: 'success' }) && convSteps[0].transitions[1].when === null, convSteps[0].transitions)
    check('conditions and bindings read the trigger; "{window}" left to job-run', convSteps[0].transitions[0].condition.left.field === 'trigger.status' &&
      same(convSteps[1].values.inputs, { region: '{trigger.output.region}' }) && convSteps[1].values.carry.n === '{trigger.carry.n}', convSteps.map((s) => [s.transitions, s.values]))
    await Workflow.query().findById(wX.id).patch({ status: 'draft' })
    ran.length = 0
    await jobs.trigger(Y.id, { inputs: { window: W } })
    const bAfter = await until(() => ran.find((r) => r.job === 'B'))
    check('...and it runs: Y finishing starts B, with Y\'s period', bAfter && same(bAfter.input.window, W), bAfter)

    console.log('\na chain converted before 0015 kept the key and `when` is repaired (migration 0016)')
    const earlyId = generateId()
    await Workflow.query().insert({ id: earlyId, name: 'After Job D', kind: 'workflow', status: 'published',
      description: 'Made from the "After this job" rules of job ' + D.id + '.', trigger: { kind: 'job', jobId: D.id, when: 'finished' } })
    await Step.query().insert({ id: generateId(), workflowId: earlyId, stepKey: 'decide', name: 'Decide', actionName: 'decide', position: 0, values: {}, transitions: [] })
    await engine.db.conn().raw(`UPDATE workflow_steps SET transitions = ? WHERE "workflowId" = ?`, [JSON.stringify([
      { condition: { left: { field: 'trigger.output.totalRows' }, op: 'gt', right: { value: 0 } }, mode: 'single', target: 'run_1' },
      { condition: { any: [{ left: { field: 'trigger.status' }, op: 'eq', right: { value: 'failed' } }] }, mode: 'single', target: 'run_2' },
      { condition: null, mode: 'single', target: 'end_success' }
    ]), earlyId])
    const sql16 = readFileSync(new URL('../migrations/0016_after_job_shortcut.sql', import.meta.url), 'utf8')
    await engine.db.conn().raw(sql16)
    const early = await Workflow.query().findById(earlyId)
    const earlyArrows = (await Step.query().where({ workflowId: earlyId, stepKey: 'decide' }).first()).transitions
    check('it gets the jobs screen\'s key', early.key === 'after-job-' + D.id, early.key)
    check('a single comparison gets its `when` back, in the screen\'s words', same(earlyArrows[0].when, { field: 'trigger.output.totalRows', op: '>', value: 0 }), earlyArrows[0])
    check('a nested one is left without (the screen says it was changed elsewhere)', earlyArrows[1].when === undefined)
    check('an empty condition is "otherwise"', earlyArrows[2].when === null)
    await engine.db.conn().raw(sql16)
    check('running it again changes nothing', same((await Step.query().where({ workflowId: earlyId, stepKey: 'decide' }).first()).transitions, earlyArrows))
  })

  console.log('\nwithout a way to start jobs')
  engine.jobs.setJobStarter(null)
  const res = await require('@xeplr/actions').runAction({ name: 'job-run', input: { jobId: 'j1' }, system: { runId: 'r', stepId: 's' } })
  check('a job-run step with no starter and no URL fails, saying what is missing', res.status === 'failed' && /WORKFLOW_PUBLIC_URL/.test(res.error.message), res.error)
  check('decide does nothing', JSON.stringify(await require('../lib/actions/decide').execute()) === '{}')
  check('the kinds on offer', same(triggers.kinds(), ['manual', 'api', 'schedule', 'job']))
} catch (err) {
  check('no error', false, err.stack || err.message)
} finally {
  triggers.stopTicking()
  jobs.stopScheduler()
  await sleep(200)
  await jobsConn.destroy().catch(() => {})
  await engine.db.conn().destroy().catch(() => {})
  const admin = require('knex')({ client: 'pg', connection: { ...PG, database: 'postgres' } })
  await admin.raw(`DROP DATABASE IF EXISTS "${JOBS_DB}" WITH (FORCE)`).catch(() => {})
  await admin.raw(`DROP DATABASE IF EXISTS "${WF_DB}" WITH (FORCE)`).catch(() => {})
  await admin.destroy()
  const failed = results.filter((c) => !c).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}

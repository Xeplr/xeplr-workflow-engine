// @flags: --preserve-symlinks
//
// "After this job" on a real Postgres, with the real @xeplr/jobs: a job ends,
// the engine reads its rules, starts the next job with the period it ran for
// and the values carried so far, waits for it, and that job's rules carry on.
// Wired exactly as a host wires it — jobs' onFinish → jobChains.jobFinished,
// the engine's startJob → jobs.trigger — in this one process.
//
// Needs WORKFLOW_TEST_PG = '{"host":"localhost","port":5432,"user":"…","password":"…"}'.
// Scratch jobs and workflow databases are created and dropped.
import { createRequire } from 'node:module'
import { isDeepStrictEqual as same } from 'node:util'
const require = createRequire(import.meta.url)

const PG = process.env.WORKFLOW_TEST_PG ? JSON.parse(process.env.WORKFLOW_TEST_PG) : null
if (!PG) {
  console.log('  skipped — set WORKFLOW_TEST_PG to run against Postgres')
  process.exit(0)
}

const { registerApplication, runWithMt } = require('@xeplr/db')
const jobs = require('@xeplr/jobs')
const engine = require('../index.js')
const chains = engine.jobChains

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
const JOBS_DB = 'xeplr_wf_jobs_chain_test_' + STAMP
const WF_DB = 'xeplr_wf_chain_test_' + STAMP
const MT = { mtId1: 'c' + (STAMP % 100000), mtId2: 'w' + (STAMP % 100000) }
const ran = []

registerApplication('xeplr-workflow-test')
jobs.registerAction({
  name: 'wf-chain-echo',
  inputSchema: [{ name: 'label', type: 'string' }, { name: 'n', type: 'number' }, { name: 'region', type: 'string' }, { name: 'window', type: 'object' }],
  execute: async (ctx) => { ran.push({ job: ctx.input.label, input: ctx.input }); return { totalRows: ctx.input.n || 0, region: ctx.input.region || null } }
})
// Given no range, it reports the one it covered — as an incremental movement
// that started from the copy's own highest value does.
jobs.registerAction({
  name: 'wf-chain-reports',
  inputSchema: [{ name: 'label', type: 'string' }],
  execute: async (ctx) => { ran.push({ job: ctx.input.label }); return { window: { column: 'postedAt', from: '2026-10-01', to: null } } }
})
jobs.registerAction({
  name: 'wf-chain-fail',
  inputSchema: [{ name: 'label', type: 'string' }],
  execute: async (ctx) => { ran.push({ job: ctx.input.label }); throw new Error('source went away') }
})

const jobsConn = await jobs.init({
  database: JOBS_DB, connection: PG, connectionName: 'jobs_wf_test', defaultActions: false,
  onFinish: (report) => chains.jobFinished(report)
})
await jobsConn.migrate.latest({ directory: require('node:path').dirname(require.resolve('@xeplr/jobs')) + '/migrations' })
await engine.startEngine({
  db: {
    name: WF_DB, connection: PG, connectionName: 'workflow_chain_test',
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } }
  },
  startJob: (jobId, body) => jobs.trigger(jobId, body, { triggerType: 'workflow' })
})
const { Job, JobOccurrence } = jobs.boundModels()
const Run = engine.db.model('WorkflowRun')
const runOf = (workflowId, status) => until(async () => {
  const r = await Run.query().where({ workflowId }).orderBy('recordCreatedDate', 'desc').first()
  return r && r.status === status ? r : null
})

try {
  await runWithMt(MT, async () => {
    const job = (label, extra) => Job.query().insert({
      id: 'j' + label + (STAMP % 1000000), name: 'Job ' + label, status: 'ready',
      actionName: 'wf-chain-echo', inputs: { label }, ...extra
    })
    const A = await job('A', { inputs: { label: 'A', n: 7, region: 'south' } })
    const B = await job('B', { acceptsInputs: ['region'] })
    const C = await job('C')
    const D = await job('D')
    const F = await job('F', { actionName: 'wf-chain-fail', inputs: { label: 'F' } })
    const X = await job('X')
    const Y = await job('Y')

    console.log('rules ⇄ workflow')
    const saved = await chains.putChain(A.id, { jobName: A.name, rules: [
      { when: { field: 'output.totalRows', op: '>', value: 0 }, run: B.id, inputs: { region: '{output.region}' }, carry: { rows: '{output.totalRows}' } },
      { run: C.id }
    ] })
    check('saved as a published job-chain workflow', Boolean(saved.workflowId) && saved.rules.length === 2)
    const wf = await engine.db.model('Workflow').query().findById(saved.workflowId)
    check('kind job-chain, keyed by the job', wf.kind === 'job-chain' && wf.key === 'job-chain-' + A.id && wf.status === 'published' && wf.name === 'After Job A')
    check('read back as written', same((await chains.getChain(A.id)).rules[0].when, { field: 'output.totalRows', op: '>', value: 0 }))
    check('a job with no rules answers an empty list', (await chains.getChain(D.id)).rules.length === 0 && (await chains.getChain(D.id)).workflowId === null)
    await chains.putChain(B.id, { rules: [{ when: { all: [{ field: 'carry.rows', op: '>=', value: 5 }, { field: 'status', op: '=', value: 'success' }] }, run: D.id }] })

    const bad = [
      [{ rules: 'x' }, /`rules` must be a list/],
      [{ rules: [null] }, /Rule 1: must be an object/],
      [{ rules: [{}] }, /Rule 1: choose the job to run/],
      [{ rules: [{ run: 'not a job id!' }] }, /is not a job id/],
      [{ rules: [{ run: A.id }] }, /cannot run itself/],
      [{ rules: [{ run: B.id }, { run: C.id }] }, /Rule 2: rule 1 has no condition/],
      [{ rules: [{ when: 'status', run: B.id }] }, /must be an object such as/],
      [{ rules: [{ when: { field: '', op: '=', value: 1 }, run: B.id }] }, /`field` is required/],
      [{ rules: [{ when: { field: 'output..x', op: '=', value: 1 }, run: B.id }] }, /is not a usable field/],
      [{ rules: [{ when: { field: 'secret', op: '=', value: 1 }, run: B.id }] }, /must start with one of status/],
      [{ rules: [{ when: { field: 'status', op: 'like', value: 1 }, run: B.id }] }, /not a comparison this engine has/],
      [{ rules: [{ when: { any: [] }, run: B.id }] }, /`any` needs a non-empty list/],
      [{ rules: [{ when: { all: [null] }, run: B.id }] }, /an empty condition inside `all`/],
      [{ rules: [{ run: B.id, inputs: [1] }] }, /`inputs` must be an object/]
    ]
    for (const [body, re] of bad) {
      const e = await refusal(chains.putChain(A.id, body))
      check('refused: ' + re.source.replace(/\\/g, ''), e && e.status === 400 && e.code === 'CHAIN_INVALID' && re.test(e.message), e && e.message)
    }
    check('a bad job id in the URL is refused', (await refusal(chains.putChain('x y', { rules: [] }))).code === 'CHAIN_INVALID')
    check('refusals leave the rules as they were', (await chains.getChain(A.id)).rules.length === 2)

    console.log('\nA finishes with rows: B gets A\'s period, then B\'s rule runs D')
    const W = { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }
    await jobs.trigger(A.id, { inputs: { window: W } })
    const dRan = await until(() => ran.find((r) => r.job === 'D'))
    const bRan = ran.find((r) => r.job === 'B')
    check('B ran with A\'s period and the input it accepts', bRan && same(bRan.input.window, W) && bRan.input.region === 'south', bRan)
    check('C (otherwise) did not run', !ran.some((r) => r.job === 'C'))
    check('D ran two hops on, same period', dRan && same(dRan.input.window, W))
    const dOcc = await until(async () => { const o = await JobOccurrence.query().where({ jobId: D.id }).first(); return o && o.status === 'success' ? o : null })
    check('A\'s carried value and the path reached D', dOcc && dOcc.chain.carry.rows === 7 && same(dOcc.chain.path, [A.id, B.id]), dOcc && dOcc.chain)
    const aRun = await runOf(saved.workflowId, 'success')
    check('A\'s chain run succeeds once B has finished', aRun && aRun.trigger === 'job' && aRun.params.jobId === A.id)

    console.log('\ngiven no range: the range the job reports it covered flows on')
    ran.length = 0
    const G = await job('G', { actionName: 'wf-chain-reports', inputs: { label: 'G' } })
    await chains.putChain(G.id, { rules: [{ run: C.id }] })
    await jobs.trigger(G.id, {})
    const cFromG = await until(() => ran.find((r) => r.job === 'C'))
    check('C got the range G covered', cFromG && same(cFromG.input.window, { column: 'postedAt', from: '2026-10-01', to: null }), cFromG && cFromG.input)
    const cOccG = await until(async () => (await JobOccurrence.query().where({ jobId: C.id })).find((o) => o.chain && o.chain.previous && o.chain.previous.used))
    check('…and both of G\'s ranges as previous: given none, used where it read', cOccG && cOccG.chain.previous.given === null &&
      same(cOccG.chain.previous.used, { column: 'postedAt', from: '2026-10-01', to: null }), cOccG && cOccG.chain)
    await chains.putChain(G.id, { rules: [] })

    console.log('\nno rows: the otherwise rule runs C')
    ran.length = 0
    await Job.query().findById(A.id).patch({ inputs: { label: 'A', n: 0 } })
    await jobs.trigger(A.id, { inputs: { window: W } })
    const cRan = await until(() => ran.find((r) => r.job === 'C'))
    check('C ran, with the period passed on', cRan && same(cRan.input.window, W) && !ran.some((r) => r.job === 'B'))

    console.log('\nno rule matches: nothing runs, and that is not a failure')
    ran.length = 0
    await chains.putChain(D.id, { rules: [{ when: { field: 'status', op: '=', value: 'failed' }, run: C.id }] })
    await jobs.trigger(D.id, {})
    const dChain = await chains.getChain(D.id)
    check('the chain run ends success without running anything', Boolean(await runOf(dChain.workflowId, 'success')) && !ran.some((r) => r.job === 'C'))

    console.log('\na failed job can be followed')
    ran.length = 0
    await chains.putChain(F.id, { rules: [{ when: { field: 'status', op: '=', value: 'failed' }, run: C.id, carry: { why: '{error.message}', note: 'F failed: {error.message}' } }] })
    await jobs.trigger(F.id, {})
    const cOcc = await until(async () => (await JobOccurrence.query().where({ jobId: C.id })).find((o) => o.chain && o.chain.carry && o.chain.carry.why))
    check('C ran after F failed, carrying why (whole value and inside text)', cOcc && /source went away/.test(cOcc.chain.carry.why) && /^F failed: .*source went away/.test(cOcc.chain.carry.note), cOcc && cOcc.chain)

    console.log('\nwhat a chain cannot do')
    ran.length = 0
    await chains.putChain(X.id, { rules: [{ run: Y.id }] })
    await chains.putChain(Y.id, { rules: [{ run: X.id }] })
    await jobs.trigger(X.id, {})
    const loop = await runOf((await chains.getChain(Y.id)).workflowId, 'failed')
    check('X → Y → X stops, saying why', loop && /has already run in this chain/.test(loop.error.message) && ran.filter((r) => r.job === 'X').length === 1, loop && loop.error)

    await chains.putChain(C.id, { rules: [{ run: B.id, inputs: { sql: 'DELETE FROM orders' } }] })
    ran.length = 0
    await jobs.trigger(C.id, {})
    const badRun = await runOf((await chains.getChain(C.id)).workflowId, 'failed')
    check('an input the next job does not accept fails the run, named', badRun && /cannot be overridden by a request: sql/.test(JSON.stringify(badRun.error)) && !ran.some((r) => r.job === 'B'), badRun && badRun.error)

    const tooLong = (() => { try { chains.nextJobCall({ path: Array.from({ length: 25 }, (_, i) => 'j' + i) }, { jobId: 'jz' }); return null } catch (e) { return e } })()
    check('a chain 25 jobs long stops', tooLong && /the most allowed/.test(tooLong.message))
    check('a rule\'s own window wins over the finished job\'s', same(chains.nextJobCall({ window: W }, { jobId: 'j', inputs: { window: '{carry.w}' } }).inputs.window, null) &&
      same(chains.nextJobCall({ window: W, carry: { w: { from: 'x' } } }, { jobId: 'j', inputs: { window: '{carry.w}' } }).inputs.window, { from: 'x' }))
    check('typed bindings: lists and numbers stay themselves', same(chains.resolveTyped(['{carry.n}', 7, true], { carry: { n: 3 } }), [3, 7, true]))

    console.log('\nthe job-run step starts a job in-process, and is resumed in-process')
    ran.length = 0
    const plain = await engine.db.model('Workflow').query().insert({ id: 'wplain' + (STAMP % 100000), name: 'Plain', kind: 'workflow', status: 'published' })
    await engine.db.model('WorkflowStep').query().insert({
      id: 'splain' + (STAMP % 100000), workflowId: plain.id, stepKey: 'run_b', actionName: 'job-run', kind: 'wait', onError: 'stop',
      values: { jobId: B.id, inputs: { window: { from: 'p', to: 'q' } } }, position: 0
    })
    await engine.runner.startRun(plain.id, {}, { trigger: 'manual' })
    const plainRun = await runOf(plain.id, 'success')
    check('job-run with no jobsUrl and no WORKFLOW_PUBLIC_URL runs B and finishes', Boolean(plainRun) && ran.some((r) => r.job === 'B' && same(r.input.window, { from: 'p', to: 'q' })))

    console.log('\nremoving the rules')
    check('an empty list removes them', (await chains.putChain(A.id, { rules: [] })).rules.length === 0 && (await chains.getChain(A.id)).rules.length === 0)
    check('removing rules a job never had is fine', (await chains.putChain(A.id + 'z', { rules: [] })).workflowId === null)
    ran.length = 0
    await jobs.trigger(A.id, {})
    await until(() => ran.find((r) => r.job === 'A'))
    await sleep(400)
    check('A finishing now runs nothing after it', ran.every((r) => r.job === 'A'))
    check('a report with no job id starts nothing', (await chains.jobFinished({ output: {} })).runId === null)
    check('the generated workflow cannot be hand-edited', await chains.touchesChains({ id: saved.workflowId }) &&
      await chains.touchesChains([{ kind: 'job-chain' }]) && !(await chains.touchesChains({ id: 'nope' })) && !(await chains.touchesChains(null)))
  })

  console.log('\nwithout a way to start jobs')
  chains.setJobStarter(null)
  const steps = require('../lib/actions/jobChainSteps.js')
  const res = await require('@xeplr/actions').runAction({ name: steps.next.name, input: { jobId: 'j1' }, system: { runId: 'r', stepId: 's' } })
  check('a chain step fails, naming startJob', res.status === 'failed' && /startJob/.test(res.error.message))
  check('decide does nothing', JSON.stringify(await steps.decide.execute()) === '{}')
} catch (err) {
  check('no error', false, err.stack || err.message)
} finally {
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

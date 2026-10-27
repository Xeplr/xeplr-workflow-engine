// One case on several paths at once, through the real engine on a real
// Postgres: a step that leaves by every matching arrow opens a path per arrow;
// a meeting point waits for all, any one, or at least N of the paths that were
// actually opened, stops early on a reject, withdraws or lets finish the rest,
// and its arrows read what every path brought.
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
const check = (n, c, extra) => { results.push(c); console.log((c ? '  ok   ' : '  FAIL ') + n + (c || extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 700))) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const STAMP = Date.now()
const WF_DB = 'xeplr_wf_parallel_test_' + STAMP
const MT = { mtId1: 'c' + (STAMP % 100000), mtId2: 'w' + (STAMP % 100000) }

registerApplication('xeplr-workflow-test')
let seen = []
actions.register({ name: 'pp-note', inputSchema: [{ name: 'note', type: 'string' }], execute: async (ctx) => { seen.push(ctx.input.note); return { note: ctx.input.note, amount: 250 } } })
actions.register({ name: 'pp-park', inputSchema: [], execute: async () => ({}) })
actions.register(require('../lib/actions/screenShow.js'))

await engine.startEngine({
  db: {
    name: WF_DB, connection: PG, connectionName: 'workflow_parallel_test',
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } }
  },
  schedule: false, recover: false
})
const Workflow = engine.db.model('Workflow')
const Step = engine.db.model('WorkflowStep')
const Run = engine.db.model('WorkflowRun')
const StepRun = engine.db.model('WorkflowStepRun')
const Key = engine.db.model('WorkflowResumeKey')
const Path = engine.db.model('WorkflowRunPath')
const Arrival = engine.db.model('WorkflowRunArrival')
const Split = engine.db.model('WorkflowRunSplit')

async function workflow(name, steps) {
  const w = await Workflow.query().insert({ id: generateId(), name, kind: 'workflow', status: 'published' })
  for (let i = 0; i < steps.length; i++) {
    await Step.query().insert({ id: generateId(), workflowId: w.id, kind: 'auto', onError: 'stop', position: i, values: {}, ...steps[i] })
  }
  return w
}
const runOf = (id) => Run.query().findById(id)
const to = (target, when) => ({ when: when || null, mode: 'single', target })
const note = (stepKey, text, extra) => ({ stepKey, name: stepKey, actionName: 'pp-note', values: { note: text }, ...extra })
const ask = (stepKey, target) => ({ stepKey, name: stepKey, actionName: 'pp-park', kind: 'wait', transitions: [to(target)] })
const keyOf = async (runId, stepKey) => {
  const steps = await Step.query()
  const live = await Key.query().where({ runId }).whereNull('consumedDate')
  return live.find((k) => steps.find((s) => s.id === k.stepId && s.stepKey === stepKey)) || null
}
const answer = async (runId, stepKey, output) => engine.runner.resumeByKey((await keyOf(runId, stepKey)).key, output)
const rejected = { field: 'arrivals.rejected', op: '>=', value: 1 }

// The deviation sign-off from the design: QA head and production head both
// sign; the first reject sends the line back at once.
const SIGN_OFF = [
  note('deviation', 'deviation found', { leave: 'every', transitions: [to('qa'), to('production')] }),
  ask('qa', 'meet'),
  ask('production', 'meet'),
  note('meet', 'met: {arrivals.approved} approved, {arrivals.rejected} rejected', {
    join: { wait: 'all', stopWhen: rejected },
    transitions: [to('returned', rejected), to('accepted')]
  }),
  note('accepted', 'accept line to stock', { transitions: [to('end_success')] }),
  note('returned', 'return to supplier', { transitions: [to('end_success')] })
]

try {
  await runWithMt(MT, async () => {
    console.log('a split opens a path per arrow, and the case waits on both')
    const signOff = await workflow('Sign-off', SIGN_OFF)
    seen = []
    const r1 = await engine.runner.startRun(signOff.id, {})
    const open1 = await Path.query().where({ runId: r1.id, status: 'waiting' })
    check('two paths, each waiting on its own step', open1.length === 2 && open1.map((p) => p.stepKey).sort().join() === 'production,qa', open1)
    check('...two live keys, and the run is waiting', (await Key.query().where({ runId: r1.id }).whereNull('consumedDate')).length === 2 && r1.status === 'waiting', r1.status)
    const split1 = await Split.query().where({ runId: r1.id }).first()
    check('...one split, recording that it opened 2', split1 && split1.opened === 2 && split1.stepKey === 'deviation')

    await answer(r1.id, 'qa', { decision: 'approved' })
    check('one answer: the case still waits for the other', (await runOf(r1.id)).status === 'waiting' && !seen.some((s) => s.startsWith('met')), seen)
    await answer(r1.id, 'production', { decision: 'approved' })
    const done1 = await runOf(r1.id)
    check('both answers: the meeting point runs once, and the case is accepted',
      done1.status === 'success' && seen.filter((s) => s.startsWith('met')).length === 1 && seen.includes('accept line to stock'), { done1, seen })
    check('...the meeting step read every answer', seen.includes('met: 2 approved, 0 rejected'), seen)
    check('...and both arrivals are recorded', (await Arrival.query().where({ splitId: split1.id, late: false })).length === 2)

    console.log('\ntwo answers in the same instant')
    seen = []
    const r2 = await engine.runner.startRun(signOff.id, {})
    const [kq, kp] = [await keyOf(r2.id, 'qa'), await keyOf(r2.id, 'production')]
    await Promise.all([
      engine.runner.resumeByKey(kq.key, { decision: 'approved' }),
      engine.runner.resumeByKey(kp.key, { decision: 'approved' })
    ])
    const meets = await StepRun.query().where({ runId: r2.id, stepKey: 'meet' })
    check('the meeting point runs exactly once', meets.length === 1, meets.length)
    check('...and the case finishes', (await runOf(r2.id)).status === 'success')

    console.log('\na reject stops the rest at once')
    seen = []
    const r3 = await engine.runner.startRun(signOff.id, {})
    const prodKey = await keyOf(r3.id, 'production')
    await answer(r3.id, 'qa', { decision: 'rejected', comment: 'cracks' })
    check('the first reject sends the line back without waiting', (await runOf(r3.id)).status === 'success' && seen.includes('return to supplier') && seen.includes('met: 0 approved, 1 rejected'), seen)
    const prodPath = await Path.query().where({ runId: r3.id, stepKey: 'production' }).first()
    const prodStep = await StepRun.query().where({ runId: r3.id, stepKey: 'production' }).first()
    check('...the other approver\'s path is withdrawn', prodPath.status === 'cancelled' && prodStep.status === 'skipped' && prodStep.error.code === 'WITHDRAWN', { prodPath, prodStep })
    const late = await engine.runner.resumeByKey(prodKey.key, { decision: 'approved' }).then(() => null, (e) => e)
    check('...and their link no longer works', late && late.code === 'RESUME_KEY_INVALID', late && late.message)

    console.log('\nany one of three')
    const anyOne = await workflow('Any one', [
      note('raise', 'raised', { leave: 'every', transitions: [to('asha'), to('ben'), to('chen')] }),
      ask('asha', 'confirm'), ask('ben', 'confirm'), ask('chen', 'confirm'),
      note('confirm', 'confirmed by {arrivals.arrived}', { join: { wait: 'any' } })
    ])
    seen = []
    const r4 = await engine.runner.startRun(anyOne.id, {})
    await answer(r4.id, 'ben', { decision: 'approved' })
    check('the first to answer moves the case', (await runOf(r4.id)).status === 'success' && seen.includes('confirmed by 1'), seen)
    check('...the other two are withdrawn', (await Path.query().where({ runId: r4.id, status: 'cancelled' })).length === 2 &&
      (await Key.query().where({ runId: r4.id }).whereNull('consumedDate')).length === 0)

    console.log('\nat least 2 of 3, the third left to finish')
    const twoOfThree = await workflow('Two of three', [
      note('raise', 'raised', { leave: 'every', transitions: [to('a'), to('b'), to('c')] }),
      ask('a', 'decide'), ask('b', 'decide'), ask('c', 'decide'),
      note('decide', 'decided with {arrivals.arrived}', { join: { wait: { atLeast: 2 }, others: 'finish' } })
    ])
    seen = []
    const r5 = await engine.runner.startRun(twoOfThree.id, {})
    await answer(r5.id, 'a', { decision: 'approved' })
    check('one is not enough', !seen.some((s) => s.startsWith('decided')))
    await answer(r5.id, 'c', { decision: 'approved' })
    check('two: it runs, with two arrived', seen.includes('decided with 2'), seen)
    check('...but the case waits for the third, left to finish', (await runOf(r5.id)).status === 'waiting')
    await answer(r5.id, 'b', { decision: 'rejected' })
    const lateB = await Arrival.query().where({ runId: r5.id, late: true }).first()
    check('the third arrives late: recorded, nothing runs again, and the case is done',
      lateB && lateB.decision === 'rejected' && (await runOf(r5.id)).status === 'success' && seen.filter((s) => s.startsWith('decided')).length === 1, { lateB })

    console.log('\nan arrow whose condition was false opens no path to wait for')
    const legal = await workflow('Legal only if large', [
      note('order', 'order', { leave: 'every', transitions: [to('finance'), to('legal', { field: 'params.amount', op: '>', value: 100000 }), to('stores')] }),
      ask('finance', 'go'), ask('legal', 'go'), ask('stores', 'go'),
      note('go', 'go with {arrivals.expected}', { join: { wait: 'all' } })
    ])
    seen = []
    const r6 = await engine.runner.startRun(legal.id, { amount: 500 })
    check('two paths opened, not three', (await Split.query().where({ runId: r6.id }).first()).opened === 2)
    await answer(r6.id, 'finance', { decision: 'approved' })
    await answer(r6.id, 'stores', { decision: 'approved' })
    check('...and "all" means those two', (await runOf(r6.id)).status === 'success' && seen.includes('go with 2'), seen)

    console.log('\nat least N that can no longer be reached')
    const unreachable = await workflow('Unreachable', [
      note('raise', 'raised', { leave: 'every', transitions: [to('a'), to('b')] }),
      { stepKey: 'a', name: 'a', actionName: 'pp-park', kind: 'wait', transitions: [to('meet')] },
      { stepKey: 'b', name: 'b', actionName: 'pp-park', kind: 'wait', transitions: [to('meet', { field: 'output.decision', op: '=', value: 'approved' }), to('end_success')] },
      note('meet', 'met', { join: { wait: { atLeast: 2 } } })
    ])
    const r7 = await engine.runner.startRun(unreachable.id, {})
    await answer(r7.id, 'a', { decision: 'approved' })
    await answer(r7.id, 'b', { decision: 'rejected' })
    const r7done = await runOf(r7.id)
    check('the run fails saying how many arrived, instead of waiting forever', r7done.status === 'failed' && r7done.error.code === 'JOIN_IMPOSSIBLE' && /at least 2.*only 1 arrived/.test(r7done.error.message), r7done.error)

    console.log('\na path reads its own steps; the meeting point reads them all')
    const reads = await workflow('Reads', [
      note('start', 'start', { leave: 'every', transitions: [to('left'), to('right')] }),
      note('left', 'left saw [{steps.right.output.note}]', { transitions: [to('meet')] }),
      note('right', 'right', { transitions: [to('meet')] }),
      note('meet', 'met {arrivals.arrived}, start was {steps.start.output.note}', { join: { wait: 'all' } })
    ])
    seen = []
    const r8 = await engine.runner.startRun(reads.id, {})
    check('a path never reads a parallel path\'s step', seen.includes('left saw []'), seen)
    check('...the meeting point has every arrival, and the steps before the split', seen.includes('met 2, start was start') && (await runOf(r8.id)).status === 'success', seen)

    console.log('\narrows read earlier steps')
    const earlier = await workflow('Earlier', [
      note('fetch', 'fetched'),
      note('pause', 'paused', { transitions: [to('big', { field: 'steps.fetch.output.amount', op: '>', value: 100 }), to('small')] }),
      note('big', 'big', { transitions: [to('end_success')] }),
      note('small', 'small')
    ])
    seen = []
    await engine.runner.startRun(earlier.id, {})
    check('an arrow on a later step branches on an earlier step\'s output', seen.includes('big') && !seen.includes('small'), seen)

    console.log('\ngoing back splits again, and counts afresh')
    const again = await workflow('Again', [
      note('deviation', 'deviation', { leave: 'every', transitions: [to('qa'), to('production')] }),
      ask('qa', 'meet'), ask('production', 'meet'),
      note('meet', 'met', { join: { wait: 'all', stopWhen: rejected }, transitions: [to('deviation', rejected), to('end_success')] })
    ])
    const r9 = await engine.runner.startRun(again.id, {})
    await answer(r9.id, 'qa', { decision: 'rejected' })
    const splits9 = await Split.query().where({ runId: r9.id })
    check('a reject goes back and splits again', splits9.length === 2 && (await runOf(r9.id)).status === 'waiting', splits9.length)
    await answer(r9.id, 'qa', { decision: 'approved' })
    check('round 2 does not count round 1\'s answers', (await runOf(r9.id)).status === 'waiting')
    await answer(r9.id, 'production', { decision: 'approved' })
    check('...and finishes when round 2 is complete', (await runOf(r9.id)).status === 'success')

    console.log('\nending the case from one path')
    const ender = await workflow('Ender', [
      note('start', 'start', { leave: 'every', transitions: [to('wait'), to('stop')] }),
      ask('wait', 'end_success'),
      note('stop', 'stop', { transitions: [to('end_run')] })
    ])
    const r10 = await engine.runner.startRun(ender.id, {})
    check('end_run finishes the whole case, and the other path\'s link is spent',
      (await runOf(r10.id)).status === 'success' && (await Key.query().where({ runId: r10.id }).whereNull('consumedDate')).length === 0)
    const failer = await workflow('Failer', [
      note('start', 'start', { leave: 'every', transitions: [to('wait'), to('fail')] }),
      ask('wait', 'end_success'),
      note('fail', 'fail', { transitions: [to('end_failed')] })
    ])
    const r11 = await engine.runner.startRun(failer.id, {})
    check('end_failed on one path fails the case, and ends the other', (await runOf(r11.id)).status === 'failed' &&
      (await Path.query().where({ runId: r11.id }).whereIn('status', ['ready', 'running', 'waiting'])).length === 0)
    const oneEnds = await workflow('One ends', [
      note('start', 'start', { leave: 'every', transitions: [to('wait'), to('end_success')] }),
      ask('wait', 'end_success')
    ])
    const r12 = await engine.runner.startRun(oneEnds.id, {})
    check('end_success ends only that path: the case still waits on the other', (await runOf(r12.id)).status === 'waiting')
    await answer(r12.id, 'wait', {})
    check('...and finishes with it', (await runOf(r12.id)).status === 'success')

    console.log('\nwhat cannot be saved')
    const refused = async (step) => Step.query().insert({ id: generateId(), workflowId: signOff.id, stepKey: 'x' + Math.random().toString(36).slice(2, 8), actionName: 'pp-note', position: 99, ...step }).then(() => null, (e) => e)
    const e1 = await refused({ leave: 'every', transitions: [{ mode: 'each', source: 'output.rows', target: 'qa' }] })
    check('every matching arrow, with an arrow for each item', e1 && e1.code === 'STEP_FLOW_INVALID', e1 && e1.message)
    const e2 = await refused({ join: { wait: 'most' } })
    check('a meeting point waiting for "most"', e2 && /`wait` is "all", "any", or \{ "atLeast": N \}/.test(e2.message), e2 && e2.message)
    const e3 = await refused({ join: { wait: 'all', others: 'ignore' } })
    check('...or doing "ignore" with the others', e3 && /`others`/.test(e3.message), e3 && e3.message)
    const e4 = await refused({ leave: 'sometimes' })
    check('...or leaving "sometimes"', e4 && /not a way to leave a step/.test(e4.message), e4 && e4.message)
    const ok = await Step.query().insert({ id: generateId(), workflowId: signOff.id, stepKey: 'fine', actionName: 'pp-note', position: 98, join: { wait: { atLeast: 2 }, stopWhen: rejected } })
    check('a good one is saved with its stop condition compiled', ok.join.stopCondition && ok.join.stopCondition.left.field === 'arrivals.rejected', ok.join)
    const node = { left: { field: 'arrivals.rejected' }, op: 'gte', right: { value: 1 } }
    const asNode = await Step.query().insert({ id: generateId(), workflowId: signOff.id, stepKey: 'fine2', actionName: 'pp-note', position: 97, join: { wait: 'all', stopCondition: node } })
    check('...and one already compiled, as a designer saves it, is kept', JSON.stringify(asNode.join.stopCondition) === JSON.stringify(node), asNode.join)
    const e5 = await refused({ join: { wait: 'all', stopCondition: 'arrivals.rejected >= 1' } })
    check('...but text where the condition goes is refused', e5 && /`stopCondition` is a condition/.test(e5.message), e5 && e5.message)

    console.log('\na list for each item while on parallel paths')
    const eachInside = await workflow('Each inside', [
      note('start', 'start', { leave: 'every', transitions: [to('wait'), to('list')] }),
      ask('wait', 'end_success'),
      note('list', 'list', { transitions: [{ mode: 'each', source: 'output.rows', target: 'wait' }, to('end_success')] })
    ])
    actions.register({ name: 'pp-rows', inputSchema: [], execute: async () => ({ rows: [1, 2] }) })
    await Step.query().patch({ actionName: 'pp-rows' }).where({ workflowId: eachInside.id, stepKey: 'list' })
    const r13 = await engine.runner.startRun(eachInside.id, {})
    const r13done = await runOf(r13.id)
    check('it fails saying where to put the list, rather than half-working', r13done.status === 'failed' && r13done.error.code === 'EACH_IN_PARALLEL', r13done.error)

    console.log('\ntwo screens waiting at once')
    const screens = await workflow('Two screens', [
      note('start', 'start', { leave: 'every', transitions: [to('qa'), to('production')] }),
      { stepKey: 'qa', name: 'QA sign-off', actionName: 'screen-show', kind: 'wait', values: { screen: 'qa_form' }, transitions: [to('meet')] },
      { stepKey: 'production', name: 'Production sign-off', actionName: 'screen-show', kind: 'wait', values: { screen: 'prod_form' }, transitions: [to('meet')] },
      note('meet', 'signed', { join: { wait: 'all' } })
    ])
    const r14 = await engine.runner.startRun(screens.id, {})
    const view = await engine.flows.getRun(r14.id)
    check('the run view lists both', view.waitingOn.length === 2 && view.waitingOn.map((w) => w.screen).sort().join() === 'prod_form,qa_form', view.waitingOn)
    const unsaid = await engine.flows.submitRun(r14.id, { values: {} }, { user: { id: 'u1', roles: [] } }).then(() => null, (e) => e)
    check('a submit that does not say which is refused, naming both', unsaid && unsaid.code === 'SAY_WHICH_STEP' && /qa/.test(unsaid.message) && /production/.test(unsaid.message), unsaid && unsaid.message)
    const first = await engine.flows.submitRun(r14.id, { values: { ok: true }, stepKey: 'qa' }, { user: { id: 'u1', roles: [] } })
    check('naming one answers that one', first.waitingOn.length === 1 && first.waitingOn[0].stepKey === 'production', first.waitingOn)
    await engine.flows.submitRun(r14.id, { values: { ok: true } }, { user: { id: 'u1', roles: [] } })
    check('...and with one left it need not say', (await runOf(r14.id)).status === 'success')

    console.log('\na crash with two paths')
    const crashed = await workflow('Crashed', SIGN_OFF)
    const r15 = await engine.runner.startRun(crashed.id, {})
    // As a process that died just after QA answered, before choosing the
    // next step: QA's step finished, its path running, the lease expired.
    const qaKey = await keyOf(r15.id, 'qa')
    await Key.query().findById(qaKey.id).patch({ consumedDate: new Date().toISOString() })
    await StepRun.query().where({ runId: r15.id, stepKey: 'qa' }).patch({ status: 'success', output: { decision: 'approved' } })
    await Path.query().where({ runId: r15.id, stepKey: 'qa' }).patch({ status: 'running' })
    await Run.query().findById(r15.id).patch({ status: 'running', lockedUntil: new Date(Date.now() - 60000).toISOString() })
    await engine.recovery.sweep()
    check('the sweeper moves QA\'s path on to the meeting point, and the case waits for production',
      (await runOf(r15.id)).status === 'waiting' && (await Arrival.query().where({ runId: r15.id })).length === 1)
    await answer(r15.id, 'production', { decision: 'approved' })
    check('...which then completes it', (await runOf(r15.id)).status === 'success')

    console.log('\na workflow with no new settings behaves as before')
    const plain = await workflow('Plain', [note('one', 'one'), note('two', 'two')])
    seen = []
    const r16 = await engine.runner.startRun(plain.id, {})
    check('one path, steps in order, done', (await runOf(r16.id)).status === 'success' && seen.join() === 'one,two' &&
      (await Path.query().where({ runId: r16.id })).length === 1 && (await Split.query().where({ runId: r16.id })).length === 0)
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

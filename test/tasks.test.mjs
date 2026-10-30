// People and their tasks, through the real engine on a real Postgres: an
// approval opens a task per approver and goes on when its rule is met; the
// inbox shows each person what is theirs; a task is taken, put back,
// answered, reassigned, escalated when overdue; four eyes are kept; who
// answered is recorded; an admin cancels a case or runs an interrupted step
// again.
//
// Needs WORKFLOW_TEST_PG = '{"host":"localhost","port":5432,"user":"…","password":"…"}'.
// In India's timezone on purpose: a plain timestamp read back on a non-UTC
// server moves by the offset, and CI runs in UTC, where that never shows.
process.env.TZ = 'Asia/Kolkata'
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
const refusal = (p) => p.then(() => null, (e) => e)

const STAMP = Date.now()
const WF_DB = 'xeplr_wf_tasks_test_' + STAMP
const MT = { mtId1: 'c' + (STAMP % 100000), mtId2: 'w' + (STAMP % 100000) }

registerApplication('xeplr-workflow-test')
let seen = []
const told = []
actions.register({ name: 'tk-note', inputSchema: [{ name: 'note', type: 'string' }], execute: async (ctx) => { seen.push(ctx.input.note); return {} } })

await engine.startEngine({
  db: {
    name: WF_DB, connection: PG, connectionName: 'workflow_tasks_test',
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } }
  },
  schedule: false, recover: false,
  onTask: (event, task) => { told.push({ event, taskId: task.id, role: task.assigneeRole }) }
})
const Workflow = engine.db.model('Workflow')
const Step = engine.db.model('WorkflowStep')
const Run = engine.db.model('WorkflowRun')
const StepRun = engine.db.model('WorkflowStepRun')
const Task = engine.db.model('WorkflowTask')
const Path = engine.db.model('WorkflowRunPath')
const tasks = engine.tasks

const REQUESTER = { id: 'u_ravi', roles: ['QA Head'] }
const MEERA = { id: 'u_meera', roles: ['QA Head'] }
const MEERA2 = { id: 'u_mira', roles: ['QA Head'] }
const NEIL = { id: 'u_neil', roles: ['Production Head'] }
const BOTH = { id: 'u_both', roles: ['QA Head', 'Production Head'] }
const PLANT = { id: 'u_plant', roles: ['Plant Head'] }
const ACCOUNTS = { id: 'u_acc', roles: ['Accounts'] }
const ADMIN = { id: 'u_admin', roles: ['Super Admin'] }
const NOBODY = { id: 'u_nobody', roles: ['Viewer'] }

async function workflow(name, steps) {
  const w = await Workflow.query().insert({ id: generateId(), name, kind: 'workflow', status: 'published' })
  for (let i = 0; i < steps.length; i++) {
    await Step.query().insert({ id: generateId(), workflowId: w.id, kind: 'auto', onError: 'stop', position: i, values: {}, ...steps[i] })
  }
  return w
}
const runOf = (id) => Run.query().findById(id)
const to = (target, when) => ({ when: when || null, mode: 'single', target })
const note = (stepKey, text, extra) => ({ stepKey, name: stepKey, actionName: 'tk-note', values: { note: text }, ...extra })
const approve = (stepKey, values, extra) => ({
  stepKey, name: stepKey, actionName: 'approval', kind: 'wait', values,
  transitions: [to('accepted', { field: 'output.decision', op: '=', value: 'approved' }), to('returned')], ...extra
})
const OUTCOMES = [note('accepted', 'accepted', { transitions: [to('end_success')] }), note('returned', 'returned', { transitions: [to('end_success')] })]
const start = (wf, user) => engine.runner.startRun(wf.id, {}, { user: user || REQUESTER })
const taskFor = async (runId, user) => (await Task.query().where({ runId }).whereIn('status', ['open', 'claimed'])).find((t) => engine.tasks.isFor(t, user))

try {
  await runWithMt(MT, async () => {
    console.log('an approval by two roles, together')
    const signOff = await workflow('Deviation sign-off', [
      approve('sign', { approvers: 'QA Head, Production Head', title: 'Deviation on PO 450103 / 10' }), ...OUTCOMES
    ])
    seen = []
    const r1 = await start(signOff)
    const open1 = await Task.query().where({ runId: r1.id })
    check('two tasks open, one per role', open1.length === 2 && open1.every((t) => t.status === 'open') &&
      open1.map((t) => t.assigneeRole).sort().join() === 'Production Head,QA Head', open1)
    check('...and the host was told of both', told.filter((t) => t.event === 'created' && open1.some((o) => o.id === t.taskId)).length === 2)
    const inboxMeera = await tasks.listMine(MEERA)
    check('...with the period its case is for (none, started by hand)', inboxMeera.tasks[0].period === null)
    const since = Date.now() - new Date(inboxMeera.tasks[0].since).getTime()
    check('...and when it opened, as an instant: moments ago, whatever the server\'s timezone', since >= 0 && since < 60000, inboxMeera.tasks[0].since)
    check('Meera\'s inbox has hers, titled, with Approve and Reject',
      inboxMeera.total === 1 && inboxMeera.tasks[0].title === 'Deviation on PO 450103 / 10' && inboxMeera.tasks[0].buttons.map((b) => b.key).join() === 'approved,rejected', inboxMeera)
    check('a Viewer\'s inbox is empty', (await tasks.listMine(NOBODY)).total === 0)
    check('a Super Admin sees both', (await tasks.listMine(ADMIN)).total === 2)

    await tasks.answer(inboxMeera.tasks[0].id, { decision: 'approved' }, MEERA)
    check('one approval: still waiting for production', (await runOf(r1.id)).status === 'waiting' && !seen.length)
    const neilTask = await taskFor(r1.id, NEIL)
    await tasks.answer(neilTask.id, { decision: 'approved', comment: 'fine' }, NEIL)
    const signRun = await StepRun.query().where({ runId: r1.id, stepKey: 'sign' }).first()
    check('both: the case is accepted', (await runOf(r1.id)).status === 'success' && seen.join() === 'accepted', seen)
    check('...the step says approved, 2, with who and when',
      signRun.output.decision === 'approved' && signRun.output.approved === 2 && signRun.output.answers.map((a) => a.by).sort().join() === 'u_meera,u_neil', signRun.output)
    check('...and records who decided it', signRun.actorUserId === 'u_neil', signRun.actorUserId)

    console.log('\na reject')
    seen = []
    const r2 = await start(signOff)
    const meeraTask = await taskFor(r2.id, MEERA)
    const noReason = await refusal(tasks.answer(meeraTask.id, { decision: 'rejected' }, MEERA))
    check('needs a reason', noReason && noReason.code === 'REASON_REQUIRED', noReason && noReason.message)
    await tasks.answer(meeraTask.id, { decision: 'rejected', comment: 'cracks in two bricks' }, MEERA)
    check('the first reject decides it: returned', (await runOf(r2.id)).status === 'success' && seen.join() === 'returned', seen)
    const withdrawn = await Task.query().where({ runId: r2.id, assigneeRole: 'Production Head' }).first()
    check('...production\'s task is withdrawn', withdrawn.status === 'withdrawn')
    const tooLate = await refusal(tasks.answer(withdrawn.id, { decision: 'approved' }, NEIL))
    check('...and answering it says so', tooLate && tooLate.code === 'TASK_CLOSED', tooLate && tooLate.message)
    check('...out of every inbox', (await tasks.listMine(NEIL)).total === 0)

    console.log('\nfour eyes')
    const r3 = await start(signOff, REQUESTER)
    const own = await refusal(tasks.answer((await taskFor(r3.id, REQUESTER)).id, { decision: 'approved' }, REQUESTER))
    check('the person who started the case cannot approve it', own && own.code === 'NOT_SAME_PERSON', own && own.message)
    await tasks.answer((await taskFor(r3.id, BOTH)).id, { decision: 'approved' }, BOTH)
    const twice = await refusal(tasks.answer((await Task.query().where({ runId: r3.id, status: 'open' }).first()).id, { decision: 'approved' }, BOTH))
    check('someone holding both roles answers only once', twice && twice.code === 'ALREADY_ANSWERED', twice && twice.message)
    const inspected = await workflow('Inspected', [
      { stepKey: 'inspect', name: 'Inspect', actionName: 'screen-show', kind: 'wait', values: { screen: 'inspection', assignTo: 'QA Head' }, transitions: [to('sign')] },
      approve('sign', { approvers: 'QA Head', notSame: 'inspect' }), ...OUTCOMES
    ])
    const r4 = await start(inspected, NOBODY)
    await tasks.answer((await taskFor(r4.id, MEERA)).id, { values: { ok: true } }, MEERA)
    const sameEyes = await refusal(tasks.answer((await taskFor(r4.id, MEERA)).id, { decision: 'approved' }, MEERA))
    check('who did the inspection cannot approve it (notSame)', sameEyes && sameEyes.code === 'NOT_SAME_PERSON', sameEyes && sameEyes.message)
    await tasks.answer((await taskFor(r4.id, MEERA2)).id, { decision: 'approved' }, MEERA2)
    check('...another QA Head can', (await runOf(r4.id)).status === 'success')

    console.log('\nby email: a role and a person, never an id')
    const byEmail = await workflow('By email', [approve('sign', { approvers: 'QA Head, Asha@Acme.com' }), ...OUTCOMES])
    const re = await start(byEmail)
    const openE = await Task.query().where({ runId: re.id })
    check('one task for the role, one for the email, stored lower-case',
      openE.length === 2 && openE.some((t) => t.assigneeRole === 'QA Head') && openE.some((t) => t.assigneeEmail === 'asha@acme.com' && !t.assigneeUserId && !t.assigneeRole), openE)
    const ASHA = { id: 'u_asha_e', email: 'ASHA@acme.com', roles: ['Viewer'] }
    const ashaInbox = await tasks.listMine(ASHA)
    check('the person with that email has it in their inbox (any case), and only it', ashaInbox.total === 1 && ashaInbox.tasks[0].assigneeEmail === 'asha@acme.com', ashaInbox)
    check('a QA Head does not get the email\'s task', (await tasks.listMine(MEERA)).tasks.filter((t) => t.runId === re.id).length === 1)
    const emailTask = openE.find((t) => t.assigneeEmail)
    const notHers = await refusal(tasks.answer(emailTask.id, { decision: 'approved' }, MEERA))
    check('...nor may answer it, told whose it is', notHers && notHers.code === 'NOT_YOURS' && /asha@acme\.com/.test(notHers.message), notHers && notHers.message)
    await tasks.answer(emailTask.id, { decision: 'approved' }, ASHA)
    await tasks.answer(openE.find((t) => t.assigneeRole).id, { decision: 'approved' }, MEERA)
    check('both approve: the step goes on', (await runOf(re.id)).status === 'success')

    console.log('\nany one, at least N, in turn')
    const anyOne = await workflow('Any one', [approve('sign', { approvers: 'user:u_asha, user:u_ben, user:u_chen', need: 'any' }), ...OUTCOMES])
    const r5 = await start(anyOne)
    await tasks.answer((await Task.query().where({ runId: r5.id, assigneeUserId: 'u_ben' }).first()).id, { decision: 'approved' }, { id: 'u_ben', roles: [] })
    check('any one: the first approval decides, the others are withdrawn',
      (await runOf(r5.id)).status === 'success' && (await Task.query().where({ runId: r5.id, status: 'withdrawn' })).length === 2)
    const notMine = await refusal(tasks.answer((await Task.query().where({ runId: r5.id, assigneeUserId: 'u_asha' }).first()).id, { decision: 'approved' }, { id: 'u_ben', roles: [] }))
    check('...a task for a named person is not someone else\'s', notMine && notMine.code === 'NOT_YOURS', notMine && notMine.code)
    const twoOf = await workflow('Two of three', [approve('sign', { approvers: 'user:u_a, user:u_b, user:u_c', need: '2' }), ...OUTCOMES])
    seen = []
    const r6 = await start(twoOf)
    const by = async (u, d) => tasks.answer((await Task.query().where({ runId: r6.id, assigneeUserId: u }).first()).id, { decision: d, comment: 'x' }, { id: u, roles: [] })
    await by('u_a', 'approved')
    check('at least 2: one is not enough', (await runOf(r6.id)).status === 'waiting')
    await by('u_c', 'approved')
    check('...two are', (await runOf(r6.id)).status === 'success' && seen.join() === 'accepted', seen)
    const tooMany = await workflow('Too many', [approve('sign', { approvers: 'QA Head, Production Head', need: '3' }), ...OUTCOMES])
    const r7 = await start(tooMany)
    check('needing more approvals than people asked fails the step, saying so', (await runOf(r7.id)).status === 'failed' && /needs 3 approvals but only 2/.test((await runOf(r7.id)).error.message), (await runOf(r7.id)).error)

    const inTurn = await workflow('In turn', [approve('sign', { approvers: 'QA Head, Production Head', order: 'inTurn' }), ...OUTCOMES])
    const r8 = await start(inTurn)
    check('in turn: production\'s task waits, out of the inbox', !(await tasks.listMine(NEIL)).tasks.some((t) => t.runId === r8.id) &&
      (await Task.query().where({ runId: r8.id, assigneeRole: 'Production Head' }).first()).status === 'queued')
    await tasks.answer((await taskFor(r8.id, MEERA)).id, { decision: 'approved' }, MEERA)
    check('...and opens once QA approves', (await tasks.listMine(NEIL)).tasks.some((t) => t.runId === r8.id))
    await tasks.answer((await taskFor(r8.id, NEIL)).id, { decision: 'approved' }, NEIL)
    check('...then the case goes on', (await runOf(r8.id)).status === 'success')

    console.log('\ntaking a task')
    const r9 = await start(signOff)
    const qa = await taskFor(r9.id, MEERA)
    await tasks.claim(qa.id, MEERA)
    check('taken: it says who has it', (await Task.query().findById(qa.id)).claimedBy === 'u_meera')
    const stolen = await refusal(tasks.claim(qa.id, MEERA2))
    check('...another QA Head cannot take it', stolen && stolen.code === 'TASK_CLAIMED', stolen && stolen.code)
    const answeredByOther = await refusal(tasks.answer(qa.id, { decision: 'approved' }, MEERA2))
    check('...or answer it', answeredByOther && answeredByOther.code === 'TASK_CLAIMED', answeredByOther && answeredByOther.code)
    check('...it stays in the taker\'s inbox, marked theirs', (await tasks.listMine(MEERA)).tasks.find((t) => t.id === qa.id).mine === true)
    await tasks.release(qa.id, MEERA)
    await tasks.claim(qa.id, MEERA2)
    await tasks.answer(qa.id, { decision: 'approved' }, MEERA2)
    check('put back, the other one takes and answers it', (await Task.query().findById(qa.id)).decidedBy === 'u_mira')

    console.log('\na screen is a task too')
    const screen = await workflow('Screen', [
      { stepKey: 'pay', name: 'Approve payment', actionName: 'screen-show', kind: 'wait', values: { screen: 'payment', assignTo: 'Accounts', buttons: 'Pay, Hold' }, transitions: [to('end_success')] }
    ])
    const r10 = await start(screen)
    const accInbox = await tasks.listMine(ACCOUNTS)
    const payTask = accInbox.tasks.find((t) => t.runId === r10.id)
    check('Accounts sees it, with the screen and its buttons', payTask && payTask.screen === 'payment' && payTask.buttons.map((b) => b.key).join() === 'Pay,Hold', payTask)
    const wrong = await refusal(tasks.answer(payTask.id, { values: {}, action: 'Pay' }, NEIL))
    check('someone without the role cannot answer it', wrong && wrong.code === 'NOT_YOURS', wrong && wrong.code)
    await tasks.answer(payTask.id, { values: { amount: 50000 }, action: 'Pay' }, ACCOUNTS)
    const payRun = await StepRun.query().where({ runId: r10.id, stepKey: 'pay' }).first()
    const payDone = await Task.query().findById(payTask.id)
    check('answered: the case goes on with what was submitted', (await runOf(r10.id)).status === 'success' && payRun.output.amount === 50000 && payRun.output.action === 'Pay')
    check('...the task done by them, the step recording them', payDone.status === 'done' && payDone.decidedBy === 'u_acc' && payDone.decision === 'Pay' && payRun.actorUserId === 'u_acc', { payDone, actor: payRun.actorUserId })
    const r11 = await start(screen)
    await engine.flows.submitRun(r11.id, { values: {}, action: 'Hold' }, { user: ACCOUNTS })
    check('submitted through the screens route, the task is done all the same', (await Task.query().where({ runId: r11.id }).first()).decidedBy === 'u_acc')

    console.log('\noverdue')
    const urgent = await workflow('Urgent', [approve('sign', { approvers: 'QA Head', dueInHours: 0.00001, escalateTo: 'Plant Head' }), ...OUTCOMES])
    const r12 = await start(urgent)
    await sleep(80)
    const swept = await engine.recovery.sweep()
    const late = await Task.query().where({ runId: r12.id }).first()
    check('past due, the host is told and the task moves to Plant Head',
      swept.due.some((d) => d.taskId === late.id && d.events.join() === 'due,escalated') && late.assigneeRole === 'Plant Head' && late.escalatedAt, { swept, late })
    check('...with why, in its history', late.history.length === 1 && late.history[0].what === 'escalated' && late.history[0].from === 'QA Head')
    check('...the host heard both', told.some((t) => t.taskId === late.id && t.event === 'due') && told.some((t) => t.taskId === late.id && t.event === 'escalated'))
    await tasks.answer(late.id, { decision: 'approved' }, PLANT)
    check('...and the Plant Head answers it', (await runOf(r12.id)).status === 'success')
    const again = await engine.recovery.sweep()
    check('told once, not every sweep', !again.due.some((d) => d.taskId === late.id))

    console.log('\nadmin')
    const r13 = await start(signOff)
    const qa13 = await taskFor(r13.id, MEERA)
    const noWhy = await refusal(tasks.reassign(qa13.id, { userId: 'u_chen' }, { actor: 'u_admin' }))
    check('reassigning needs a reason', noWhy && noWhy.code === 'REASON_REQUIRED')
    await tasks.reassign(qa13.id, { userId: 'u_chen' }, { actor: 'u_admin', reason: 'Meera on leave' })
    const moved = await Task.query().findById(qa13.id)
    check('reassigned to Chen, with who and why', moved.assigneeUserId === 'u_chen' && moved.assigneeRole === null && moved.history[0].reason === 'Meera on leave' && moved.history[0].by === 'u_admin', moved)
    check('...Chen sees it, Meera does not', (await tasks.listMine({ id: 'u_chen', roles: [] })).total === 1 && !(await tasks.listMine(MEERA)).tasks.some((t) => t.id === qa13.id))
    const noCancelWhy = await refusal(engine.runner.cancelRun(r13.id, {}))
    check('cancelling needs a reason', noCancelWhy && noCancelWhy.code === 'REASON_REQUIRED')
    const cancelled = await engine.runner.cancelRun(r13.id, { reason: 'Raised twice', actor: 'u_admin' })
    check('cancelled: the case fails as CANCELLED, by whom and why', cancelled.status === 'failed' && cancelled.error.code === 'CANCELLED' && cancelled.error.by === 'u_admin' && /Raised twice/.test(cancelled.error.message))
    check('...and every task on it is withdrawn', (await Task.query().where({ runId: r13.id }).whereIn('status', ['open', 'claimed', 'queued'])).length === 0)
    const again13 = await refusal(engine.runner.cancelRun(r13.id, { reason: 'again' }))
    check('...a finished case cannot be cancelled', again13 && again13.code === 'RUN_FINISHED')

    // A case the sweeper stopped as INTERRUPTED, as recovery leaves it.
    const sending = await workflow('Send', [note('send', 'sent', { transitions: [to('end_success')] })])
    const sendSteps = await Step.query().where({ workflowId: sending.id })
    const versionId = await engine.versions.pinVersion(sending.id, sendSteps)
    const r14 = await Run.query().insert({ id: generateId(), workflowId: sending.id, versionId, status: 'failed', startedAt: new Date().toISOString(),
      error: { code: 'INTERRUPTED', message: 'The server stopped while step "send" was running.' } })
    const p14 = await Path.query().insert({ id: generateId(), runId: r14.id, stepKey: 'send', status: 'failed', round: 0 })
    await StepRun.query().insert({ id: generateId(), runId: r14.id, pathId: p14.id, stepId: sendSteps[0].id, stepKey: 'send', actionName: 'tk-note', status: 'interrupted', position: 0,
      error: { code: 'INTERRUPTED', message: 'The server stopped while this step was running.' } })
    seen = []
    const notThis = await refusal(engine.runner.retryRun(r2.id, { reason: 'try' }))
    check('only an interrupted case can be run again from its step', notThis && notThis.code === 'NOT_INTERRUPTED')
    const retried = await engine.runner.retryRun(r14.id, { reason: 'Checked: the file was not sent', actor: 'u_admin' })
    const firstTry = await StepRun.query().where({ runId: r14.id, status: 'interrupted' }).first()
    check('run again once checked: the step runs and the case finishes', retried.status === 'success' && seen.join() === 'sent', { retried, seen })
    check('...the interrupted attempt says who ran it again and why', firstTry.error.retriedBy === 'u_admin' && firstTry.error.retryReason === 'Checked: the file was not sent')

    console.log('\napprovals on parallel paths')
    const parallel = await workflow('Parallel approvals', [
      note('raise', 'raised', { leave: 'every', transitions: [to('qa'), to('prod')] }),
      { stepKey: 'qa', name: 'QA', actionName: 'approval', kind: 'wait', values: { approvers: 'QA Head' }, transitions: [to('meet')] },
      { stepKey: 'prod', name: 'Production', actionName: 'approval', kind: 'wait', values: { approvers: 'Production Head' }, transitions: [to('meet')] },
      note('meet', 'met: {arrivals.rejected} rejected', { join: { wait: 'all', stopWhen: { field: 'arrivals.rejected', op: '>=', value: 1 } } })
    ])
    seen = []
    const r15 = await start(parallel)
    await tasks.answer((await taskFor(r15.id, NEIL)).id, { decision: 'rejected', comment: 'no' }, NEIL)
    check('an approval\'s decision is what the path brings to the meeting point', seen.includes('met: 1 rejected') && (await runOf(r15.id)).status === 'success', seen)
    check('...and the other approval\'s task is withdrawn with its path', (await Task.query().where({ runId: r15.id, assigneeRole: 'QA Head' }).first()).status === 'withdrawn')

    console.log('\na wait that expires withdraws its tasks')
    const expiring = await workflow('Expiring', [approve('sign', { approvers: 'QA Head' }, { timeoutMs: 50 }), ...OUTCOMES])
    const r16 = await start(expiring)
    await sleep(120)
    await engine.recovery.sweep()
    check('timed out: the case stops, and the task is withdrawn', (await runOf(r16.id)).error.code === 'TIMED_OUT' &&
      (await Task.query().where({ runId: r16.id }).first()).status === 'withdrawn')

    console.log('\nthe inbox pages')
    for (let i = 0; i < 3; i++) await start(signOff)
    const page1 = await tasks.listMine(ADMIN, { limit: 2, offset: 0 })
    const page2 = await tasks.listMine(ADMIN, { limit: 2, offset: 2 })
    check('a page at a time, the total across them', page1.tasks.length === 2 && page2.tasks.length === 2 && page1.total === page2.total &&
      !page1.tasks.some((a) => page2.tasks.some((b) => b.id === a.id)), { t1: page1.total, t2: page2.total })
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

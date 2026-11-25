// Reminders & escalation on a task, through the real engine on a real
// Postgres: a task step's `reminders` become its plan when it opens; the sweep
// sends each reminder once (two processes at the same instant included), says
// so in the task's history and on the step's log; an answered task is never
// reminded again; an escalation either shares the task (the first person
// keeps it) or hands it over; an approver waiting their turn gets their own
// plan when their turn comes; a screen's task is reminded too.
//
// Needs WORKFLOW_TEST_PG = '{"host":"localhost","port":5432,"user":"…","password":"…"}'.
process.env.TZ = 'Asia/Kolkata'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
const WF_DB = 'xeplr_wf_reminders_test_' + STAMP
const MT = { mtId1: 'c' + (STAMP % 100000), mtId2: 'w' + (STAMP % 100000) }
const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'reminders.child.mjs')

registerApplication('xeplr-workflow-test')
const told = []
actions.register({ name: 'rm-note', inputSchema: [{ name: 'note', type: 'string' }], execute: async () => ({}) })

await engine.startEngine({
  db: {
    name: WF_DB, connection: PG, connectionName: 'workflow_reminders_test',
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } }
  },
  onTask: (event, task, info) => { told.push({ event, taskId: task.id, info }) }
})
const Workflow = engine.db.model('Workflow')
const Step = engine.db.model('WorkflowStep')
const Run = engine.db.model('WorkflowRun')
const StepRun = engine.db.model('WorkflowStepRun')
const Task = engine.db.model('WorkflowTask')
const tasks = engine.tasks

const RAVI = { id: 'u_ravi', email: 'ravi@acme.com', roles: ['QA Head'] }
const PRIYA = { id: 'u_priya', email: 'priya@acme.com', roles: ['Viewer'] }
const PLANT = { id: 'u_plant', roles: ['Plant Head'] }
const STARTER = { id: 'u_starter', roles: ['Viewer'] }

const HOUR = 3600000
async function workflow(name, steps) {
  const w = await Workflow.query().insert({ id: generateId(), name, kind: 'workflow', status: 'published' })
  for (let i = 0; i < steps.length; i++) {
    await Step.query().insert({ id: generateId(), workflowId: w.id, kind: 'auto', onError: 'stop', position: i, values: {}, ...steps[i] })
  }
  return w
}
const to = (target, when) => ({ when: when || null, mode: 'single', target })
const note = (stepKey) => ({ stepKey, name: stepKey, actionName: 'rm-note', values: { note: stepKey }, transitions: [to('end_success')] })
const approve = (values) => ({
  stepKey: 'sign', name: 'Approve production plan', actionName: 'approval', kind: 'wait', values,
  transitions: [to('done', { field: 'output.decision', op: '=', value: 'approved' }), to('done')]
})
const start = (wf) => engine.runner.startRun(wf.id, {}, { user: STARTER })
const taskOf = async (runId) => Task.query().where({ runId }).orderBy('position').first()
const at = (ms) => new Date(Date.now() + ms)
const REMINDERS = {
  remind: [{ after: 8, unit: 'hours', by: ['email', 'app'] }, { after: 16, unit: 'hours', by: ['email', 'app', 'phone'] }],
  escalate: { after: 1, unit: 'days', to: { kind: 'role', value: 'Plant Head' }, keep: true }
}

function child(now, startAt) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CHILD], {
      env: { ...process.env, WT_PG: JSON.stringify(PG), WT_DB: WF_DB, WT_NOW: String(now), WT_AT: String(startAt) },
      stdio: ['ignore', 'pipe', 'inherit']
    })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.on('exit', (code) => code === 0 ? resolve(JSON.parse(out.slice(out.indexOf('NUDGED ') + 7))) : reject(new Error('child exited ' + code + ': ' + out)))
  })
}

try {
  await runWithMt(MT, async () => {
    console.log('the plan, made when the task opens')
    const plan = tasks.planNudges(REMINDERS, Date.parse('2026-11-25T00:00:00Z'))
    check('two reminders at 8 h and 16 h, an escalation at 1 day',
      plan.nudges.remind.map((r) => r.at).join() === '2026-11-25T08:00:00.000Z,2026-11-25T16:00:00.000Z' &&
      plan.nudges.escalate.at === '2026-11-26T00:00:00.000Z' && plan.nextNudgeAt === '2026-11-25T08:00:00.000Z', plan)
    check('no reminders asked: no plan', tasks.planNudges(null, 0) === null && tasks.planNudges({ remind: [] }, 0) === null)
    check('a row without a number is left out, not guessed', tasks.planNudges({ remind: [{ after: '', unit: 'hours' }] }, 0) === null)

    const wf = await workflow('Production plan', [approve({ approvers: 'QA Head', title: 'Approve production plan', reminders: REMINDERS }), note('done')])
    const r1 = await start(wf)
    const t1 = await taskOf(r1.id)
    check('the open task carries its plan', t1.nudges && t1.nudges.remind.length === 2 && t1.nextNudgeAt, t1.nudges)

    console.log('\na reminder, sent once')
    told.length = 0
    const notYet = await tasks.sweepNudges(at(HOUR))
    check('an hour in: nothing is due', notYet.length === 0 && told.length === 0)
    const sent = await tasks.sweepNudges(at(9 * HOUR))
    await sleep(50)
    const t1b = await Task.query().findById(t1.id)
    check('at 9 h the first reminder goes, by email and the app', sent.length === 1 && sent[0].reminded &&
      told.length === 1 && told[0].event === 'reminder' && told[0].info.by.join() === 'email,app' && told[0].info.waited === '8 hours', { sent, told })
    check('...written in the task\'s history', t1b.history.some((h) => h.what === 'reminded' && h.waited === '8 hours'), t1b.history)
    const sr = await StepRun.query().where({ runId: r1.id, stepKey: 'sign' }).first()
    check('...and on the step\'s log, in words', (sr.log || []).some((l) => /Reminded QA Head \(email, app\): waiting 8 hours/.test(l.message)), sr.log)
    check('...and the next one is due at 16 h', t1b.nextNudgeAt && new Date(t1b.nextNudgeAt).toISOString() === t1b.nudges.remind[1].at)
    told.length = 0
    await tasks.sweepNudges(at(9 * HOUR))
    check('the same pass again sends nothing', told.length === 0)

    console.log('\ntwo processes at the same instant')
    const startAt = Date.now() + 1500
    const [a, b] = await Promise.all([child(at(17 * HOUR).getTime(), startAt), child(at(17 * HOUR).getTime(), startAt)])
    const sends = a.told.concat(b.told).filter((t) => t.taskId === t1.id && t.event === 'reminder')
    check('the 16 h reminder is sent once, by one of them', sends.length === 1 && sends[0].info.by.join() === 'email,app,phone', { a, b })

    console.log('\nescalation that keeps it with the first person')
    told.length = 0
    await tasks.sweepNudges(at(25 * HOUR))
    await sleep(50)
    const t1c = await Task.query().findById(t1.id)
    check('after a day it is also given to Plant Head', told.some((t) => t.event === 'escalated' && t.info.to === 'Plant Head' && t.info.keep === true && t.info.from === 'QA Head') &&
      t1c.assigneeRole === 'QA Head' && (t1c.alsoFor || []).some((x) => x.role === 'Plant Head'), { told, t1c })
    check('...both inboxes show it', (await tasks.listMine(RAVI)).tasks.some((t) => t.id === t1.id) && (await tasks.listMine(PLANT)).tasks.some((t) => t.id === t1.id))
    check('...nothing left to send', t1c.nextNudgeAt === null)
    await tasks.answer(t1.id, { decision: 'approved' }, PLANT)
    const done1 = await Run.query().findById(r1.id)
    check('...and the Plant Head can answer it', done1.status === 'success')

    console.log('\na run\'s times are instants (0028), on a server in India')
    const startedAgo = Date.now() - new Date(done1.startedAt).getTime()
    check('it started moments ago, not 5½ hours ago', startedAgo >= 0 && startedAgo < 5 * 60000, { startedAt: done1.startedAt, startedAgo })
    check('...and took seconds, not "5 h 31 min"', done1.durationMs >= 0 && done1.durationMs < 5 * 60000 &&
      new Date(done1.finishedAt).getTime() - new Date(done1.startedAt).getTime() === done1.durationMs, { durationMs: done1.durationMs, startedAt: done1.startedAt, finishedAt: done1.finishedAt })

    console.log('\nan answered task is never reminded')
    const r2 = await start(wf)
    const t2 = await taskOf(r2.id)
    await tasks.answer(t2.id, { decision: 'approved' }, RAVI)
    told.length = 0
    await tasks.sweepNudges(at(48 * HOUR))
    check('two days later: nothing for it', !told.some((t) => t.taskId === t2.id))

    console.log('\nescalation that takes it away, to a person')
    const away = await workflow('Away', [approve({ approvers: 'QA Head', reminders: { escalate: { after: 2, unit: 'hours', to: { kind: 'person', value: 'Priya@Acme.com' }, keep: false } } }), note('done')])
    const r3 = await start(away)
    const t3 = await taskOf(r3.id)
    await tasks.claim(t3.id, RAVI)
    await tasks.sweepNudges(at(3 * HOUR))
    const t3b = await Task.query().findById(t3.id)
    check('it is Priya\'s now, open again, no longer Ravi\'s', t3b.assigneeEmail === 'priya@acme.com' && !t3b.assigneeRole && t3b.status === 'open' && !t3b.claimedBy, t3b)
    check('...gone from Ravi\'s inbox, in Priya\'s', !(await tasks.listMine(RAVI)).tasks.some((t) => t.id === t3.id) && (await tasks.listMine(PRIYA)).tasks.some((t) => t.id === t3.id))
    check('...why, in its history', t3b.history.some((h) => h.what === 'escalated' && h.keep === false && /2 hours/.test(h.reason) && h.to === 'priya@acme.com'), t3b.history)

    console.log('\nsomeone from an earlier step')
    const fromData = await workflow('From data', [approve({ approvers: 'QA Head', reminders: { escalate: { after: 1, unit: 'hours', to: { kind: 'value', value: '{params.supervisor}' }, keep: false } } }), note('done')])
    const r4 = await engine.runner.startRun(fromData.id, { supervisor: 'line.lead@acme.com' }, { user: STARTER })
    const t4 = await taskOf(r4.id)
    check('the value is resolved when the task opens', t4.nudges.escalate.to.value === 'line.lead@acme.com', t4.nudges)
    await tasks.sweepNudges(at(2 * HOUR))
    check('...and the task goes to that address', (await Task.query().findById(t4.id)).assigneeEmail === 'line.lead@acme.com')

    console.log('\nin turn: the next approver gets their own plan')
    const inTurn = await workflow('In turn', [approve({ approvers: 'QA Head, Plant Head', order: 'inTurn', reminders: { remind: [{ after: 1, unit: 'hours', by: ['app'] }] } }), note('done')])
    const r5 = await start(inTurn)
    const [first, second] = await Task.query().where({ runId: r5.id }).orderBy('position')
    check('the one waiting their turn has no plan yet', first.nudges && !second.nudges && second.status === 'queued')
    await tasks.answer(first.id, { decision: 'approved' }, RAVI)
    const second2 = await Task.query().findById(second.id)
    check('...when their turn comes, it starts from then', second2.status === 'open' && second2.nudges && second2.nudges.remind.length === 1)

    console.log('\na screen\'s task is reminded too')
    const form = await workflow('Form', [
      { stepKey: 'fill', name: 'Record shift output', actionName: 'screen-show', kind: 'wait', values: { screen: 'shift', assignTo: 'QA Head', reminders: { remind: [{ after: 30, unit: 'minutes', by: ['email'] }] } }, transitions: [to('done')] },
      note('done')
    ])
    const r6 = await start(form)
    const t6 = await taskOf(r6.id)
    told.length = 0
    await tasks.sweepNudges(at(HOUR))
    await sleep(50)
    check('a form task gets its reminder', told.some((t) => t.taskId === t6.id && t.event === 'reminder' && t.info.waited === '30 minutes'), told)
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

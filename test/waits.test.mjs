// The Wait step and the watch triggers, through the real engine on a real
// Postgres, with real files in the tenant's own folder:
//   * wait some time: parked until then, woken once it has passed
//   * wait until a date: one past wakes it, one ahead does not
//   * something arrives: a file in time takes the normal arrow with the file;
//     nothing in time takes "Took too long"; its late "too long" never fires
//   * a wait outlives its process: another process wakes it
//   * two processes waking at the same moment wake it once
//   * a step saved as `auto` with the wait action still parks
//   * "a file arrives" trigger: what was there before is not started; each
//     new file starts one run with {trigger.file}; a second look starts none
//
// Needs WORKFLOW_TEST_PG = '{"host":"localhost","port":5432,"user":"…","password":"…"}'.
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)

const PG = process.env.WORKFLOW_TEST_PG ? JSON.parse(process.env.WORKFLOW_TEST_PG) : null
if (!PG) {
  console.log('  skipped — set WORKFLOW_TEST_PG to run against Postgres')
  process.exit(0)
}

const { registerApplication, runWithMt, dataDir } = require('@xeplr/db')
const { generateId } = require('@xeplr/utils/lib/helpers')
const engine = require('../index.js')

const results = []
const check = (n, c, extra) => { results.push(c); console.log((c ? '  ok   ' : '  FAIL ') + n + (c || extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 700))) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const STAMP = Date.now()
const WF_DB = 'xeplr_wf_waits_test_' + STAMP
const MT = { mtId1: 'c' + (STAMP % 100000), mtId2: 'w' + (STAMP % 100000) }
const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'waits.child.mjs')

registerApplication('xeplr-workflow-test')
await engine.startEngine({
  db: {
    name: WF_DB, connection: PG, connectionName: 'workflow_waits_test',
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } }
  }
})
const Workflow = engine.db.model('Workflow')
const Step = engine.db.model('WorkflowStep')
const Run = engine.db.model('WorkflowRun')
const StepRun = engine.db.model('WorkflowStepRun')
const Key = engine.db.model('WorkflowResumeKey')

async function workflow(name, steps, extra) {
  const w = await Workflow.query().insert({ id: generateId(), name, kind: 'workflow', status: 'published', ...(extra || {}) })
  for (let i = 0; i < steps.length; i++) {
    await Step.query().insert({ id: generateId(), workflowId: w.id, kind: 'auto', onError: 'stop', position: i, values: {}, ...steps[i] })
  }
  return w
}
const runOf = (id) => Run.query().findById(id)
const ran = async (runId, stepKey) => StepRun.query().where({ runId, stepKey }).resultSize()
const stepOut = async (runId, stepKey) => (await StepRun.query().where({ runId, stepKey }).first())?.output
const to = (target) => ({ condition: null, mode: 'single', target })
const tooLongArrows = (late, onTime) => [
  { when: { field: 'output.tooLong', op: '=', value: true }, mode: 'single', target: late },
  { when: null, mode: 'single', target: onTime }
]
// Fractions of a minute: the unit a person picks is minutes, hours or days.
const seconds = (s) => s / 60

function child(at) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CHILD], {
      env: { ...process.env, WT_PG: JSON.stringify(PG), WT_DB: WF_DB, WT_AT: String(at || 0) },
      stdio: ['ignore', 'pipe', 'inherit']
    })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.on('exit', (code) => code === 0 ? resolve(out) : reject(new Error('child exited ' + code + ': ' + out)))
  })
}

try {
  await runWithMt(MT, async () => {
    const inbox = path.join(dataDir.tenantFolder(), 'inbox')
    mkdirSync(inbox, { recursive: true })

    console.log('wait some time')
    const timed = await workflow('Wait a moment', [
      { stepKey: 'pause', name: 'Wait', actionName: 'wait', values: { until: 'time', amount: seconds(2), unit: 'minutes' }, transitions: [to('after')] },
      { stepKey: 'after', name: 'After', actionName: 'decide', transitions: [to('end_success')] }
    ])
    const s1 = await Step.query().where({ workflowId: timed.id, stepKey: 'pause' }).first()
    check('a Wait step saved as auto is a wait step', s1.kind === 'wait', s1)
    const r1 = await engine.runner.startRun(timed.id, {})
    check('the run parks on the wait', (await runOf(r1.id)).status === 'waiting', await runOf(r1.id))
    const k1 = await Key.query().where({ runId: r1.id }).first()
    check('...with when it wakes on its key', k1.wakeAt && Math.abs(new Date(k1.wakeAt) - Date.now() - 2000) < 1500, k1)
    await engine.waits.wakeDue()
    check('before the time, it is not woken', (await runOf(r1.id)).status === 'waiting' && (await ran(r1.id, 'after')) === 0)
    await sleep(2200)
    await engine.waits.wakeDue()
    check('after it, the run goes on and finishes', (await runOf(r1.id)).status === 'success' && (await ran(r1.id, 'after')) === 1, await runOf(r1.id))
    check('...the step says it waited', (await stepOut(r1.id, 'pause')).waited === true, await stepOut(r1.id, 'pause'))

    console.log('\nwait until a date')
    const dated = await workflow('Until the date', [
      { stepKey: 'pause', name: 'Wait', actionName: 'wait', values: { until: 'date', date: '{params.when}' }, transitions: [to('after')] },
      { stepKey: 'after', name: 'After', actionName: 'decide', transitions: [to('end_success')] }
    ])
    const past = await engine.runner.startRun(dated.id, { when: new Date(Date.now() - 60000).toISOString() })
    const ahead = await engine.runner.startRun(dated.id, { when: '2099-01-01' })
    await engine.waits.wakeDue()
    check('a date already past wakes at the next pass', (await runOf(past.id)).status === 'success')
    check('a date ahead stays waiting', (await runOf(ahead.id)).status === 'waiting')
    const kAhead = await Key.query().where({ runId: ahead.id }).first()
    check('...a bare day is midnight that day', new Date(kAhead.wakeAt).getTime() === new Date(2099, 0, 1).getTime(), kAhead.wakeAt)
    let bad = null
    try { await engine.runner.startRun(dated.id, { when: 'next tuesday-ish' }) } catch (e) { bad = e }
    const badRun = (await Run.query().where({ workflowId: dated.id }).orderBy('startedAt', 'desc'))[0]
    check('a date it cannot read fails the step, saying so', bad || (badRun.status === 'failed' && /not a date/.test(JSON.stringify(badRun.error))), badRun)

    console.log('\nsomething arrives — or takes too long')
    const watching = await workflow('Wait for the quote', [
      { stepKey: 'quote', name: 'Wait for the quote', actionName: 'wait',
        values: { until: 'arrival', arrives: 'file', folder: 'inbox', named: 'quote-*.pdf', tooLongAmount: seconds(2), tooLongUnit: 'minutes', checkEveryMinutes: 1 },
        transitions: tooLongArrows('remind', 'got') },
      { stepKey: 'remind', name: 'Remind', actionName: 'decide', transitions: [to('end_success')] },
      { stepKey: 'got', name: 'Got it', actionName: 'decide', transitions: [to('end_success')] }
    ])
    const late = await engine.runner.startRun(watching.id, {})
    const onTime = await engine.runner.startRun(watching.id, {})
    await engine.waits.wakeDue()
    check('nothing there yet: both keep waiting', (await runOf(late.id)).status === 'waiting' && (await runOf(onTime.id)).status === 'waiting')
    // One run's next look is moved to now and the file put in place; the
    // other run's look stays a minute away, so only "too long" reaches it.
    writeFileSync(path.join(inbox, 'quote-acme.pdf'), 'PDF')
    await Key.query().where({ runId: onTime.id }).patch({ nextCheckAt: new Date(Date.now() - 1000).toISOString() })
    await engine.waits.wakeDue()
    const got = await stepOut(onTime.id, 'quote')
    check('the file in time: the normal arrow, with the file', (await ran(onTime.id, 'got')) === 1 && (await ran(onTime.id, 'remind')) === 0 &&
      got.arrived === true && got.tooLong === false && got.files[0].name === 'quote-acme.pdf', got)
    await sleep(2200)
    await engine.waits.wakeDue()
    check('nothing in time: "Took too long"', (await ran(late.id, 'remind')) === 1 && (await stepOut(late.id, 'quote')).tooLong === true, await stepOut(late.id, 'quote'))
    check('...and the run that got its file is not woken again', (await ran(onTime.id, 'remind')) === 0 && (await ran(onTime.id, 'got')) === 1)

    console.log('\na wait outlives its process, and wakes once')
    const outlive = await workflow('Outlive', [
      { stepKey: 'pause', name: 'Wait', actionName: 'wait', values: { until: 'time', amount: seconds(1), unit: 'minutes' }, transitions: [to('after')] },
      { stepKey: 'after', name: 'After', actionName: 'decide', transitions: [to('end_success')] }
    ])
    const r5 = await engine.runner.startRun(outlive.id, {})
    await sleep(1200)
    const at = Date.now() + 1500
    const outs = await Promise.all([child(at), child(at)])
    check('another process wakes it', (await runOf(r5.id)).status === 'success', outs)
    check('two processes at the same moment: the next step ran once', (await ran(r5.id, 'after')) === 1, outs)
  })

  console.log('\nstart when a file arrives')
  let wfId
  await runWithMt(MT, async () => {
    const drop = path.join(dataDir.tenantFolder(), 'drop')
    mkdirSync(drop, { recursive: true })
    writeFileSync(path.join(drop, 'old.csv'), 'a')
    const w = await workflow('Each file', [
      { stepKey: 'take', name: 'Take it', actionName: 'decide', transitions: [to('end_success')] }
    ], { trigger: { kind: 'file', folder: 'drop', named: '*.csv', checkEveryMinutes: 1 } })
    wfId = w.id
  })
  const t0 = new Date()
  await engine.triggers.checkWatches(t0)
  const runsOf = () => runWithMt(MT, () => Run.query().where({ workflowId: wfId }))
  check('the first look notes what is there and starts nothing', (await runsOf()).length === 0)
  await runWithMt(MT, async () => {
    const drop = path.join(dataDir.tenantFolder(), 'drop')
    writeFileSync(path.join(drop, 'sept.csv'), 'b')
    writeFileSync(path.join(drop, 'oct.csv'), 'c')
    writeFileSync(path.join(drop, 'notes.txt'), 'x')
  })
  await engine.triggers.checkWatches(new Date(t0.getTime() + 61000))
  const after = await runsOf()
  const names = after.map((r) => r.triggerData && r.triggerData.file && r.triggerData.file.name).sort()
  check('each new file starts one run, with {trigger.file}', after.length === 2 && names.join() === 'oct.csv,sept.csv', after.map((r) => r.triggerData))
  await engine.triggers.checkWatches(new Date(t0.getTime() + 122000))
  check('a second look starts none for the same files', (await runsOf()).length === 2)
  const desc = await runWithMt(MT, async () => engine.triggers.describe(await Workflow.query().findById(wfId)))
  check('...and the trigger says when it last looked', desc.on === true && desc.lastFiredAt, desc)
  let refused = null
  try { engine.triggers.validate({ kind: 'file' }) } catch (e) { refused = e }
  check('a file trigger with no folder is refused when saved', refused && refused.code === 'TRIGGER_INVALID', refused && refused.message)
  check('the designer is offered both watch kinds', ['file', 'email'].every((k) => engine.triggers.catalog().some((c) => c.kind === k)))
} catch (err) {
  check('no unexpected error', false, err && (err.stack || err.message))
} finally {
  try {
    await engine.db.conn().destroy()
    const admin = require('knex')({ client: 'pg', connection: Object.assign({}, PG, { database: 'postgres' }) })
    await admin.raw('DROP DATABASE IF EXISTS "' + WF_DB + '" WITH (FORCE)')
    await admin.destroy()
  } catch (e) { /* best effort */ }
  const failed = results.filter((r) => !r).length
  console.log('\n' + (results.length - failed) + '/' + results.length + ' passed')
  process.exit(failed ? 1 : 0)
}

// A step that keeps checking (workflow_steps.poll), through the real engine on
// a real Postgres: a run parks on it, each tick of its job runs it again, and
// every check that finds something starts a run of its own.
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
const WF_DB = 'xeplr_wf_poll_test_' + STAMP
const MT = { mtId1: 'c' + (STAMP % 100000), mtId2: 'w' + (STAMP % 100000) }

registerApplication('xeplr-workflow-test')

// The folder the step looks in: what a tick finds is whatever is put here.
let inbox = []
let looked = 0
let broken = false
actions.register({ name: 'look', inputSchema: [{ name: 'folder', type: 'string' }],
  execute: async (ctx) => {
    looked++
    if (broken) throw new Error('The folder is not reachable')
    return { folder: ctx.input.folder, files: inbox.slice(), count: inbox.length }
  } })
actions.register({ name: 'prepare', inputSchema: [], execute: async () => ({ folder: '/inbox' }) })
const handled = []
actions.register({ name: 'handle', inputSchema: [{ name: 'name', type: 'string' }, { name: 'folder', type: 'string' }],
  execute: async (ctx) => { handled.push(ctx.input); return { done: ctx.input.name } } })

await engine.startEngine({
  db: { name: WF_DB, connection: PG, connectionName: 'workflow_poll_test',
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } } },
  schedule: false
})
const Workflow = engine.db.model('Workflow')
const Step = engine.db.model('WorkflowStep')
const Run = engine.db.model('WorkflowRun')
const StepRun = engine.db.model('WorkflowStepRun')
const Edge = engine.db.model('WorkflowRunEdge')
async function workflow(name, steps) {
  const w = await Workflow.query().insert({ id: generateId(), name, kind: 'workflow', status: 'published' })
  for (let i = 0; i < steps.length; i++) {
    await Step.query().insert({ id: generateId(), workflowId: w.id, kind: 'auto', onError: 'stop', position: i, ...steps[i] })
  }
  return w
}
const to = (target) => ({ condition: null, mode: 'single', target })
// The job's tick, the way @xeplr/jobs runs it: the registered action, by name.
const tick = (w, stepKey) => actions.runAction({ name: 'workflow-poll', input: { workflowId: w.id, stepKey } })

try {
  await runWithMt(MT, async () => {
    console.log('a run that reaches a step that keeps checking parks there, listening')
    const w = await workflow('Watch the inbox', [
      { stepKey: 'first', name: 'Where', actionName: 'prepare', values: {}, transitions: [to('watch')] },
      { stepKey: 'watch', name: 'Look in the folder', actionName: 'look', values: { folder: '{steps.first.output.folder}' },
        poll: { jobId: 'job-1' }, transitions: [to('handle')] },
      { stepKey: 'handle', name: 'Handle it', actionName: 'handle',
        values: { name: '{steps.watch.output.files.0.name}', folder: '{steps.first.output.folder}' }, transitions: [to('end_success')] }
    ])
    const run = await engine.runner.startRun(w.id, {})
    const parked = await StepRun.query().where({ runId: run.id, stepKey: 'watch' }).first()
    check('the run waits, on the step', run.status === 'waiting' && parked && parked.status === 'waiting' && parked.output.listening === true, { run: run.status, parked })
    check('...and the step was not run on arrival: its job runs it', looked === 0, looked)

    console.log('\na tick that finds nothing starts nothing')
    const empty = await tick(w, 'watch')
    check('checked the one listening run, found nothing', empty.status === 'success' && empty.output.listening === 1 && empty.output.found === 0 && looked === 1, empty)
    check('...no run started', (await Edge.query().where({ parentRunId: run.id })).length === 0)
    const afterEmpty = await StepRun.query().findById(parked.id)
    check('...the step says when it checked', afterEmpty.output.checks === 1 && afterEmpty.output.lastCheckedAt && afterEmpty.output.found === 0, afterEmpty.output)

    console.log('\na tick that finds something starts a run of its own from the step\'s arrows')
    inbox = [{ name: 'sept.csv' }]
    const hit = await tick(w, 'watch')
    check('found one, started one', hit.output.found === 1 && hit.output.started.length === 1, hit.output)
    const child = await Run.query().findById(hit.output.started[0])
    check('...that run went on and finished', child && child.status === 'success' && child.trigger === 'poll', child && { status: child.status, error: child.error })
    check('...with what was found, and what the steps before the listening step gave', handled.length === 1 &&
      handled[0].name === 'sept.csv' && handled[0].folder === '/inbox', handled)
    const edge = await Edge.query().where({ childRunId: child.id }).first()
    check('...linked to the listening run, from the step', edge && edge.parentRunId === run.id && edge.sourceStepKey === 'watch' && edge.item.files[0].name === 'sept.csv', edge)
    check('the listening run keeps listening after its run ends', (await Run.query().findById(run.id)).status === 'waiting')

    inbox = [{ name: 'oct.csv' }]
    const again = await tick(w, 'watch')
    check('every find is its own run', again.output.started.length === 1 && handled.length === 2 && handled[1].name === 'oct.csv' &&
      (await Edge.query().where({ parentRunId: run.id })).length === 2, handled)
    check('...and still the listening run waits', (await Run.query().findById(run.id)).status === 'waiting')
    const counted = await StepRun.query().findById(parked.id)
    check('...the step counts its checks and finds', counted.output.checks === 3 && counted.output.found === 2, counted.output)

    console.log('\na check that fails is recorded, and the step keeps listening')
    broken = true
    const failed = await tick(w, 'watch')
    broken = false
    const afterFail = await StepRun.query().findById(parked.id)
    check('the tick says which run, and why', failed.status === 'success' && failed.output.failed.length === 1 &&
      /not reachable/.test(failed.output.failed[0].message), failed.output)
    check('...on the step too; the run still waits', afterFail.status === 'waiting' && /not reachable/.test(afterFail.output.lastError) &&
      (await Run.query().findById(run.id)).status === 'waiting', afterFail.output)

    console.log('\ncancelling the listening run stops it')
    await engine.runner.cancelRun(run.id, { reason: 'No longer needed' })
    inbox = [{ name: 'nov.csv' }]
    const stopped = await tick(w, 'watch')
    check('nothing is listening, nothing is checked', stopped.output.listening === 0 && handled.length === 2, stopped.output)

    console.log('\nan "each item" arrow after it: one run per file found')
    const each = await workflow('Each file', [
      { stepKey: 'watch', name: 'Look', actionName: 'look', values: { folder: '/drop' }, poll: { jobId: 'job-2' },
        transitions: [{ condition: null, mode: 'each', source: 'output.files', target: 'handle' }] },
      { stepKey: 'handle', name: 'Handle', actionName: 'handle', values: { name: '{item.name}', folder: '/drop' }, transitions: [to('end_success')] }
    ])
    const er = await engine.runner.startRun(each.id, {})
    check('a first step can keep checking too', er.status === 'waiting', er.status)
    inbox = [{ name: 'a.csv' }, { name: 'b.csv' }]
    handled.length = 0
    const both = await tick(each, 'watch')
    for (let i = 0; i < 80 && handled.length < 2; i++) await sleep(25)
    check('two files, one run each', both.output.found === 1 && handled.map((h) => h.name).sort().join() === 'a.csv,b.csv', handled)
    check('...and the listening run still waits', (await Run.query().findById(er.id)).status === 'waiting')
  })

  console.log('\nwhat counts as found')
  const isFound = engine.actionCatalog.isFound
  check('a count above zero is found; zero is not, whatever lists it carries', isFound('x', { messageCount: 2 }) && !isFound('x', { count: 0, files: [1] }))
  check('without a count, any list that is not empty', isFound('x', { rows: [1] }) && !isFound('x', { rows: [], name: 'a' }) && !isFound('x', null))
  engine.actionCatalog.foundWhen('x-own', (o) => o.ready === 'yes')
  check('an action may say for itself', isFound('x-own', { ready: 'yes', rows: [] }) && !isFound('x-own', { ready: 'no', rows: [1] }))

  console.log('\nthe job\'s action is there to run, and offered to nobody')
  check('registered', Boolean(actions.get('workflow-poll')))
  check('...not in the step palette', !engine.actionCatalog.catalog().some((a) => a.name === 'workflow-poll'))
  const snap = engine.versions.snapshotOf([{ stepKey: 'a', actionName: 'x' }])[0]
  check('a step that does not poll is versioned as before the column', !('poll' in snap) &&
    'poll' in engine.versions.snapshotOf([{ stepKey: 'a', actionName: 'x', poll: { jobId: 'j' } }])[0])
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

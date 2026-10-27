// A run survives a crash and a design edit, through the real engine on a real
// Postgres: a process is killed mid-step and the sweeper picks the run up; a
// wait past its timeoutMs fails; a run reads the steps it started with even
// after the design is saved over them; every run records where it is.
//
// Needs WORKFLOW_TEST_PG = '{"host":"localhost","port":5432,"user":"…","password":"…"}'.
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
const check = (n, c, extra) => { results.push(c); console.log((c ? '  ok   ' : '  FAIL ') + n + (c || extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 600))) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const STAMP = Date.now()
const WF_DB = 'xeplr_wf_recovery_test_' + STAMP
const MT = { mtId1: 'c' + (STAMP % 100000), mtId2: 'w' + (STAMP % 100000) }
const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'recovery.child.mjs')
const MIGRATION = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '0019_paths_versions_recovery.sql')

registerApplication('xeplr-workflow-test')
const seen = []
const sent = []
actions.register({ name: 'rc-seen', inputSchema: [{ name: 'note', type: 'string' }], execute: async (ctx) => { seen.push(ctx.input.note); return {} } })
actions.register({ name: 'rc-park', inputSchema: [], execute: async () => ({}) })
// The same names the killed process hangs in; here they finish.
actions.register({ name: 'rc-send', inputSchema: [], execute: async () => { sent.push(1); return {} } })
actions.register({ name: 'rc-read', inputSchema: [], execute: async () => ({ rows: 3 }) })
engine.actionCatalog.allowRetry('rc-read')

await engine.startEngine({
  db: {
    name: WF_DB, connection: PG, connectionName: 'workflow_recovery_test',
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
const Version = engine.db.model('WorkflowVersion')

async function workflow(name, steps) {
  const w = await Workflow.query().insert({ id: generateId(), name, kind: 'workflow', status: 'published' })
  await putSteps(w.id, steps)
  return w
}
// What saving a design does: every step deleted and inserted again, new ids.
async function putSteps(workflowId, steps) {
  await Step.query().delete().where({ workflowId })
  for (let i = 0; i < steps.length; i++) {
    await Step.query().insert({ id: generateId(), workflowId, kind: 'auto', onError: 'stop', position: i, values: {}, ...steps[i] })
  }
}
const runOf = (id) => Run.query().findById(id)
const to = (target) => ({ condition: null, mode: 'single', target })
const past = () => new Date(Date.now() - 60000).toISOString()

// Start a run in another process and kill it once its step is under way.
function startAndKill(workflowId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD], {
      env: { ...process.env, RC_PG: JSON.stringify(PG), RC_DB: WF_DB, RC_MT: JSON.stringify(MT), RC_WORKFLOW: workflowId },
      stdio: ['ignore', 'pipe', 'inherit']
    })
    let out = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('the child never reached its step: ' + out)) }, 20000)
    child.stdout.on('data', (d) => {
      out += d
      const m = out.match(/STEP_RUNNING (\S+)/)
      if (m) { clearTimeout(timer); child.kill('SIGKILL'); child.on('exit', () => resolve(m[1])) }
    })
  })
}

try {
  await runWithMt(MT, async () => {
    console.log('every run records where it is')
    const parked = await workflow('Parked', [
      { stepKey: 'ask', name: 'Ask', actionName: 'rc-park', kind: 'wait', transitions: [to('end_success')] }
    ])
    const pr = await engine.runner.startRun(parked.id, {})
    const paths = await Path.query().where({ runId: pr.id })
    check('one path, waiting at the step', paths.length === 1 && paths[0].stepKey === 'ask' && paths[0].status === 'waiting', paths)
    const sr = await StepRun.query().where({ runId: pr.id }).first()
    const key = await Key.query().where({ runId: pr.id }).first()
    check('the step run and its key name that path', sr.pathId === paths[0].id && key.pathId === paths[0].id, { sr, key })
    check('...and the waiting run holds no lease', (await runOf(pr.id)).lockedUntil === null)
    await engine.runner.resumeByKey(key.key, {})
    check('answered, the path is done', (await Path.query().findById(paths[0].id)).status === 'done' && (await runOf(pr.id)).status === 'success')

    console.log('\na run reads the steps it started with')
    const design = await workflow('Design', [
      { stepKey: 'ask', name: 'Ask', actionName: 'rc-park', kind: 'wait', transitions: [to('next')] },
      { stepKey: 'next', name: 'Next', actionName: 'rc-seen', values: { note: 'old design' } }
    ])
    const r1 = await engine.runner.startRun(design.id, {})
    await putSteps(design.id, [
      { stepKey: 'ask', name: 'Ask again', actionName: 'rc-park', kind: 'wait', transitions: [to('next')] },
      { stepKey: 'next', name: 'Next', actionName: 'rc-seen', values: { note: 'new design' } }
    ])
    const k1 = await Key.query().where({ runId: r1.id, consumedDate: null }).first()
    await engine.runner.resumeByKey(k1.key, {})
    check('a run waiting while the design was saved over it can still be answered, and goes on as it started',
      (await runOf(r1.id)).status === 'success' && seen.includes('old design') && !seen.includes('new design'), { run: await runOf(r1.id), seen })
    const r2 = await engine.runner.startRun(design.id, {})
    const k2 = await Key.query().where({ runId: r2.id, consumedDate: null }).first()
    await engine.runner.resumeByKey(k2.key, {})
    check('a run started after reads the new design', seen.includes('new design'))
    const r3 = await engine.runner.startRun(design.id, {})
    const versions = await Version.query().where({ workflowId: design.id }).orderBy('version')
    check('two designs, two versions, numbered 1 and 2', versions.length === 2 && versions[0].version === 1 && versions[1].version === 2, versions.map((v) => v.version))
    check('...and a run on unchanged steps reuses its version', r1.versionId === versions[0].id && r2.versionId === versions[1].id && r3.versionId === r2.versionId)

    console.log('\na wait past its timeoutMs fails')
    const slow = await workflow('Slow answer', [
      { stepKey: 'ask', name: 'Ask', actionName: 'rc-park', kind: 'wait', timeoutMs: 100, transitions: [to('end_success')] }
    ])
    const tr = await engine.runner.startRun(slow.id, {})
    const tk = await Key.query().where({ runId: tr.id }).first()
    check('its key says when it expires', tk.expiresAt && new Date(tk.expiresAt) > new Date(Date.now() - 5000))
    const early = await engine.recovery.sweep()
    check('not before', (await runOf(tr.id)).status === 'waiting', early)
    await sleep(250)
    const swept = await engine.recovery.sweep()
    const tRun = await runOf(tr.id)
    check('after: the run fails as TIMED_OUT', tRun.status === 'failed' && tRun.error.code === 'TIMED_OUT', { tRun, swept })
    const goOn = await workflow('Slow answer, go on', [
      { stepKey: 'ask', name: 'Ask', actionName: 'rc-park', kind: 'wait', timeoutMs: 50, onError: 'continue' },
      { stepKey: 'chase', name: 'Chase', actionName: 'rc-seen', values: { note: 'chased' } }
    ])
    const gr = await engine.runner.startRun(goOn.id, {})
    await sleep(150)
    await engine.recovery.sweep()
    check('with onError continue it goes on to the next step', (await runOf(gr.id)).status === 'success' && seen.includes('chased'))
    const askOut = await StepRun.query().where({ runId: gr.id, stepKey: 'ask' }).first()
    check('...with output.timedOut for it to read', askOut.output && askOut.output.timedOut === true, askOut)

    console.log('\na process killed mid-step')
    const sending = await workflow('Send', [
      { stepKey: 'send', name: 'Send the file', actionName: 'rc-send', transitions: [to('end_success')] }
    ])
    const killed = await startAndKill(sending.id)
    check('the run is left running under a lease', (await runOf(killed)).status === 'running' && (await runOf(killed)).lockedUntil)
    const tooSoon = await engine.recovery.sweep()
    check('not taken while the lease holds', !tooSoon.recovered.some((r) => r.runId === killed), tooSoon)
    await sleep(900)
    const s1 = await engine.recovery.sweep()
    const kRun = await runOf(killed)
    const kStep = await StepRun.query().where({ runId: killed }).first()
    check('a step that may have had an effect is NOT run again', sent.length === 0, sent)
    check('...the run stops as INTERRUPTED, saying to check it', kRun.status === 'failed' && kRun.error.code === 'INTERRUPTED' && /Send the file/.test(kRun.error.message), { kRun, s1 })
    check('...and the step is marked interrupted', kStep.status === 'interrupted', kStep)

    const reading = await workflow('Read', [
      { stepKey: 'read', name: 'Read', actionName: 'rc-read', transitions: [to('note')] },
      { stepKey: 'note', name: 'Note', actionName: 'rc-seen', values: { note: 'read {steps.read.output.rows} rows' } }
    ])
    const killed2 = await startAndKill(reading.id)
    await sleep(900)
    await engine.recovery.sweep()
    const rSteps = await StepRun.query().where({ runId: killed2, stepKey: 'read' }).orderBy('recordCreatedDate')
    check('a step safe to run again is run again, and the run finishes', (await runOf(killed2)).status === 'success' && seen.includes('read 3 rows'), await runOf(killed2))
    check('...the first attempt kept as interrupted', rSteps.length === 2 && rSteps[0].status === 'interrupted' && rSteps[1].status === 'success', rSteps.map((s) => s.status))

    console.log('\nwhat a run last recorded decides how it goes on')
    const two = await workflow('Two steps', [
      { stepKey: 'first', name: 'First', actionName: 'rc-seen', values: { note: 'first' }, transitions: [to('second')] },
      { stepKey: 'second', name: 'Second', actionName: 'rc-seen', values: { note: 'second' } }
    ])
    const steps = await Step.query().where({ workflowId: two.id }).orderBy('position')
    const versionId = await engine.versions.pinVersion(two.id, steps)
    const notStarted = await Run.query().insert({ id: generateId(), workflowId: two.id, versionId, status: 'running', lockedUntil: past(), startedAt: new Date().toISOString() })
    const routedLost = await Run.query().insert({ id: generateId(), workflowId: two.id, versionId, status: 'running', lockedUntil: past(), startedAt: new Date().toISOString() })
    await StepRun.query().insert({ id: generateId(), runId: routedLost.id, stepId: steps[0].id, stepKey: 'first', actionName: 'rc-seen', status: 'success', output: {}, position: 0 })
    const busy = await Run.query().insert({ id: generateId(), workflowId: two.id, versionId, status: 'running', lockedUntil: new Date(Date.now() + 60000).toISOString(), startedAt: new Date().toISOString() })
    seen.length = 0
    await engine.recovery.sweep()
    check('died before its first step: it is started', (await runOf(notStarted.id)).status === 'success')
    check('died after a step, before the next: it goes on from there without repeating it',
      (await runOf(routedLost.id)).status === 'success' && (await StepRun.query().where({ runId: routedLost.id, stepKey: 'first' })).length === 1 &&
      (await StepRun.query().where({ runId: routedLost.id, stepKey: 'second' })).length === 1)
    check('a run whose lease still holds is left alone', (await runOf(busy.id)).status === 'running' && (await StepRun.query().where({ runId: busy.id })).length === 0)

    console.log('\na run waiting from before the upgrade')
    const before = await workflow('From before', [
      { stepKey: 'ask', name: 'Ask', actionName: 'rc-park', kind: 'wait', transitions: [to('done')] },
      { stepKey: 'done', name: 'Done', actionName: 'rc-seen', values: { note: 'old run finished' } }
    ])
    const beforeSteps = await Step.query().where({ workflowId: before.id }).orderBy('position')
    // As 0018 left it: no version, no path, no lease, a key with no path.
    const old = await Run.query().insert({ id: generateId(), workflowId: before.id, status: 'waiting', startedAt: new Date().toISOString() })
    await StepRun.query().insert({ id: generateId(), runId: old.id, stepId: beforeSteps[0].id, stepKey: 'ask', actionName: 'rc-park', status: 'waiting', output: {}, position: 0 })
    const oldKey = await Key.query().insert({ id: generateId(), runId: old.id, stepId: beforeSteps[0].id, key: 'old-key-' + STAMP })
    const sql = readFileSync(MIGRATION, 'utf8')
    await engine.db.conn().raw(sql.slice(sql.indexOf('-- Every run not yet finished')))
    const oldPath = await Path.query().where({ runId: old.id }).first()
    check('the migration gives it one path at its step, and ties its key to it',
      oldPath && oldPath.stepKey === 'ask' && oldPath.status === 'waiting' && (await Key.query().findById(oldKey.id)).pathId === oldPath.id, oldPath)
    await engine.runner.resumeByKey(oldKey.key, {})
    check('...and it is answered and finishes on the live steps', (await runOf(old.id)).status === 'success' && seen.includes('old run finished'))
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

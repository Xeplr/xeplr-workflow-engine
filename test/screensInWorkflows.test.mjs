// A screen inside an ordinary workflow, through the real engine on a real
// Postgres: assigned to a role, listed as waiting for the people who hold it,
// answered with a named button, and branching on which.
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
const flows = require('../lib/flows.js')

const results = []
const check = (n, c, extra) => { results.push(c); console.log((c ? '  ok   ' : '  FAIL ') + n + (c || extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 500))) }
const refusal = (p) => p.then(() => null, (e) => e)

const STAMP = Date.now()
const WF_DB = 'xeplr_wf_screens_test_' + STAMP
const MT = { mtId1: 'c' + (STAMP % 100000), mtId2: 'w' + (STAMP % 100000) }
const OTHER = { mtId1: 'x' + (STAMP % 100000), mtId2: 'y' + (STAMP % 100000) }

registerApplication('xeplr-workflow-test')
const seen = []
actions.register({ name: 'scr-unmatched', inputSchema: [], execute: async () => ({ rows: [{ ref: 'A1', amount: 500 }, { ref: 'A2', amount: 20 }] }) })
actions.register({ name: 'scr-seen', inputSchema: [{ name: 'note', type: 'string' }], execute: async (ctx) => { seen.push(ctx.input.note); return {} } })

await engine.startEngine({
  db: { name: WF_DB, connection: PG, connectionName: 'workflow_screens_test',
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } } },
  schedule: false
})
const Workflow = engine.db.model('Workflow')
const Step = engine.db.model('WorkflowStep')
const Run = engine.db.model('WorkflowRun')
const ACCOUNTS = { id: 'u1', roles: ['Accounts'] }
const SALES = { id: 'u2', roles: ['Sales'] }
const ADMIN = { id: 'u3', roles: ['Super Admin'] }
const when = (field, value, target) => ({ condition: { left: { field }, op: 'eq', right: { value } }, mode: 'single', target })
const otherwise = (target) => ({ condition: null, mode: 'single', target })

try {
  await runWithMt(MT, async () => {
    const w = await Workflow.query().insert({ id: generateId(), name: 'Bank recon', kind: 'workflow', status: 'published' })
    const steps = [
      { stepKey: 'match', name: 'Match', actionName: 'scr-unmatched', kind: 'auto', values: {}, transitions: [otherwise('review')] },
      { stepKey: 'review', name: 'Review the unmatched', actionName: 'screen-show', kind: 'wait', values: {
          screen: 'unmatched_review', values: { lines: '{steps.match.output.rows}' }, assignTo: 'Accounts',
          buttons: [{ key: 'approve', label: 'Approve' }, { key: 'send_back', label: 'Send back' }] },
        transitions: [when('output.action', 'approve', 'post'), when('output.action', 'send_back', 'chase'), otherwise('end_failed')] },
      { stepKey: 'post', name: 'Post', actionName: 'scr-seen', kind: 'auto', values: { note: 'posted {steps.review.output.selected}' }, transitions: [otherwise('end_success')] },
      { stepKey: 'chase', name: 'Chase', actionName: 'scr-seen', kind: 'auto', values: { note: 'chased' }, transitions: [otherwise('end_success')] }
    ]
    for (let i = 0; i < steps.length; i++) await Step.query().insert({ id: generateId(), workflowId: w.id, onError: 'stop', position: i, ...steps[i] })

    console.log('a screen waits for its role')
    const run = await engine.runner.startRun(w.id, {})
    check('the run parks on the review screen', (await Run.query().findById(run.id)).status === 'waiting')
    const mine = await flows.listWaiting({ user: ACCOUNTS })
    check('Accounts sees it waiting, with its buttons and what it was handed', mine.length === 1 && mine[0].workflowName === 'Bank recon' && mine[0].stepName === 'Review the unmatched' &&
      mine[0].buttons.map((b) => b.label).join() === 'Approve,Send back' && mine[0].assignTo === 'Accounts', mine)
    check('Sales does not', (await flows.listWaiting({ user: SALES })).length === 0)
    check('a Super Admin does', (await flows.listWaiting({ user: ADMIN })).length === 1)
    const view = await flows.getRun(run.id)
    check('the screen opens with the rows the workflow handed it, and its buttons', Array.isArray(view.given.lines) && view.given.lines.length === 2 && view.buttons.length === 2 && view.assignTo === 'Accounts' && view.stepName === 'Review the unmatched', view)

    console.log('\nanswering it')
    const notYours = await refusal(flows.submitRun(run.id, { values: {}, action: 'approve' }, { user: SALES }))
    check('someone without the role is refused', notYours && notYours.code === 'NOT_YOURS' && /for Accounts/.test(notYours.message), notYours && notYours.message)
    const noButton = await refusal(flows.submitRun(run.id, { values: {} }, { user: ACCOUNTS }))
    check('a button must be pressed', noButton && noButton.code === 'ACTION_REQUIRED' && /approve, send_back/.test(noButton.message), noButton && noButton.message)
    const odd = await refusal(flows.submitRun(run.id, { values: {}, action: 'delete' }, { user: ACCOUNTS }))
    check('...and one of its own', odd && odd.code === 'ACTION_UNKNOWN', odd && odd.message)
    const done = await flows.submitRun(run.id, { values: { selected: [{ ref: 'A1', amount: 500 }] }, action: 'approve' }, { user: ACCOUNTS })
    check('Approve moves it on, down the approve arrow, with the rows ticked', done.status !== 'waiting' && seen.length === 1 && /posted/.test(seen[0]) && /A1/.test(seen[0]), { done, seen })
    check('...and it is no longer waiting for anyone', (await flows.listWaiting({ user: ACCOUNTS })).length === 0)

    const again = await engine.runner.startRun(w.id, {})
    await flows.submitRun(again.id, { values: {}, action: 'send_back' }, { user: ADMIN })
    check('Send back takes the other arrow', seen[1] === 'chased', seen)
  })
  await runWithMt(OTHER, async () => {
    check('another company has nothing waiting', (await flows.listWaiting({ user: ADMIN })).length === 0)
  })
  check('a screen for anyone is anyone\'s', flows.mayAnswer(null, SALES) && flows.mayAnswer('', { roles: [] }) && !flows.mayAnswer('Accounts', null))
  check('buttons typed as words, or the JSON of a list', JSON.stringify(flows.buttonsOf('Approve, Send back')) === '[{"key":"Approve","label":"Approve"},{"key":"Send back","label":"Send back"}]' &&
    flows.buttonsOf('[{"key":"a","label":"A"}]')[0].label === 'A' && flows.buttonsOf('').length === 0 && flows.buttonsOf('[broken').length === 0)
  check('buttons may be words', JSON.stringify(flows.buttonsOf(['Approve', { key: 'x' }, null, ''])) === '[{"key":"Approve","label":"Approve"},{"key":"x","label":"x"}]')
} catch (err) {
  check('no error', false, err.stack || err.message)
} finally {
  await engine.db.conn().destroy().catch(() => {})
  const admin = require('knex')({ client: 'pg', connection: { ...PG, database: 'postgres' } })
  await admin.raw(`DROP DATABASE IF EXISTS "${WF_DB}" WITH (FORCE)`).catch(() => {})
  await admin.destroy()
  const failed = results.filter((c) => !c).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}

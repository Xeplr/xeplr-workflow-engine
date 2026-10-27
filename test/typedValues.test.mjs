// What one step hands the next, through the real engine on a real Postgres.
//
// A list bound whole stays a list: the data step filters the rows an earlier
// step produced (it used to get their JSON as one string). A field the action
// declares as text still gets text. A date is written as the template asks.
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

const STAMP = Date.now()
const WF_DB = 'xeplr_wf_typed_test_' + STAMP
const MT = { mtId1: 'c' + (STAMP % 100000), mtId2: 'w' + (STAMP % 100000) }

registerApplication('xeplr-workflow-test')
// Stands in for a fetch: rows, a count and a period, as a db-fetch or a job gives them.
actions.register({
  name: 'wf-typed-rows',
  inputSchema: [],
  execute: async () => ({
    rows: [{ ref: 'A1', amount: 500 }, { ref: 'A2', amount: 20 }, { ref: 'A3', amount: 900 }],
    count: 3,
    period: '2026-08-31T18:30:00.000Z'
  })
})
// Records exactly what it was given, types and all.
const seen = []
actions.register({
  name: 'wf-typed-seen',
  inputSchema: [{ name: 'note', type: 'string' }, { name: 'n', type: 'number' }, { name: 'list', type: 'array' }],
  execute: async (ctx) => { seen.push(ctx.input); return {} }
})

await engine.startEngine({
  db: {
    name: WF_DB, connection: PG, connectionName: 'workflow_typed_test',
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } }
  },
  schedule: false
})
const Workflow = engine.db.model('Workflow')
const Step = engine.db.model('WorkflowStep')
const StepRun = engine.db.model('WorkflowStepRun')

async function workflow(name, steps) {
  const w = await Workflow.query().insert({ id: generateId(), name, kind: 'workflow', status: 'published' })
  for (let i = 0; i < steps.length; i++) {
    await Step.query().insert({ id: generateId(), workflowId: w.id, kind: 'auto', onError: 'stop', position: i, ...steps[i] })
  }
  return w
}

try {
  await runWithMt(MT, async () => {
    console.log('a list handed to the data step')
    const w = await workflow('Typed', [
      { stepKey: 'fetch', name: 'Fetch', actionName: 'wf-typed-rows', values: {} },
      { stepKey: 'big', name: 'Big ones', actionName: 'data-operation', values: {
        from: '{steps.fetch.output.rows}', where: 'amount > 100', columns: ['ref'],
        format: true, title: 'Over 100 for {steps.fetch.output.period|date:MMMM YYYY:Asia/Kolkata}'
      } },
      { stepKey: 'seen', name: 'Seen', actionName: 'wf-typed-seen', values: {
        note: '{steps.fetch.output.count}', n: '{steps.big.output.count}', list: '{steps.big.output.rows}'
      } }
    ])
    const run = await engine.runner.startRun(w.id, {})
    const steps = await StepRun.query().where({ runId: run.id }).orderBy('position')
    const big = steps.find((s) => s.stepKey === 'big')
    check("the run succeeds", (await engine.db.model("WorkflowRun").query().findById(run.id)).status === "success")
    check('the data step got the rows as a list, and filtered them',
      big && big.status === 'success' && JSON.stringify(big.output.rows) === '[{"ref":"A1"},{"ref":"A3"}]', big && big.output)
    check('...and its title wrote the period as a month, in the zone asked for', big && /Over 100 for September 2026/.test(big.output.html), big && big.output.html)
    check('the input recorded on the step is the list itself, not its JSON', big && Array.isArray(big.input.from) && big.input.from.length === 3, big && big.input)
    const got = seen[0] || {}
    check('a field declared as text gets text, even bound to a number', got.note === '3', got)
    check('a number stays a number', got.n === 2, got)
    check('a list stays a list', Array.isArray(got.list) && got.list.length === 2, got)

    console.log('\na saved connection: an id in the step, the login only in the call')
    engine.runner.setConnectionResolver(async (id) => id === 'pg-main'
      ? { dbType: 'postgres', connection: { ...PG, database: 'postgres' } } : null)
    const saved = await workflow('Saved connection', [
      { stepKey: 'fetch', name: 'Fetch', actionName: 'db-fetch', values: {
        connectionInfoId: 'pg-main', mode: 'query', sql: "select 'INV-1' as invoice, 48000 as amount", streaming_mode: false } }
    ])
    const sr = await engine.runner.startRun(saved.id, {})
    const fetched = (await StepRun.query().where({ runId: sr.id }))[0]
    check('the step reads through the saved connection', fetched.status === 'success' && fetched.output.rows[0].invoice === 'INV-1', fetched.output || fetched.error)
    check('...and what the run recorded holds the id, never the login', fetched.input.connectionInfoId === 'pg-main' && !('connection' in fetched.input) && !JSON.stringify(fetched.input).includes('"user"'), fetched.input)
    const gone = await workflow('Gone connection', [
      { stepKey: 'fetch', name: 'Fetch', actionName: 'db-fetch', values: { connectionInfoId: 'deleted-one', mode: 'query', sql: 'select 1', streaming_mode: false } }
    ])
    const gr = await engine.runner.startRun(gone.id, {})
    const gstep = (await StepRun.query().where({ runId: gr.id }))[0]
    const grun = await engine.db.model('WorkflowRun').query().findById(gr.id)
    check('a connection that is gone fails the step, saying so', gstep.status === 'failed' && grun.status === 'failed' && gstep.error.code === 'CONNECTION_NOT_FOUND' && /"deleted-one"/.test(gstep.error.message), gstep.error)
    engine.runner.setConnectionResolver(null)

    console.log('\nan API called through a saved connection')
    const http = require('node:http')
    const api = http.createServer((req, res) => {
      const ok = req.headers.authorization === 'Bearer api-secret'
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' })
      res.end(JSON.stringify(ok ? { rows: [{ ref: 'B1', amount: 75 }], asked: req.url } : { error: 'no' }))
    })
    await new Promise((r) => api.listen(0, r))
    engine.runner.setConnectionResolver(async (id) => id === 'bank-api'
      ? { baseUrl: 'http://127.0.0.1:' + api.address().port + '/v2', auth: { type: 'bearer', token: 'api-secret' } } : null)
    const call = await workflow('API call', [
      { stepKey: 'call', name: 'Statements', actionName: 'http-request', values: {
        connectionInfoId: 'bank-api', path: '/statements', query: { month: '2026-09' } } },
      { stepKey: 'keep', name: 'Keep', actionName: 'data-operation', values: { from: '{steps.call.output.body.rows}' } }
    ])
    const cr = await engine.runner.startRun(call.id, {})
    const callSteps = await StepRun.query().where({ runId: cr.id }).orderBy('position')
    check('the step called the API, signed in from the saved connection', callSteps[0].status === 'success' && callSteps[0].output.body.asked === '/v2/statements?month=2026-09', callSteps[0].output || callSteps[0].error)
    check('...its rows went on as a list', callSteps[1] && callSteps[1].output.count === 1, callSteps[1] && callSteps[1].output)
    check('...and the token is nowhere in what the run recorded', !JSON.stringify(callSteps.map((x) => x.input)).includes('api-secret'))
    api.close()
    engine.runner.setConnectionResolver(null)

    console.log('\na template the engine cannot fill')
    const bad = await workflow('Bad date', [
      { stepKey: 'fetch', name: 'Fetch', actionName: 'wf-typed-rows', values: {} },
      { stepKey: 'seen', name: 'Seen', actionName: 'wf-typed-seen', values: { note: 'For {steps.fetch.output.rows|date:YYYY}' } }
    ])
    const badRun = await engine.runner.startRun(bad.id, {})
    const after = await engine.db.model('WorkflowRun').query().findById(badRun.id)
    check('fails the run, saying which step and why', after.status === 'failed' && /Step seen: .*needs a date/.test(after.error && after.error.message), after.error)
  })
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

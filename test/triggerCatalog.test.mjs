// The trigger kinds as a designer offers them: every kind this engine accepts,
// with the words and the form fields, and nothing it would refuse.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const triggers = require('../lib/triggers.js')

const results = []
const check = (n, c, extra) => { results.push(c); console.log((c ? '  ok   ' : '  FAIL ') + n + (c || extra === undefined ? '' : ' — ' + JSON.stringify(extra))) }

const list = triggers.catalog()
const kinds = list.map((k) => k.kind)
check('every kind the engine accepts, and only those', JSON.stringify(kinds) === JSON.stringify(triggers.kinds()), kinds)
check('the built-in four', ['manual', 'api', 'schedule', 'job'].every((k) => kinds.includes(k)), kinds)
check('each has words to show', list.every((k) => k.label && k.description && Array.isArray(k.fields)))
const job = list.find((k) => k.kind === 'job')
check('a job trigger asks for the job and when', job.fields.map((f) => f.name).join() === 'jobId,when' &&
  job.fields[1].options.map((o) => o.value).join() === triggers.JOB_WHEN.join(), job.fields)
const schedule = list.find((k) => k.kind === 'schedule')
check('a schedule asks for cron, required', schedule.fields[0].name === 'cron' && schedule.fields[0].required === true)

// What the form asks for is what validate reads: a filled-in form is accepted.
check('a filled-in job form is a valid trigger', triggers.validate({ kind: 'job', jobId: 'job_1', when: 'failed' }).when === 'failed')
check('a filled-in schedule form is a valid trigger', triggers.validate({ kind: 'schedule', cron: '0 9 * * 1', timezone: 'Asia/Kolkata' }).cron === '0 9 * * 1')

triggers.registerTrigger('folder-test', { description: 'A host kind.' })
const host = triggers.catalog().find((k) => k.kind === 'folder-test')
check('a kind a host registers is offered too, named by its kind', host && host.label === 'folder-test' && host.fields.length === 0, host)

// The period a scheduled run is for, in the trigger's zone.
const w = (p, at, z) => triggers.windowFor(p, new Date(at), z)
check('the month before, in India', JSON.stringify(w('previous-month', '2026-10-01T02:00:00Z', 'Asia/Kolkata')) === '{"from":"2026-08-31T18:30:00.000Z","to":"2026-09-30T18:30:00.000Z"}')
check('the day before, across a month end', w('previous-day', '2026-03-01T03:00:00Z', 'Asia/Kolkata').from === '2026-02-27T18:30:00.000Z')
check('the quarter before, across a clock change', JSON.stringify(w('previous-quarter', '2026-04-02T12:00:00Z', 'America/New_York')) === '{"from":"2026-01-01T05:00:00.000Z","to":"2026-04-01T04:00:00.000Z"}')
check('the year before, in January', w('previous-year', '2026-01-01T00:10:00Z', 'Asia/Kolkata').from === '2024-12-31T18:30:00.000Z')
check('this month', w('current-month', '2026-10-15T00:00:00Z', 'UTC').to === '2026-11-01T00:00:00.000Z')
check('a schedule keeps its period; one that is not one is refused', triggers.validate({ kind: 'schedule', cron: '0 7 1 * *', period: 'previous-month' }).period === 'previous-month' &&
  /`period` is one of/.test((() => { try { triggers.validate({ kind: 'schedule', cron: '0 7 1 * *', period: 'fortnight' }) } catch (e) { return e.message } })()))
check('any trigger keeps the inputs it gives the run; a list is refused', triggers.validate({ kind: 'job', jobId: 'j1', params: { month: '{trigger.window.from|date:YYYY-MM}' } }).params.month === '{trigger.window.from|date:YYYY-MM}' &&
  /`params` gives the run its inputs/.test((() => { try { triggers.validate({ kind: 'manual', params: ['x'] }) } catch (e) { return e.message } })()))

const failed = results.filter((c) => !c).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)

// An arrow written as `when` ({ field, op, value }, all / any, or empty for
// "otherwise") compiles into the engine's condition node — one compiler, used
// on every step save, so a screen of anyone's can write the simple form.
import { createRequire } from 'node:module'
import { isDeepStrictEqual as same } from 'node:util'
const require = createRequire(import.meta.url)
const { whenToCondition, compileTransitions } = require('../lib/conditions.js')

const results = []
const check = (n, c, extra) => { results.push(c); console.log((c ? '  ok   ' : '  FAIL ') + n + (c || extra === undefined ? '' : ' — ' + JSON.stringify(extra))) }
const refusal = (fn) => { try { fn(); return null } catch (e) { return e } }

check('a comparison', same(whenToCondition({ field: 'trigger.status', op: '=', value: 'success' }), { left: { field: 'trigger.status' }, op: 'eq', right: { value: 'success' } }))
check('empty is "otherwise"', whenToCondition(null) === null && whenToCondition(undefined) === null)
const g = whenToCondition({ all: [{ field: 'trigger.carry.rows', op: '>=', value: 5 }, { any: [{ field: 'output.x', op: 'isEmpty' }] }] })
check('all / any nest', g.all.length === 2 && g.all[1].any[0].op === 'isNull', g)
const bad = [
  [{ field: '', op: '=', value: 1 }, /`field` is required/],
  [{ field: 'a..b', op: '=', value: 1 }, /is not a usable field/],
  [{ field: 'a', op: 'like', value: 1 }, /not a comparison this engine has/],
  [{ any: [] }, /needs a non-empty list/],
  [{ all: [null] }, /an empty condition inside `all`/],
  ['status', /must be an object such as/]
]
bad.forEach(([w, msg]) => {
  const e = refusal(() => whenToCondition(w, 'Rule 2'))
  check('refused: ' + JSON.stringify(w), e && msg.test(e.message) && /^Rule 2/.test(e.message) && e.name === 'ValidationError', e && e.message)
})
const t = compileTransitions([{ when: { field: 'output.n', op: '>', value: 0 }, target: 'b' }, { when: null, target: 'c' }, { condition: { left: { field: 'x' }, op: 'eq', right: { value: 1 } }, target: 'd' }], 'Decide')
check('compiled beside `when`, which is kept', same(t[0].when, { field: 'output.n', op: '>', value: 0 }) && t[0].condition.op === 'gt' && t[1].condition === null)
check('an arrow with only a condition is left alone', same(t[2], { condition: { left: { field: 'x' }, op: 'eq', right: { value: 1 } }, target: 'd' }))
const e2 = refusal(() => compileTransitions([{ when: { field: 'x', op: '~' } }], 'Decide'))
check('a refusal names the step and the arrow', e2 && /^Step "Decide", arrow 1/.test(e2.message), e2 && e2.message)

// Arrows the runner could not follow are refused when the step is saved.
const arrowBad = [
  [{ mode: 'each', target: 'b' }, /needs the list to go through \(`source`\)/],
  [{ mode: 'each', target: 'b', source: 'rows' }, /"rows" is not a list it can read/],
  [{ mode: 'loop', target: 'b' }, /"loop" is not a kind of arrow/],
  [{ condition: null }, /say where it goes/],
  [{ decide: 'route', mode: 'each', source: 'output.rows' }, /either lets a function decide or goes through a list/],
  [{ decide: 'route', targets: 'b' }, /`targets` is a list of step keys/],
  ['b', /an arrow must be an object/]
]
arrowBad.forEach(([a, msg]) => {
  const e = refusal(() => compileTransitions([{ target: 'ok' }, a], 'Match'))
  check('arrow refused: ' + JSON.stringify(a), e && msg.test(e.message) && /^Step "Match", arrow 2/.test(e.message) && e.name === 'ValidationError' && e.code === 'TRANSITION_INVALID', e && e.message)
})
const arrowsOk = [
  { target: 'b' }, { target: 'end_success', mode: 'single' },
  { mode: 'each', target: 'b', source: 'output.rows' }, { mode: 'each', target: 'b', source: 'item.lines' },
  { decide: 'route' }, { decide: 'route', targets: ['b', 'end_failed'] }
]
check('arrows the runner follows are accepted', refusal(() => compileTransitions(arrowsOk, 'Match')) === null)

const failed = results.filter((c) => !c).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)

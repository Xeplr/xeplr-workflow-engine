// @flags: --preserve-symlinks
// (Linked @xeplr/* packages resolve their peers from this app's node_modules —
// see actionCatalog.test.mjs.)
//
// A workflow declares its inputs the way an action does, and refuses to start
// without them. Checked against the REAL applySchema from @xeplr/schema-handler
// rather than a stub — the point of this design is that both levels of the
// product agree on what "required" means, and a stub would let them drift.

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { resolveParams, collectParams } = require('../lib/workflowRunner.js')

const results = []
const check = (n, c) => { results.push([n, c]); console.log((c ? '  ok   ' : '  FAIL ') + n) }
const threw = (fn) => { try { fn(); return null } catch (e) { return e } }

// Declared ON THE STEPS, which is where a binding is written. The workflow
// row itself carries nothing.
const WF = { name: 'Onboard customer' }
const STEPS = [
  { stepKey: 'lookup', params: [
    { name: 'customerId', type: 'string', required: true, order: 1 }
  ] },
  { stepKey: 'notify', params: [
    { name: 'tier',  type: 'string', default: 'standard', order: 1 },
    { name: 'seats', type: 'number', order: 2 }
  ] }
]
const DECLARED_ARGS = [WF, STEPS]

console.log('\na declared required param is enforced BEFORE anything runs')
{
  const err = threw(() => resolveParams(...DECLARED_ARGS, {}))
  check('refuses with nothing supplied', err !== null)
  check('names the workflow, not just the schema', err.message.includes('Onboard customer'))
  check('names the missing field', err.message.includes('customerId'))
  check('carries a code', err.code === 'PARAMS_INVALID')
  check('carries per-field details', Array.isArray(err.details) && err.details.length > 0)
  check('the detail points at the field', err.details.some((d) => d.field === 'customerId'))
}

console.log('\nsupplying it is enough')
{
  const out = resolveParams(...DECLARED_ARGS, { customerId: 'cus_88' })
  check('accepted', out.customerId === 'cus_88')
  check('a declared default is filled in', out.tier === 'standard')
  check('an optional one with no default stays absent', !('seats' in out))
}

console.log('\ntypes are enforced, not just presence')
{
  const err = threw(() => resolveParams(...DECLARED_ARGS, { customerId: 'cus_88', seats: 'twelve' }))
  check('a string where a number was declared is refused', err !== null)
  check('and it says which field', err.details.some((d) => d.field === 'seats'))
}

console.log('\na typo is caught here, not four steps in')
{
  const err = threw(() => resolveParams(...DECLARED_ARGS, { custmerId: 'cus_88' }))
  check('the misspelling does not satisfy the requirement', err !== null)
  const out = resolveParams(...DECLARED_ARGS, { customerId: 'cus_88', stowaway: 'x' })
  check('an undeclared key is dropped rather than carried', !('stowaway' in out))
}

console.log('\na workflow that declares nothing is unchanged')
{
  // Every workflow built before this existed is in this state. Rejecting
  // their params would break all of them; declaring is how you opt in.
  const out = resolveParams({ name: 'Legacy', params: null }, [], { anything: 1 })
  check('null declaration passes params straight through', out.anything === 1)
  check('empty declaration too', resolveParams({ name: 'L', params: [] }, [{ stepKey: 's' }], { a: 2 }).a === 2)
  check('missing declaration too', resolveParams({ name: 'L' }, [{ stepKey: 's', params: null }], { a: 3 }).a === 3)
  check('and no params at all is an empty object, not a throw',
    JSON.stringify(resolveParams({ name: 'L' }, [], undefined)) === '{}')
}

console.log('\nthe run schema is the UNION of what the steps declare')
{
  const schema = collectParams(WF, STEPS)
  const names = schema.map((f) => f.name)
  check('gathers from every step', names.join(',') === 'customerId,tier,seats')
  check('order is renumbered across the union', schema.map((f) => f.order).join(',') === '1,2,3')

  // Two steps needing the same thing is normal — one value, asked for once.
  const shared = collectParams(WF, [
    { params: [{ name: 'orgId', type: 'string' }] },
    { params: [{ name: 'orgId', type: 'string', required: true }] }
  ])
  check('a name declared twice appears once', shared.length === 1)
  check('required anywhere means required', shared[0].required === true)

  // First-by-position wins on everything else, so the result does not depend
  // on which row the database happened to return first.
  const conflicting = collectParams(WF, [
    { params: [{ name: 'x', type: 'string', description: 'from step 1' }] },
    { params: [{ name: 'x', type: 'number', description: 'from step 2' }] }
  ])
  check('the earlier declaration wins on type', conflicting[0].type === 'string')
  check('...and on description', conflicting[0].description === 'from step 1')

  check('a step declaring nothing contributes nothing',
    collectParams(WF, [{ stepKey: 'a' }, { stepKey: 'b', params: null }]).length === 0)
}

console.log('\ndeleting the step deletes the requirement')
{
  // The point of declaring on the step: no orphan requirement that the run
  // still demands and nothing reads.
  const err = threw(() => resolveParams(WF, STEPS, {}))
  check('required while the step is there', err !== null)
  const without = STEPS.filter((s) => s.stepKey !== 'lookup')
  const out = resolveParams(WF, without, {})
  check('and not required once it is gone', out.tier === 'standard')
}

console.log('\na workflow-level declaration still works and takes priority')
{
  // workflows.params predates this column; folding it in first keeps older
  // workflows running and keeps their statement of intent authoritative.
  const legacy = { name: 'Old', params: [{ name: 'x', type: 'string', description: 'workflow-level' }] }
  const merged = collectParams(legacy, [{ params: [{ name: 'x', type: 'number', required: true }] }])
  check('folded in', merged.length === 1)
  check('workflow-level wins on type', merged[0].type === 'string')
  check('but a step can still make it required', merged[0].required === true)
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)

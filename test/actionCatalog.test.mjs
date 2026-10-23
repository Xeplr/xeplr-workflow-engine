// @flags: --preserve-symlinks
// The action catalog — which @xeplr/actions built-ins this app offers.
//
// --preserve-symlinks: with scripts/dev-link.sh, @xeplr/actions is a symlink
// into xeplr-os, and without the flag its requires resolve from THAT folder —
// where its peers (@xeplr/db, @xeplr/utils, knex) are not installed. The flag
// resolves them from this app's node_modules, as a real install does.
//
// A deliberate whitelist, not "register everything the package exports", and
// the reason is in this suite: several entries in that package are PLACEHOLDERS
// — a module with a comment saying the implementation is pending and nothing
// else in it. Registering one would put a name in the catalog, draw it in the
// step picker, and fail at the moment somebody relied on it.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const catalog = require('../lib/actionCatalog.js')
const actions = require('@xeplr/actions')

const results = []
const check = (name, cond) => { results.push([name, cond]); console.log((cond ? '  ok   ' : '  FAIL ') + name) }

console.log('\ntelling a real action from a placeholder')
// The whole check is: can the registry accept it. A module with no execute is
// not an action however good its name is.
check('a complete module is ready', catalog.isReady({ name: 'x', execute: () => {} }))
check('a module with no executor is not', !catalog.isReady({ name: 'x' }))
check('...nor one with no name', !catalog.isReady({ execute: () => {} }))
check('...nor an empty placeholder', !catalog.isReady({}))
check('...nor nothing at all', !catalog.isReady(undefined))

console.log('\nwhat gets registered')
{
  actions.clear()
  const registered = catalog.registerAll()

  check('something is offered', registered.length > 0)
  check('...and every name is really in the registry', registered.every((n) => actions.has(n)))
  // The names are the MODULES' own, which are kebab-case — `dbFetch` registers
  // as `db-fetch`. The whitelist names the export; the registry names the
  // action. Confusing the two is how a step's actionName stops matching.
  check('the registered names are the actions’ own, not the export keys',
    registered.includes('db-fetch') && !registered.includes('dbFetch'))

  // The one built-in that runs arbitrary executables. Its absence is the point
  // of the whitelist existing at all, so it is asserted rather than assumed.
  check('spawnProgram is NOT offered', !actions.has('spawn-program'))
  check('...and is not in the wanted list either',
    !catalog.WANTED.includes('spawnProgram') && !catalog.WANTED_WITH_META.includes('spawnProgram'))

  // A wanted export that the package has not implemented yet is skipped, not
  // registered and not thrown on: the app is perfectly usable without it, and
  // refusing to start would take the product down over an action nobody may be
  // using. It stays in the list so it lands the day the package implements it.
  const wanted = [...catalog.WANTED, ...catalog.WANTED_WITH_META]
  const notReady = wanted.filter((k) => !catalog.isReady(actions.builtins[k]))
  check('a placeholder is skipped rather than registered',
    notReady.every((k) => !actions.has(k)))
  // Plus this app's own actions — LOCAL (e.g. job-run) and HIDDEN
  // (screen-show), both of which registerAll registers alongside the built-ins.
  check('...and registering it did not throw',
    registered.length === wanted.length - notReady.length + catalog.LOCAL.length + catalog.HIDDEN.length)
}

console.log('\nregistered, and deliberately not offered')
{
  // screen-show is half of something: the other half is the app that owns the
  // screens, reached through the /flows facade. The registry MUST have it, or a
  // flow's steps cannot run at all — and the palette must NOT, or somebody
  // drops one onto the ordinary canvas and that run parks forever with nothing
  // anywhere able to resume it.
  const names = catalog.catalog().map((r) => r.name)
  catalog.HIDDEN.forEach((def) => {
    check(def.name + ' is registered, so a step naming it can run', actions.has(def.name))
    check('...and is NOT in the catalog a palette is drawn from', !names.includes(def.name))
  })
  check('hiding one hides nothing else', names.includes('db-fetch') && names.includes('job-run'))
}

console.log('\nregistering twice')
{
  // bin/www calls this once, but a reload, a test or a second boot path must
  // not double the catalog — register() overwrites by name, and this is the
  // check that keeps that true.
  const before = actions.list().length
  catalog.registerAll()
  check('leaves the registry the same size', actions.list().length === before)
}

console.log('\nwhat the UI is handed')
{
  const rows = catalog.catalog()
  check('one row per registered action, less the hidden ones',
    rows.length === actions.list().length - catalog.HIDDEN.length)
  check('each has a name', rows.every((r) => typeof r.name === 'string' && r.name))
  // THE SCHEMA IS THE POINT — see the note in actionCatalog.js.
  check('each carries its input schema', rows.every((r) => Array.isArray(r.inputSchema)))
  // Never. It is a function, it would not survive JSON, and an endpoint that
  // hands out executors is an endpoint that explains how to bypass itself.
  check('and none of them carries its executor', rows.every((r) => r.execute === undefined))
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)

// WHERE THE ENGINE'S SQL IS. startEngine() hands these to @xeplr/db's
// migrator, which falls back to ./migrations — the HOST's own folder, from the
// host's working directory — when a dir is undefined. So a wrong export here
// does not fail; it runs the host's migrations against workflow's database.
// Every directory must exist, hold .sql files, and match the package's
// readsFromDisk list (what a compiling build ships).
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const engine = require('../index.js')
const pkg = require('../package.json')
const root = path.dirname(require.resolve('../package.json'))

const results = []
const check = (name, cond, extra) => { results.push(cond); console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond || extra === undefined ? '' : ' — ' + JSON.stringify(extra))) }

for (const key of ['MIGRATIONS_DIR', 'TENANT_MIGRATIONS_DIR']) {
  const dir = engine[key]
  check(key + ' is a path inside this package', typeof dir === 'string' && dir.startsWith(root + path.sep), dir)
  check(key + ' holds .sql files', typeof dir === 'string' && existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.sql')))
  check(key + ' is listed in readsFromDisk', typeof dir === 'string' && pkg.xeplr.readsFromDisk.includes(path.basename(dir)), pkg.xeplr.readsFromDisk)
}
check('the two are different folders', engine.MIGRATIONS_DIR !== engine.TENANT_MIGRATIONS_DIR)

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)

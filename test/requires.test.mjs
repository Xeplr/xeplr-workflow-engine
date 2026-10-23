// EVERY RELATIVE require IN THIS PACKAGE POINTS AT A FILE.
//
// Node resolves a require only when the line runs, so one inside a function
// (a model hook, a lazily loaded helper) can name a file that does not exist
// and nothing fails until that path is taken in production. A bundler
// resolves every one up front and refuses — which is how
// models/{Company,Workspace}.js's `require('../lib/auth')` was found, years of
// commits after it was written. This finds the next one without a bundler.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const results = []
const check = (name, cond) => { results.push(cond); if (!cond) console.log('  FAIL ' + name) }

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const full = path.join(dir, f)
    if (f === 'node_modules' || f === 'test') return []
    if (statSync(full).isDirectory()) return walk(full)
    return /\.(c?js)$/.test(f) || f === 'www' ? [full] : []
  })
}

let count = 0
{
  for (const file of walk(pkgRoot)) {
    const req = createRequire(file)
    for (const m of readFileSync(file, 'utf8').matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      count++
      let ok = true
      try { req.resolve(m[1]) } catch { ok = false }
      check(path.relative(pkgRoot, file) + ' → ' + m[1], ok)
    }
  }
}
const failed = results.filter((r) => !r).length
console.log(`  ${count - failed}/${count} relative requires resolve`)
process.exit(failed ? 1 : 0)

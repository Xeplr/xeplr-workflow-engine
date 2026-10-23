import { readdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Runs every *.test.* file beside this one, each in its own process.
//
// Deliberately not a test framework. These suites are plain scripts that print
// their own checks and exit non-zero on failure, which keeps them runnable on
// their own (`node test/totals.test.mjs`) with no runner, no config and no
// dependency — and means they survive whatever the project's test tooling
// becomes later.
//
// A suite that needs a node flag declares it on its own first lines:
//   // @flags: --expose-gc
const dir = path.dirname(fileURLToPath(import.meta.url))

const files = readdirSync(dir)
  .filter((f) => /\.test\.(mjs|cjs|js)$/.test(f))
  .sort()

let failed = 0
for (const file of files) {
  const full = path.join(dir, file)
  const header = readFileSync(full, 'utf8').slice(0, 400)
  const flagLine = header.match(/@flags:\s*(.+)/)
  const flags = flagLine ? flagLine[1].trim().split(/\s+/) : []

  console.log(`\n── ${file} ${'─'.repeat(Math.max(0, 60 - file.length))}`)
  const res = spawnSync(process.execPath, [...flags, full], { stdio: 'inherit' })
  if (res.status !== 0) failed++
}

console.log(`\n${files.length - failed}/${files.length} suites passed`)
process.exit(failed ? 1 : 0)

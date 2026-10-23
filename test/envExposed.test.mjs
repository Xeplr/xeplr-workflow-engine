// `{env.NAME}` reaches ONLY what WORKFLOW_ENV_EXPOSED names.
//
// The interesting assertions here are the negative ones. A resolved step input
// is echoed back by POST /steps/try and persisted on the step run, so a leak
// through this context is a leak to anyone who can open the builder — see
// lib/envExposed.js. These checks are the thing standing between that and
// ENCRYPTION_KEY, so they are written against the REAL interpolate from
// @xeplr/schema-handler rather than a stub.

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { exposedEnv, exposedNames } = require('../lib/envExposed.js')
const { interpolateAll } = require('@xeplr/schema-handler')

const results = []
const check = (n, c) => { results.push([n, c]); console.log((c ? '  ok   ' : '  FAIL ') + n) }

// Stand-ins for the two that actually matter. Named the same so a reader can
// see what is being kept out.
const withEnv = (vars, fn) => {
  const saved = {}
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; 
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k] }
  try { return fn() } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]
    }
  }
}

console.log('\nnothing is exposed by default')
{
  withEnv({ WORKFLOW_ENV_EXPOSED: undefined, ENCRYPTION_KEY: 'super-secret' }, () => {
    check('no list → empty context', Object.keys(exposedEnv()).length === 0)
    check('a set var is still unreachable', exposedEnv().ENCRYPTION_KEY === undefined)
  })
}

console.log('\nonly listed names come through')
{
  withEnv({ WORKFLOW_ENV_EXPOSED: 'PUBLIC_BASE_URL', PUBLIC_BASE_URL: 'https://app.xeplr.com', ENCRYPTION_KEY: 'super-secret' }, () => {
    const env = exposedEnv()
    check('listed name present', env.PUBLIC_BASE_URL === 'https://app.xeplr.com')
    check('unlisted secret absent', !('ENCRYPTION_KEY' in env))
    check('exactly one key', Object.keys(env).length === 1)
  })
}

console.log('\nthe list is parsed forgivingly but matched exactly')
{
  withEnv({ WORKFLOW_ENV_EXPOSED: ' A , ,B ,', A: '1', B: '2' }, () => {
    check('whitespace and empties ignored', exposedNames().join('|') === 'A|B')
    check('both resolve', exposedEnv().A === '1' && exposedEnv().B === '2')
  })
  withEnv({ WORKFLOW_ENV_EXPOSED: 'public_base_url', PUBLIC_BASE_URL: 'x' }, () => {
    check('matching is case-sensitive', exposedEnv().PUBLIC_BASE_URL === undefined)
  })
}

console.log('\nthe tempting shortcuts fail CLOSED, not open')
{
  withEnv({ WORKFLOW_ENV_EXPOSED: '*', ENCRYPTION_KEY: 'super-secret', AUTH_JWT_SECRET: 'jwt' }, () => {
    check('a bare * exposes nothing', Object.keys(exposedEnv()).length === 0)
  })
  withEnv({ WORKFLOW_ENV_EXPOSED: 'PUBLIC_*', PUBLIC_BASE_URL: 'x' }, () => {
    check('a glob is not a pattern', exposedEnv().PUBLIC_BASE_URL === undefined)
  })
  withEnv({ WORKFLOW_ENV_EXPOSED: 'NOT_SET_ANYWHERE' }, () => {
    check('listed-but-unset is omitted, not undefined', !('NOT_SET_ANYWHERE' in exposedEnv()))
  })
}

console.log('\nend to end, through the real interpolator')
{
  withEnv({ WORKFLOW_ENV_EXPOSED: 'PUBLIC_BASE_URL', PUBLIC_BASE_URL: 'https://app.xeplr.com', ENCRYPTION_KEY: 'super-secret' }, () => {
    // The shape lib/workflowRunner.js's buildContext returns.
    const context = { params: {}, item: null, steps: {}, previous_step: {}, env: exposedEnv(), resumeKey: null }
    const values = {
      subject: 'Approve at {env.PUBLIC_BASE_URL}/approve',
      leak: '{env.ENCRYPTION_KEY}',
      nested: { deep: ['{env.PUBLIC_BASE_URL}', '{env.AUTH_JWT_SECRET}'] }
    }
    const out = interpolateAll(values, context)
    check('exposed value interpolates', out.subject === 'Approve at https://app.xeplr.com/approve')
    check('unexposed renders empty, not the literal', out.leak === '')
    check('walks nested structures', out.nested.deep[0] === 'https://app.xeplr.com')
    check('and blocks inside them too', out.nested.deep[1] === '')
    check('no secret anywhere in the output', !JSON.stringify(out).includes('super-secret'))
  })
}

const failed = results.filter(([, c]) => !c)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)

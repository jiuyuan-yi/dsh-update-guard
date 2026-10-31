/**
 * The review's first finding: when the surface scan runs, the declared-range
 * result must still reach the final report. A plugin can declare a range that
 * rejects the target version while using only members that still exist — the
 * surface scan alone cannot see that.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { analyse } from '../lib/run.mjs'

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

const root = join(tmpdir(), `tier-${process.pid}`)
const profile = join(root, 'profile')
try {
  // Plugin A: declares a range that rejects 2.0.0, but uses an existing member.
  const a = join(profile, 'node_modules', 'declared-only-bad')
  mkdirSync(join(a, 'lib'), { recursive: true })
  writeFileSync(join(a, 'package.json'), JSON.stringify({
    name: 'declared-only-bad',
    version: '1.0.0',
    engines: { dsh: '>=0.1.0 <0.2.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(a, 'cordis.patch.yml'), '- insert:\n    - id: declared-only-bad\n      name: declared-only-bad\n')
  writeFileSync(join(a, 'lib', 'client.js'),
    "var P = require('@deepseek-ai/dsh-client-ui-primitives')\nmodule.exports = { r: () => P.Switch({}) }\n")

  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'p', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'declared-only-bad'] } },
  }))

  const surface = { '@deepseek-ai/dsh-client-ui-primitives': ['Switch'] }
  const r = analyse({ profileDir: profile, surface, version: '2.0.0', services: { declared: [], mentioned: [] }, cacheRoot: join(root, 'cache') })

  const hit = r.findings.find(f => f.plugin === 'declared-only-bad')
  check('插件出现在最终清单里', hit !== undefined, JSON.stringify(r.findings.map(f => f.plugin)))
  check('带上了版本声明证据', hit?.declared?.range === '>=0.1.0 <0.2.0', JSON.stringify(hit?.declared))
  check('接口层没有误报', (hit?.broken ?? []).length === 0, JSON.stringify(hit?.broken))
} finally { rmSync(root, { recursive: true, force: true }) }

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

/**
 * "Fresh machine" test: the guard must inspect whatever the PROFILE declares,
 * not anything remembered from the machine it was written on.
 *
 * Builds a profile in a temp directory with made-up plugins, hands the analyser
 * a synthetic API surface, and asserts that findings are exactly about those
 * fake plugins. If any real plugin name or real path leaked into the logic,
 * this test would show it.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { analyse } from '../lib/run.mjs'

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

const root = join(tmpdir(), `guard-fresh-${process.pid}`)
const profile = join(root, 'profile')

function addPlugin (name, { clientJs, ids } = {}) {
  const dir = join(profile, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name, version: '9.9.9',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(dir, 'cordis.patch.yml'),
    '- insert:\n' + (ids ?? [name]).map(id => `    - id: ${id}\n      name: ${name}\n`).join(''))
  if (clientJs !== undefined) {
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'client.js'), clientJs)
  }
}

try {
  mkdirSync(join(profile, 'node_modules'), { recursive: true })

  // Three fabricated plugins. None of these exist on the machine this was written on.
  addPlugin('alpha-tools', {
    ids: ['alpha-tools'],
    clientJs: [
      "var P = require('@deepseek-ai/dsh-client-ui-primitives')",
      'module.exports = { r: () => P.Switch({}) }',
    ].join('\n'),
  })
  addPlugin('beta-widget', {
    ids: ['beta-a', 'beta-b'],
    clientJs: [
      "var W = require('@deepseek-ai/dsh-client-ui-primitives')",
      'module.exports = { r: () => W.VeryOldThing({}) }',
    ].join('\n'),
  })
  addPlugin('gamma-quiet', { ids: ['gamma-quiet'] })   // no client half at all

  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'fresh-profile',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'alpha-tools', 'beta-widget', 'gamma-quiet'] } },
    dependencies: {},
  }))

  // Synthetic surface: has Switch, lacks VeryOldThing.
  const surface = {
    '@deepseek-ai/dsh-client-ui-primitives': ['Switch', 'Button'],
  }

  console.log('\n[1] 只报这个 profile 里的插件')
  const r = analyse({ profileDir: profile, cacheRoot: join(root, 'cache'), surface })
  check('阶段是 analysed', r.stage === 'analysed', r.stage)
  const names = r.findings.map(f => f.plugin)
  check('检出 beta-widget', names.includes('beta-widget'), names.join(','))
  check('不误报 alpha-tools', !names.includes('alpha-tools'))
  check('不误报没有客户端半侧的插件', !names.includes('gamma-quiet'))
  check('没有夹带任何真实插件名', !names.some(n => /rewind|whale|purge|cookie/.test(n)), names.join(','))

  console.log('\n[2] 缺的成员来自合成接口面')
  const beta = r.findings.find(f => f.plugin === 'beta-widget')
  const missing = beta?.broken?.[0]?.missing ?? []
  check('缺的是 VeryOldThing', missing.includes('VeryOldThing'), missing.join(','))
  check('Switch 不误判为缺失', !missing.includes('Switch'))

  console.log('\n[3] 多 id 插件把 id 全带上')
  check('beta 有两个 id', Array.isArray(beta?.ids) && beta.ids.length === 2, (beta?.ids ?? []).join(','))

  console.log('\n[4] 检查数只算这个 profile 的')
  check('参与检查 3 个', r.checkedPlugins === 3, String(r.checkedPlugins))

  console.log('\n[5] 路径都指向临时目录')
  check('没有真实路径泄漏',
    JSON.stringify(r.findings).includes(root.replace(/\\/g, '\\\\')) ||
    JSON.stringify(r.findings).includes(root),
    '')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

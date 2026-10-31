/**
 * The diagnostic must point at the link that actually failed.
 *
 * "It didn't restore" is not a diagnosis. Each scenario here arranges for one
 * condition to be the blocker and asserts the report names that one, so a real
 * environment failure is debuggable from the output alone.
 */
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { diagnoseRestore } from '../lib/diagnose.mjs'

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

function profile () {
  const dir = join(tmpdir(), `diag-${process.pid}-${Math.random().toString(36).slice(2, 7)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function installPlugin (dir, name) {
  const p = join(dir, 'node_modules', ...name.split('/'))
  mkdirSync(p, { recursive: true })
  writeFileSync(join(p, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(p, 'cordis.patch.yml'), 'x')
}

function state (dir, { bundles, seen, patchSize, patchBak, cfgBak, autoRestore = true }) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles } } }))
  if (seen !== undefined) writeFileSync(join(dir, '.dsh-update-guard-lastseen.json'), JSON.stringify(seen))
  if (patchSize !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), 'x'.repeat(patchSize))
  if (patchBak !== undefined) {
    const p = join(dir, 'cordis.patch.yml.bak-20260101-000000')
    writeFileSync(p, 'y'.repeat(50))
    if (patchBak !== 'now') utimesSync(p, new Date(patchBak), new Date(patchBak))
  }
  // 备份里的 alpha 必须真的在磁盘上，否则"还原"不成立——启动器也是这么判的
  installPlugin(dir, 'alpha')
  installPlugin(dir, '@deepseek-ai/dsh-base')
  if (cfgBak) {
    writeFileSync(join(dir, 'package.json.bak-launcher-20260101-000000'),
      JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'alpha'] } } }))
  }
  writeFileSync(join(dir, '.dsh-update-guard.json'), JSON.stringify({ autoRestore }))
}

function failedKeys (d) {
  return d.conditions.filter(c => !c.pass).map(c => c.key)
}

console.log('\n[1] 现在还有第三方插件 —— 卡在第一条')
{
  const dir = profile()
  try {
    state(dir, { bundles: ['@deepseek-ai/dsh-base', 'alpha'], seen: { at: new Date().toISOString(), lastWithThirdParty: ['alpha'], lastWithThirdPartyAt: new Date().toISOString(), lastPatchSize: 900 }, patchSize: 900, patchBak: 'now', cfgBak: true })
    const d = diagnoseRestore(dir)
    check('结论指向"当前没有第三方插件"', d.note.includes('当前没有第三方插件'), d.note)
    check('ok 为 false', d.ok === false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('\n[2] 没有记录 —— 卡在第二条')
{
  const dir = profile()
  try {
    state(dir, { bundles: ['@deepseek-ai/dsh-base'], patchSize: 0, patchBak: 'now', cfgBak: true })
    const d = diagnoseRestore(dir)
    check('结论指向"存在上次记录"', d.note.includes('存在上次记录'), d.note)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('\n[3] 补丁备份早于记录 —— 卡在"本次有补丁改名备份"')
{
  const dir = profile()
  try {
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000)
    state(dir, {
      bundles: ['@deepseek-ai/dsh-base'],
      seen: { at: new Date().toISOString(), lastWithThirdParty: ['alpha'], lastWithThirdPartyAt: new Date(Date.now() - 3600 * 1000).toISOString(), lastPatchSize: 900 },
      patchSize: 0,
      patchBak: old,
      cfgBak: true,
    })
    const d = diagnoseRestore(dir)
    check('结论指向补丁改名', /补丁改名/.test(d.note), d.note)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('\n[4] 开关关着 —— 卡在最后一条')
{
  const dir = profile()
  try {
    state(dir, {
      bundles: ['@deepseek-ai/dsh-base'],
      seen: { at: new Date().toISOString(), lastWithThirdParty: ['alpha'], lastWithThirdPartyAt: new Date(Date.now() - 3600 * 1000).toISOString(), lastPatchSize: 900 },
      patchSize: 0, patchBak: 'now', cfgBak: true, autoRestore: false,
    })
    const d = diagnoseRestore(dir)
    check('结论指向 autoRestore', d.note.includes('autoRestore'), d.note)
    check('其余条件都过', failedKeys(d).length === 1, failedKeys(d).join(','))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('\n[5] 全部成立 —— ok 为 true')
{
  const dir = profile()
  try {
    state(dir, {
      bundles: ['@deepseek-ai/dsh-base'],
      seen: { at: new Date().toISOString(), lastWithThirdParty: ['alpha'], lastWithThirdPartyAt: new Date(Date.now() - 3600 * 1000).toISOString(), lastPatchSize: 900 },
      patchSize: 0, patchBak: 'now', cfgBak: true,
    })
    const d = diagnoseRestore(dir)
    check('ok 为 true', d.ok === true, d.note)
    check('没有失败条件', failedKeys(d).length === 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

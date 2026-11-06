/**
 * Surgical restore tests. Isolated temp profiles only.
 *
 * The behavior that matters: a reset must be undone WITHOUT reinstating the
 * plugin that caused it. Restoring everything is as wrong as restoring nothing.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { planRestore, applyRestore, validateBundle } from '../lib/restore.mjs'

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

function mkProfile () {
  const dir = join(tmpdir(), `guard-restore-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  return dir
}

function addPlugin (dir, name, { broken = false } = {}) {
  const d = join(dir, 'node_modules', ...name.split('/'))
  mkdirSync(d, { recursive: true })
  const manifest = { name, version: '1.0.0' }
  if (!broken) manifest.dsh = { bundle: { patch: './cordis.patch.yml' } }
  writeFileSync(join(d, 'package.json'), JSON.stringify(manifest))
  if (!broken) writeFileSync(join(d, 'cordis.patch.yml'), `- insert:\n    - id: ${name}\n      name: ${name}\n`)
}

function writeBundles (dir, bundles) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fake', private: true, dsh: { profile: { bundles } }, dependencies: {},
  }, null, 2))
}

console.log('\n[1] 结构校验')
{
  const dir = mkProfile()
  try {
    addPlugin(dir, 'ok-one')
    addPlugin(dir, 'no-dsh-field', { broken: true })
    writeFileSync(join(dir, 'node_modules', 'no-dsh-field', 'package.json'), JSON.stringify({ name: 'no-dsh-field' }))
    check('正常插件通过', validateBundle(dir, 'ok-one').ok)
    const r = validateBundle(dir, 'no-dsh-field')
    check('缺 dsh.bundle 被抓', !r.ok && /dsh\.bundle/.test(r.reason), r.reason)
    check('装了但没装 = 未安装', !validateBundle(dir, 'ghost').ok)
    check('官方包永远通过', validateBundle(dir, '@deepseek-ai/dsh-base').ok)
    check('路径穿越包名被拒绝', !validateBundle(dir, '../../outside').ok)
    const manifestPath = join(dir, 'node_modules', 'ok-one', 'package.json')
    writeFileSync(manifestPath, JSON.stringify({ name: 'ok-one', dsh: { bundle: { patch: '../outside.yml' } } }))
    const unsafePatch = validateBundle(dir, 'ok-one')
    check('越出插件目录的 patch 路径被拒绝', !unsafePatch.ok && /越出插件目录/.test(unsafePatch.reason), unsafePatch.reason)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('\n[2] 只恢复好的，跳过坏的')
{
  const dir = mkProfile()
  try {
    addPlugin(dir, 'good-a')
    addPlugin(dir, 'good-b')
    addPlugin(dir, 'bad-c', { broken: true })
    // 备份里曾有 4 个 bundle
    writeBundles(dir, ['@deepseek-ai/dsh-base', 'good-a', 'bad-c', 'good-b'])
    writeFileSync(join(dir, 'package.json.bak-launcher-20260101-000000'),
      JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'good-a', 'bad-c', 'good-b'] } } }, null, 2))
    // 现状被重置成只剩官方
    writeBundles(dir, ['@deepseek-ai/dsh-base'])

    const plan = planRestore(dir)
    check('可行动', plan.actionable)
    check('恢复 3 个（官方+2 好）', plan.wouldRestore.length === 3, plan.wouldRestore.join(','))
    check('跳过 bad-c', plan.dropped.length === 1 && plan.dropped[0].name === 'bad-c', JSON.stringify(plan.dropped))

    const res = applyRestore(dir, plan)
    const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dsh.profile.bundles
    check('已写入', res.applied)
    check('好插件回来了', after.includes('good-a') && after.includes('good-b'))
    check('坏插件没回来', !after.includes('bad-c'))
    check('官方还在', after.includes('@deepseek-ai/dsh-base'))
    check('原文件已备份', (res.backups ?? []).length >= 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('\n[3] patch 被重置时从备份恢复')
{
  const dir = mkProfile()
  try {
    addPlugin(dir, 'good-a')
    writeBundles(dir, ['@deepseek-ai/dsh-base', 'good-a'])
    writeFileSync(join(dir, 'package.json.bak-launcher-20260101-000000'),
      JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'good-a'] } } }))
    // 用户 patch 被自我修复改名，留下近空文件
    writeFileSync(join(dir, 'cordis.patch.yml'), '\n')
    writeFileSync(join(dir, 'cordis.patch.yml.bak-1700000000000'), '- id: rewind\n  disabled: true\n'.repeat(40))

    const plan = planRestore(dir)
    check('识别出 patch 需要还原', plan.patchBackup !== undefined, String(plan.patchBackup?.name))
    applyRestore(dir, plan)
    const size = readFileSync(join(dir, 'cordis.patch.yml')).length
    check('patch 已恢复成有内容', size > 500, `size=${size}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('\n[4] 没什么可恢复时不乱动')
{
  const dir = mkProfile()
  try {
    addPlugin(dir, 'only-one')
    writeBundles(dir, ['@deepseek-ai/dsh-base', 'only-one'])
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: x\n  disabled: false\n')
    const plan = planRestore(dir)
    check('不可行动', !plan.actionable)
    const before = readFileSync(join(dir, 'package.json'), 'utf8')
    const res = applyRestore(dir, plan)
    check('不写文件', !res.applied)
    check('内容未变', readFileSync(join(dir, 'package.json'), 'utf8') === before)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

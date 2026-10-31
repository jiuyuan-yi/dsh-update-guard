/**
 * The diagnostic must agree with the launcher, on every scenario.
 *
 * `diagnose.mjs` re-derives the restore decision in JavaScript while
 * `Restore-Surgical` implements it in PowerShell. Two implementations of one
 * rule drift. A diagnostic that disagrees with the thing it describes is worse
 * than no diagnostic — it tells you the system is fine while the launcher
 * declines to act, or the reverse.
 *
 * So: build a scenario, run the real generated script, and assert that
 * "restored" and "diagnose says all conditions pass" are the same answer.
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { ensureLauncher } from '../lib/launcher.mjs'
import { diagnoseRestore } from '../lib/diagnose.mjs'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

function hasPowerShell () {
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 20000, windowsHide: true })
    return true
  } catch { return false }
}
if (!hasPowerShell()) {
  console.log('SKIP: 当前环境没有可用的 Windows PowerShell，本组未执行')
  process.exit(0)
}

function harness () {
  const root = join(tmpdir(), `agree-${process.pid}-${Math.random().toString(36).slice(2, 7)}`)
  const pkg = join(root, 'pkg')
  const profile = join(root, 'profile')
  mkdirSync(join(profile, 'node_modules', '@deepseek-ai', 'dsh-base'), { recursive: true })
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(profile, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '1.0.0' }))
  const r = ensureLauncher({ profileDir: profile, pkgDir: pkg, manageShortcut: false })
  if (!r.ok) throw new Error('generation failed: ' + r.reason)
  return { root, pkg, profile, ps1Path: join(pkg, 'rescue', 'dsh-launch.ps1') }
}

function addPlugin (profile, name) {
  const dir = join(profile, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(dir, 'cordis.patch.yml'), 'x')
}

function launch (h) {
  try {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', h.ps1Path, '-NoStart'], {
      encoding: 'utf8', timeout: 60000, windowsHide: true,
      env: { ...process.env, DSH_LAUNCHER_PROFILE: h.profile, DSH_LAUNCHER_EXE: 'C:/Windows/System32/notepad.exe', DSH_LAUNCHER_QUIET: '1' },
    })
  } catch { /* 退出码不重要 */ }
}

function bundles (profile) {
  const raw = readFileSync(join(profile, 'package.json'), 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(raw).dsh.profile.bundles
}

/**
 * Run one scenario twice on identical fixture state: once through the real
 * launcher, once through the diagnostic, and compare the verdicts.
 */
function scenario (name, setup, expectRestore) {
  const h = harness()
  let restored
  let verdict
  try {
    setup(h)
    const before = JSON.stringify(bundles(h.profile))
    // 诊断要在启动之前取：启动之后状态已经变了，比较的就不是同一个现场
    verdict = diagnoseRestore(h.profile)
    launch(h)
    const after = bundles(h.profile)
    restored = JSON.stringify(after) !== before
  } finally { rmSync(h.root, { recursive: true, force: true }) }

  const agree = restored === verdict.ok
  check(`${name}：诊断与实际一致`, agree, `实际还原=${restored} 诊断=${verdict.ok}${verdict.ok ? '' : ' (' + verdict.note + ')'}`)
  if (expectRestore !== undefined) {
    check(`${name}：实际行为符合预期(${expectRestore})`, restored === expectRestore, `实际=${restored}`)
  }
}

const HOUR_AGO = () => new Date(Date.now() - 3600 * 1000).toISOString()

function base (h, opts = {}) {
  const { patchSize = 0, seenPatch = 900 } = opts
  writeFileSync(join(h.profile, 'package.json'),
    JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
  writeFileSync(join(h.profile, 'cordis.patch.yml'), 'x'.repeat(patchSize))
  writeFileSync(join(h.profile, '.dsh-update-guard.json'), JSON.stringify({ autoRestore: true }))
  writeFileSync(join(h.profile, '.dsh-update-guard-lastseen.json'), JSON.stringify({
    at: new Date().toISOString(),
    bundles: ['@deepseek-ai/dsh-base', 'alpha'],
    lastWithThirdParty: ['alpha'],
    lastWithThirdPartyAt: HOUR_AGO(),
    lastPatchSize: seenPatch,
  }))
  writeFileSync(join(h.profile, 'cordis.patch.yml.bak-20260101-000000'), 'y'.repeat(50))
  writeFileSync(join(h.profile, 'package.json.bak-launcher-20260101-000000'),
    JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'alpha'] } } }))
}

console.log('\n[1] 条件齐备 —— 两边都该还原')
scenario('条件齐备', h => { addPlugin(h.profile, 'alpha'); base(h) }, true)

console.log('\n[2] 插件文件已不在磁盘 —— 两边都不该还原')
scenario('插件缺失', h => { base(h) }, false)

console.log('\n[3] 补丁没变小 —— 两边都不该还原')
scenario('补丁未缩小', h => { addPlugin(h.profile, 'alpha'); base(h, { patchSize: 900, seenPatch: 900 }) }, false)

console.log('\n[4] 补丁备份早于记录 —— 两边都不该还原')
scenario('旧补丁备份', h => {
  addPlugin(h.profile, 'alpha')
  base(h)
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000)
  const bak = join(h.profile, 'cordis.patch.yml.bak-20260101-000000')
  utimesSync(bak, old, old)
}, false)

console.log('\n[5] 没有上次记录 —— 两边都不该还原')
scenario('无记录', h => {
  addPlugin(h.profile, 'alpha')
  base(h)
  rmSync(join(h.profile, '.dsh-update-guard-lastseen.json'), { force: true })
}, false)

console.log('\n[6] 开关关着 —— 两边都不该还原')
scenario('开关关闭', h => {
  addPlugin(h.profile, 'alpha')
  base(h)
  writeFileSync(join(h.profile, '.dsh-update-guard.json'), JSON.stringify({ autoRestore: false }))
}, false)

console.log('\n[7] 现在仍有第三方 —— 两边都不该还原')
scenario('仍有第三方', h => {
  addPlugin(h.profile, 'alpha')
  addPlugin(h.profile, 'beta')
  base(h)
  writeFileSync(join(h.profile, 'package.json'),
    JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'beta'] } } }))
}, false)

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

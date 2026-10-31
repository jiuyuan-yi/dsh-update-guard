/**
 * Full launch flow, driven against a fake application.
 *
 * The reviewer's third point: verify the whole sequence — normal start, failed
 * start, config reset, failed recovery, and starting again — not just isolated
 * functions. A fake "app" gives deterministic exit codes, and the launcher's own
 * env seams (profile / exe / args / answer) let us drive the real script.
 *
 * What this proves:
 *   - a healthy start exits 0 and records what it launched with
 *   - a failing start retries, then asks, and "no" leaves the config untouched
 *   - "yes" disables third-party plugins only as the last resort
 *   - a permanently broken app stops after the retry budget instead of looping
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { ensureLauncher } from '../lib/launcher.mjs'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const POWERSHELL = 'powershell.exe'

function hasPowerShell () {
  try {
    execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 20000 })
    return true
  } catch { return false }
}
if (!hasPowerShell()) {
  console.log('SKIP: 当前环境没有可用的 Windows PowerShell，本组未执行')
  process.exit(0)
}

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

function makeHarness () {
  const root = join(tmpdir(), `flow-${process.pid}-${Math.random().toString(36).slice(2, 7)}`)
  const pkg = join(root, 'pkg')
  const profile = join(root, 'profile')
  mkdirSync(join(profile, 'node_modules', '@deepseek-ai', 'dsh-base'), { recursive: true })
  mkdirSync(pkg, { recursive: true })
  const r = ensureLauncher({ profileDir: profile, pkgDir: pkg, manageShortcut: false })
  if (!r.ok) throw new Error('generation failed: ' + r.reason)

  // A uniquely named copy of powershell, so the "already running" check looks
  // for a process name that cannot collide with the launcher itself.
  const fakeApp = join(root, 'fakeapp.exe')
  const realPs = execFileSync('where', ['powershell'], { encoding: 'utf8' })
    .split(String.fromCharCode(10)).map(l => l.trim()).filter(Boolean)[0]
  copyFileSync(realPs, fakeApp)

  return { root, pkg, profile, fakeApp, ps1Path: join(pkg, 'rescue', 'dsh-launch.ps1') }
}

/** Run the launcher with the fake app configured to exit with `code`. */
function run (h, { exitCode = 0, answer = 'no', extra = [] } = {}) {
  const command = 'Start-Sleep -Milliseconds 50; exit ' + exitCode
  try {
    const out = execFileSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', h.ps1Path, ...extra], {
      encoding: 'utf8',
      timeout: 90000,
      env: {
        ...process.env,
        DSH_LAUNCHER_PROFILE: h.profile,
        DSH_LAUNCHER_EXE: h.fakeApp,
        DSH_LAUNCHER_ARGS: '-NoProfile -Command "' + command + '"',
        DSH_LAUNCHER_ANSWER: answer,
        DSH_LAUNCHER_QUIET: '1',
      },
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

function addPlugin (profile, name) {
  const dir = join(profile, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n    - id: ' + name + '\n      name: ' + name + '\n')
}

function seedProfile (profile) {
  addPlugin(profile, 'alpha')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'p', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'alpha'] } },
  }))
  writeFileSync(join(profile, 'cordis.patch.yml'), '- id: mine disabled: false '.repeat(20))
  writeFileSync(join(profile, '.dsh-update-guard.json'), JSON.stringify({
    autoRestore: true, autoLock: false, preflightOnStartup: false, installLauncher: false,
  }))
}

function bundles (profile) {
  return JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8').replace(/^\uFEFF/, '')).dsh.profile.bundles
}

console.log('\n[1] 正常启动 -> 退出 0 并记录清单')
{
  const h = makeHarness()
  try {
    seedProfile(h.profile)
    const r = run(h, { exitCode: 0 })
    check('启动器退出 0', r.code === 0, 'code=' + r.code)
    const seen = join(h.profile, '.dsh-update-guard-lastseen.json')
    check('记录了上次清单', existsSync(seen))
    if (existsSync(seen)) {
      const rec = JSON.parse(readFileSync(seen, 'utf8'))
      check('记录里含第三方插件', (rec.bundles ?? []).includes('alpha'), JSON.stringify(rec.bundles))
    }
    check('没有改动插件列表', bundles(h.profile).includes('alpha'))
  } finally { rmSync(h.root, { recursive: true, force: true }) }
}

console.log('\n[2] 启动失败 + 用户选“否” -> 不动配置')
{
  const h = makeHarness()
  try {
    seedProfile(h.profile)
    const cfgPath = join(h.profile, 'package.json')
    const before = readFileSync(cfgPath)
    const r = run(h, { exitCode: 3, answer: 'no' })
    const after = readFileSync(cfgPath)
    check('最终以失败退出', r.code !== 0, 'code=' + r.code)
    check('配置文件逐字节未变', Buffer.compare(before, after) === 0,
      before.length + ' -> ' + after.length + ' 字节')
    check('插件列表原样', bundles(h.profile).includes('alpha'), JSON.stringify(bundles(h.profile)))
    check('没有生成还原备份', !existsSync(join(h.profile, 'package.json.bak-restore-')) &&
      !readdirHas(h.profile, 'package.json.bak-launcher-'))
  } finally { rmSync(h.root, { recursive: true, force: true }) }
}

console.log('\n[3] 启动失败 + 用户选“是” -> 只在最后一步停用第三方')
{
  const h = makeHarness()
  try {
    seedProfile(h.profile)
    const r = run(h, { exitCode: 3, answer: 'yes' })
    const b = bundles(h.profile)
    check('第三方被停用', !b.includes('alpha'), JSON.stringify(b))
    check('官方保留', b.includes('@deepseek-ai/dsh-base'))
    check('留下了配置备份', readdirHas(h.profile, 'package.json.bak-launcher-'))
    check('退出码非 0', r.code !== 0, 'code=' + r.code)
  } finally { rmSync(h.root, { recursive: true, force: true }) }
}

console.log('\n[4] 恢复失败后再次启动 -> 不循环、不重复破坏')
{
  const h = makeHarness()
  try {
    seedProfile(h.profile)
    run(h, { exitCode: 3, answer: 'yes' })
    const afterFirst = bundles(h.profile)
    // 再启动一次：列表已经只剩官方，不应再产生新的破坏
    const r2 = run(h, { exitCode: 3, answer: 'yes' })
    const afterSecond = bundles(h.profile)
    check('第二次没有进一步改动', JSON.stringify(afterFirst) === JSON.stringify(afterSecond),
      JSON.stringify(afterSecond))
    check('仍然以失败退出', r2.code !== 0, 'code=' + r2.code)
    check('官方仍在', afterSecond.includes('@deepseek-ai/dsh-base'))
  } finally { rmSync(h.root, { recursive: true, force: true }) }
}

function readdirHas (dir, prefix) {
  try { return readdirSync(dir).some(f => f.startsWith(prefix)) } catch { return false }
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

/**
 * Repair and restore scenarios, executed against a real generated script.
 *
 * Unit tests on the JS side cannot prove the PowerShell recovery paths work.
 * These cases run `dsh-launch.ps1` itself, retargeted through the launcher's own
 * env overrides, so the code under test is the code that ships.
 *
 * Four situations must get four different answers:
 *   corrupt JSON      -> keep evidence, rebuild from what is on disk
 *   missing structure -> fill it in, keep the official bundles
 *   unreadable path   -> never guessed at
 *   valid but reset   -> restore, but only when the fingerprint says reset
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, utimesSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { ensureLauncher } from '../lib/launcher.mjs'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const NOTEPAD = 'C:/Windows/System32/notepad.exe'

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

function makeHarness () {
  const root = join(tmpdir(), `repair-${process.pid}-${Math.random().toString(36).slice(2, 7)}`)
  const pkg = join(root, 'pkg')
  const profile = join(root, 'profile')
  mkdirSync(join(profile, 'node_modules', '@deepseek-ai', 'dsh-base'), { recursive: true })
  mkdirSync(join(profile, 'node_modules', '@deepseek-ai', 'dsh-web-app'), { recursive: true })
  mkdirSync(pkg, { recursive: true })

  const r = ensureLauncher({ profileDir: profile, pkgDir: pkg, manageShortcut: false })
  if (!r.ok) throw new Error('launcher generation failed: ' + r.reason)

  return { root, pkg, profile, ps1Path: join(pkg, 'rescue', 'dsh-launch.ps1') }
}

function run (h, args = []) {
  try {
    return {
      code: 0,
      out: execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', h.ps1Path, ...args], {
        encoding: 'utf8',
        timeout: 60000,
        env: { ...process.env, DSH_LAUNCHER_PROFILE: h.profile, DSH_LAUNCHER_EXE: NOTEPAD },
      }),
    }
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

function readBundles (profile) {
  const raw = readFileSync(join(profile, 'package.json'), 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(raw).dsh.profile.bundles
}

function hasBackup (profile, prefix) {
  try { return readdirSync(profile).some(f => f.startsWith(prefix)) } catch { return false }
}

console.log('\n[1] package.json 内容损坏')
{
  const h = makeHarness()
  try {
    writeFileSync(join(h.profile, 'package.json'), '{ this is not json')
    const r = run(h, ['-Repair', '-NoStart'])
    check('脚本没有崩', !/Unhandled|ParserError/.test(r.out), r.out.slice(0, 100))
    let bundles
    try { bundles = readBundles(h.profile) } catch { bundles = undefined }
    check('配置被重建为合法 JSON', Array.isArray(bundles), String(bundles))
    check('用磁盘上的官方包填充',
      Array.isArray(bundles) && bundles.includes('@deepseek-ai/dsh-base'), JSON.stringify(bundles))
    check('原损坏文件留证', hasBackup(h.profile, 'package.json.bak-corrupt-'))
  } finally { rmSync(h.root, { recursive: true, force: true }) }
}

console.log('\n[2] 结构缺失（没有 dsh.profile）')
{
  const h = makeHarness()
  try {
    writeFileSync(join(h.profile, 'package.json'), JSON.stringify({ name: 'x' }))
    run(h, ['-Repair', '-NoStart'])
    const bundles = readBundles(h.profile)
    check('补出 dsh.profile.bundles', Array.isArray(bundles))
    check('含官方包', bundles.some(b => b.startsWith('@deepseek-ai/')), JSON.stringify(bundles))
  } finally { rmSync(h.root, { recursive: true, force: true }) }
}

console.log('\n[3] 路径读不出来（目录冒充文件）')
{
  const h = makeHarness()
  try {
    rmSync(join(h.profile, 'package.json'), { force: true })
    mkdirSync(join(h.profile, 'package.json'), { recursive: true })
    const r = run(h, ['-Repair', '-NoStart'])
    check('不抛未处理异常', !/Unhandled/.test(r.out), r.out.slice(0, 100))
  } finally { rmSync(h.root, { recursive: true, force: true }) }
}

console.log('\n[4] 用户主动精简 —— 不能自动还原')
{
  const h = makeHarness()
  try {
    addPlugin(h.profile, 'alpha')
    addPlugin(h.profile, 'beta')
    const bak = join(h.profile, 'package.json.bak-launcher-20200101-000000')
    writeFileSync(bak, JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'alpha', 'beta'] } } }))
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000)
    utimesSync(bak, old, old)
    writeFileSync(join(h.profile, 'package.json'),
      JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
    writeFileSync(join(h.profile, '.dsh-update-guard.json'), JSON.stringify({ autoRestore: true }))

    run(h, ['-NoStart'])
    const bundles = readBundles(h.profile)
    check('没有擅自恢复', !bundles.includes('alpha'), JSON.stringify(bundles))
  } finally { rmSync(h.root, { recursive: true, force: true }) }
}

console.log('\n[5] 被重置（配置与备份同时写入）—— 应当还原')
{
  const h = makeHarness()
  try {
    addPlugin(h.profile, 'alpha')
    addPlugin(h.profile, 'beta')
    const bak = join(h.profile, 'package.json.bak-launcher-20260101-000000')
    writeFileSync(bak, JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'alpha', 'beta'] } } }))
    writeFileSync(join(h.profile, 'package.json'),
      JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
    // 补丁层同时被改名、当前补丁只剩空壳 —— 这才是"被重置"的完整指纹
    writeFileSync(join(h.profile, 'cordis.patch.yml'), '')
    writeFileSync(join(h.profile, 'cordis.patch.yml.bak-20260101-000000'), '- id: alpha disabled: false '.repeat(20))
    writeFileSync(join(h.profile, '.dsh-update-guard.json'), JSON.stringify({ autoRestore: true }))

    run(h, ['-NoStart'])
    const bundles = readBundles(h.profile)
    check('恢复了第三方插件', bundles.includes('alpha'), JSON.stringify(bundles))
    check('官方还在', bundles.includes('@deepseek-ai/dsh-base'))
  } finally { rmSync(h.root, { recursive: true, force: true }) }
}

console.log('')
console.log('[6] 主动删光全部第三方 + 近期备份，但没有补丁层证据 —— 不能自动恢复')
{
  const h = makeHarness()
  try {
    addPlugin(h.profile, 'alpha')
    addPlugin(h.profile, 'beta')
    const bak = join(h.profile, 'package.json.bak-launcher-20260101-000000')
    writeFileSync(bak, JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'alpha', 'beta'] } } }))
    // 与当前配置同一秒写入：仅凭时间无法和"被重置"区分
    writeFileSync(join(h.profile, 'package.json'),
      JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
    // 补丁文件完好且内容正常：说明没有人动过补丁层
    writeFileSync(join(h.profile, 'cordis.patch.yml'), '- id: mine disabled: false '.repeat(30))
    writeFileSync(join(h.profile, '.dsh-update-guard.json'), JSON.stringify({ autoRestore: true }))

    run(h, ['-NoStart'])
    const bundles = readBundles(h.profile)
    check('没有自动恢复', !bundles.includes('alpha'), JSON.stringify(bundles))
    check('配置保持官方-only', bundles.length === 1, JSON.stringify(bundles))
  } finally { rmSync(h.root, { recursive: true, force: true }) }
}

console.log('')
console.log('[7] 结构缺失时，不相关的自定义字段必须保留')
{
  const h = makeHarness()
  try {
    writeFileSync(join(h.profile, 'package.json'), JSON.stringify({
      name: 'my-profile',
      myCustomSetting: { keepMe: 42 },
      dsh: { somethingElse: true },
    }))
    run(h, ['-Repair', '-NoStart'])
    const after = JSON.parse(readFileSync(join(h.profile, 'package.json'), 'utf8').replace(/^﻿/, ''))
    check('顶层自定义字段还在', after.myCustomSetting?.keepMe === 42, JSON.stringify(after.myCustomSetting))
    check('dsh 下的其它字段还在', after.dsh?.somethingElse === true)
    check('补出了 bundles', Array.isArray(after.dsh?.profile?.bundles))
  } finally { rmSync(h.root, { recursive: true, force: true }) }
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

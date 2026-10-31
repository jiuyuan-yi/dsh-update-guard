/**
 * End-to-end test for dsh-update-guard on an ISOLATED fake profile.
 *
 * Proves:
 *   A. a plugin referencing a removed member is detected
 *   B. a plugin referencing existing members produces no false positive
 *   C. `lock` disables exactly that plugin's declared ids, nothing else
 *   D. `unlock` restores the patch byte-for-byte
 *
 * The real profile is never touched: the test copies its config into a temp
 * directory and passes --profile.
 */
import { mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join as joinPath } from 'node:path'
import { findInstallRoot } from '../lib/installer.mjs'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const GUARD = joinPath(PKG, 'bin', 'guard.mjs')

// The install root only matters because the surface has to be extracted from a
// downloaded installer. Nothing here may point at one particular machine.
const ROOT = process.env.DSH_DESKTOP_ROOT ?? findInstallRoot()
if (ROOT === undefined) {
  console.log('SKIP: 找不到 DSH 安装目录（设 DSH_DESKTOP_ROOT 可指定），跳过需要解包的检查')
  process.exit(0)
}

// A stand-in for "the user's existing patch file". Fabricated on purpose: a test
// must never read somebody's real config, and must never need their machine.
const PATCH_ORIGINAL = [
  '# 用户自己的条目，锁定时必须原样保留',
  '- id: user-plugin-a',
  '  disabled: false',
  '',
  '- id: user-plugin-b',
  '  disabled: true',
  '',
  '- insert:',
  '    - id: user-plugin-c',
  '      name: some-package',
  '',
].join('\n')

const work = join(tmpdir(), `guard-test-${process.pid}`)
const profile = join(work, 'profile')
const nm = join(profile, 'node_modules')

function sha (p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

function run (args) {
  try {
    const out = execFileSync(process.execPath, [GUARD, ...args], {
      encoding: 'utf8', timeout: 420000, windowsHide: true,
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

try {
  // ---------------------------------------------------------------- setup
  mkdirSync(nm, { recursive: true })
  writeFileSync(join(profile, 'cordis.patch.yml'), PATCH_ORIGINAL)

  const pkg = {
    name: 'fake-profile',
    private: true,
    dsh: {
      profile: {
        bundles: [
          'dsh-fixture-bad',
          'dsh-fixture-good',
          'dsh-fixture-multi',
        ],
      },
    },
    dependencies: {},
  }
  writeFileSync(join(profile, 'package.json'), JSON.stringify(pkg, null, 2))

  // BAD: calls a member rc.5 does not export
  const badDir = join(nm, 'dsh-fixture-bad')
  mkdirSync(join(badDir, 'lib'), { recursive: true })
  writeFileSync(join(badDir, 'package.json'), JSON.stringify({ name: 'dsh-fixture-bad', version: '1.0.0' }))
  writeFileSync(join(badDir, 'cordis.patch.yml'), '- insert:\n    - id: fixture-bad\n      name: dsh-fixture-bad\n')
  writeFileSync(join(badDir, 'lib', 'client.js'),
    "var UiPrimitives = require('@deepseek-ai/dsh-client-ui-primitives')\n" +
    "module.exports = { r: () => UiPrimitives.projectUserText('x', []) }\n")

  // GOOD: only existing members, and a NON-default local name (tests binding resolution)
  const goodDir = join(nm, 'dsh-fixture-good')
  mkdirSync(join(goodDir, 'lib'), { recursive: true })
  writeFileSync(join(goodDir, 'package.json'), JSON.stringify({ name: 'dsh-fixture-good', version: '1.0.0' }))
  writeFileSync(join(goodDir, 'cordis.patch.yml'), '- insert:\n    - id: fixture-good\n      name: dsh-fixture-good\n')
  writeFileSync(join(goodDir, 'lib', 'client.js'),
    "var PRIM = require('@deepseek-ai/dsh-client-ui-primitives')\n" +
    "module.exports = { r: () => PRIM.Tooltip({}) }\n")

  // MULTI: one package declaring two ids, both must be locked
  const multiDir = join(nm, 'dsh-fixture-multi')
  mkdirSync(join(multiDir, 'lib'), { recursive: true })
  writeFileSync(join(multiDir, 'package.json'), JSON.stringify({ name: 'dsh-fixture-multi', version: '1.0.0' }))
  writeFileSync(join(multiDir, 'cordis.patch.yml'),
    '- insert:\n    - id: fixture-multi-a\n      name: dsh-fixture-multi\n' +
    '- insert:\n    - id: fixture-multi-b\n      name: dsh-fixture-multi\n')
  writeFileSync(join(multiDir, 'lib', 'client.js'),
    "const { JsonBlock } = require('@deepseek-ai/dsh-client-ui-primitives')\n" +
    "var Q = require('@deepseek-ai/dsh-client-ui-primitives')\n" +
    "module.exports = { a: () => JsonBlock({}), b: () => Q.notARealMember({}) }\n")

  const patchBefore = join(profile, 'cordis.patch.yml')
  const hashBefore = sha(patchBefore)

  // ---------------------------------------------------------------- A/B: check
  console.log('\n[A/B] check on isolated profile')
  const r1 = run(['check', '--profile', profile, '--root', ROOT, '--json'])
  let parsed
  try { parsed = JSON.parse(r1.out.slice(r1.out.indexOf('{'))) } catch { parsed = undefined }
  check('check 返回 JSON', parsed !== undefined, r1.out.slice(0, 120))
  if (parsed) {
    const names = parsed.findings.map(f => f.plugin)
    check('检出 dsh-fixture-bad', names.includes('dsh-fixture-bad'))
    check('检出 dsh-fixture-multi', names.includes('dsh-fixture-multi'))
    check('未误报 dsh-fixture-good', !names.includes('dsh-fixture-good'),
      `findings=${names.join(',') || '(none)'}`)
    const bad = parsed.findings.find(f => f.plugin === 'dsh-fixture-bad')
    check('缺失成员是 projectUserText',
      bad?.broken.some(b => b.missing.includes('projectUserText')))
    const multi = parsed.findings.find(f => f.plugin === 'dsh-fixture-multi')
    check('multi 检出 notARealMember 而非 JsonBlock',
      multi?.broken.some(b => b.missing.includes('notARealMember')) &&
      !multi?.broken.some(b => b.missing.includes('JsonBlock')))
  }
  check('check 不改动 patch', sha(patchBefore) === hashBefore)

  // ---------------------------------------------------------------- C: lock
  console.log('\n[C] lock')
  const r2 = run(['lock', '--profile', profile, '--root', ROOT, '--json'])
  let lockRes
  try { lockRes = JSON.parse(r2.out.slice(r2.out.indexOf('{'))) } catch { lockRes = undefined }
  check('lock 返回 JSON', lockRes !== undefined, r2.out.slice(0, 120))

  const afterLock = readFileSync(patchBefore, 'utf8')
  check('fixture-bad 的 id 已禁用', /- id: fixture-bad\s*\r?\n\s*disabled: true/.test(afterLock))
  check('fixture-multi 的 a 已禁用', /- id: fixture-multi-a\s*\r?\n\s*disabled: true/.test(afterLock))
  check('fixture-multi 的 b 已禁用', /- id: fixture-multi-b\s*\r?\n\s*disabled: true/.test(afterLock))
  check('fixture-good 未被禁用', !/- id: fixture-good[\s\S]{0,60}?disabled: true/.test(afterLock))

  // the user's own existing entries must be untouched
  const origLines = PATCH_ORIGINAL.split(/\r?\n/)
  const nowLines = afterLock.split(/\r?\n/)
  const removed = origLines.filter(l => l.trim() !== '' && !nowLines.includes(l))
  check('原有 patch 行全部保留', removed.length === 0,
    removed.length ? `丢失: ${removed.slice(0, 3).join(' | ')}` : '')

  // ---------------------------------------------------------------- D: unlock
  console.log('\n[D] unlock')
  const r3 = run(['unlock', '--profile', profile, '--json'])
  check('unlock 退出码 0', r3.code === 0)
  const afterUnlock = sha(patchBefore)
  check('unlock 后 patch 与原始逐字节一致', afterUnlock === hashBefore,
    afterUnlock === hashBefore ? '' : '哈希不同')

  if (afterUnlock !== hashBefore) {
    const a = PATCH_ORIGINAL.split(/\r?\n/)
    const b = readFileSync(patchBefore, 'utf8').split(/\r?\n/)
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) { console.log(`    line ${i + 1}: orig=${JSON.stringify(a[i])} now=${JSON.stringify(b[i])}`); break }
    }
  }

  console.log('')
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
} finally {
  try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }
}

process.exit(failures === 0 ? 0 : 1)

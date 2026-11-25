/**
 * Launch-target selection.
 *
 * The regression this pins down (2026-11-25): the app lives in a directory-mode
 * install with `app-update.yml` renamed to `.disabled`. Root detection demanded
 * that exact file, failed, and the generator fell back to `process.execPath` —
 * node.exe under the CLI. The wrapper then started DSH out of the node directory,
 * where `resources\runtime` does not exist, and refused to start with "runtime is
 * incomplete" while the real runtime was perfectly intact.
 *
 * Rules:
 *   - an explicit exe is honoured,
 *   - a non-node host (the desktop app itself) is its own target,
 *   - with no discoverable install, generation REFUSES; it never invents a target.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ensureLauncher, resolveDesktopExe } from '../lib/launcher.mjs'
import { isInstallRoot } from '../lib/installer.mjs'

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

console.log('\n[1] isInstallRoot 接受目录模式安装')
{
  const dir = mkdtempSync(join(tmpdir(), 'ug-root-'))
  try {
    check('空目录不算安装根', isInstallRoot(dir) === false)
    // resources/ + app directory = a directory-mode install (no app-update.yml).
    mkdirSync(join(dir, 'resources', 'app'), { recursive: true })
    check('resources/app 目录即可识别', isInstallRoot(dir) === true)
    check('不存在的路径不抛', isInstallRoot(join(dir, 'nope')) === false)
    check('undefined 不抛', isInstallRoot(undefined) === false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n[2] 启动目标：node.exe 绝不当作目标')
{
  // CLI shape: the process is node.exe and no install can be found.
  check('无安装根时返回 undefined',
    resolveDesktopExe(undefined, { execPath: 'C:/Program Files/nodejs/node.exe', root: undefined, exists: () => false }) === undefined,
    String(resolveDesktopExe(undefined, { execPath: 'C:/Program Files/nodejs/node.exe', root: undefined, exists: () => false })))

  // Desktop shape: the running executable IS the target.
  check('非 node 直接返回自身',
    resolveDesktopExe(undefined, { execPath: 'D:/app/DeepSeek Harness.exe', root: undefined }) === 'D:/app/DeepSeek Harness.exe')

  check('显式目标优先',
    resolveDesktopExe('X:/a/b.exe', { execPath: 'C:/node.exe' }) === 'X:/a/b.exe')

  const dir = mkdtempSync(join(tmpdir(), 'ug-pick-'))
  try {
    writeFileSync(join(dir, 'small.exe'), '1')
    writeFileSync(join(dir, 'DeepSeek Harness.exe'), '1234567890')
    writeFileSync(join(dir, 'Uninstall DeepSeek Harness.exe'), '12345678901234567890')
    check('选最大的非卸载 exe',
      resolveDesktopExe(undefined, { execPath: 'C:/node.exe', root: dir }) === join(dir, 'DeepSeek Harness.exe'),
      String(resolveDesktopExe(undefined, { execPath: 'C:/node.exe', root: dir })))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n[2b] 没有可发现目标时 ensureLauncher 不生成任何文件')
{
  const dir = mkdtempSync(join(tmpdir(), 'ug-target-'))
  try {
    mkdirSync(join(dir, 'profile'), { recursive: true })
    // `pkgDir` only; no exePath, and resolveDesktopExe is driven by the real
    // environment here, so skip when this machine does have an install.
    const r = ensureLauncher({
      pkgDir: join(dir, 'pkg'),
      profileDir: join(dir, 'profile'),
      manageShortcut: false,
    })
    if (r.ok === true) {
      // A real install exists on this machine; the picker test above is the
      // authoritative check for the node.exe case.
      console.log('  （本机能找到安装根，跳过"拒绝生成"断言）')
      check('生成的目标不是 node.exe', !/node\.exe$/i.test(JSON.parse(readFileSync(join(dir, 'pkg', 'rescue', '.generated.json'), 'utf8')).exe))
    } else {
      check('拒绝生成', r.reason === 'missing-inputs', String(r.reason))
      check('没有生成 ps1', !existsSync(join(dir, 'pkg', 'rescue', 'dsh-launch.ps1')))
      check('没有生成 vbs', !existsSync(join(dir, 'pkg', 'rescue', 'dsh-launch.vbs')))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n[3] 显式目标照常生成，并写进 stamp')
{
  const dir = mkdtempSync(join(tmpdir(), 'ug-target2-'))
  try {
    mkdirSync(join(dir, 'profile'), { recursive: true })
    const fakeExe = join(dir, 'Fake Harness.exe')
    writeFileSync(fakeExe, '')
    const r = ensureLauncher({
      exePath: fakeExe,
      pkgDir: join(dir, 'pkg'),
      profileDir: join(dir, 'profile'),
      manageShortcut: false,
    })
    check('生成成功', r.ok === true, JSON.stringify(r.reason ?? ''))
    const stampPath = join(dir, 'pkg', 'rescue', '.generated.json')
    check('stamp 存在', existsSync(stampPath))
    if (existsSync(stampPath)) {
      const stamp = JSON.parse(readFileSync(stampPath, 'utf8'))
      check('目标就是传入的 exe', stamp.exe === fakeExe, String(stamp.exe))
      check('没有退回 node.exe', !/node\.exe$/i.test(stamp.exe), String(stamp.exe))
      check('记录生成器版本', typeof stamp.generator === 'number' && stamp.generator >= 3, String(stamp.generator))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

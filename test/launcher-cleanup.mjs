/**
 * Launcher cleanup tests.
 *
 * The property: turning the feature off must return the machine to its previous
 * state. A shortcut left pointing at a wrapper nobody maintains is the failure
 * this exists to prevent.
 */
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launcherState, removeLauncher } from '../lib/launcher.mjs'

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

function makePkg () {
  const pkg = join(tmpdir(), `launcher-${process.pid}-${Math.random().toString(36).slice(2, 7)}`)
  const rescue = join(pkg, 'rescue')
  mkdirSync(rescue, { recursive: true })
  for (const f of ['dsh-launch.ps1', 'dsh-launch.cmd', 'dsh-launch.vbs']) {
    writeFileSync(join(rescue, f), 'x')
  }
  writeFileSync(join(rescue, '.generated.json'), JSON.stringify({
    exe: 'C:\app\Demo.exe',
    profileDir: 'C:\p',
    pkgDir: pkg,
    shortcut: join(pkg, 'Demo.lnk'),
  }))
  return pkg
}

console.log('\n[1] 状态能读出来')
{
  const pkg = makePkg()
  try {
    const st = launcherState({ pkgDir: pkg })
    check('判定为已生成', st.generated)
    check('列出三个文件', st.files.length === 3, String(st.files.length))
  } finally { rmSync(pkg, { recursive: true, force: true }) }
}

console.log('\n[2] 预演不删任何东西')
{
  const pkg = makePkg()
  try {
    const before = launcherState({ pkgDir: pkg }).files.length
    const r = removeLauncher({ pkgDir: pkg, manageShortcut: false, dryRun: true })
    check('标记为预演', r.dryRun)
    check('列出了计划删除', r.removed.length === before)
    check('文件还在', launcherState({ pkgDir: pkg }).files.length === before)
  } finally { rmSync(pkg, { recursive: true, force: true }) }
}

console.log('\n[3] 真执行会清干净')
{
  const pkg = makePkg()
  try {
    const r = removeLauncher({ pkgDir: pkg, manageShortcut: false })
    check('删除三个文件', r.removed.length === 3, String(r.removed.length))
    check('文件已不在', !existsSync(join(pkg, 'rescue', 'dsh-launch.ps1')))
    check('stamp 已清', !existsSync(join(pkg, 'rescue', '.generated.json')))
    check('状态变为未生成', launcherState({ pkgDir: pkg }).generated === false)
  } finally { rmSync(pkg, { recursive: true, force: true }) }
}

console.log('\n[4] 没装过时如实说，不动手')
{
  const pkg = join(tmpdir(), `launcher-empty-${process.pid}`)
  mkdirSync(pkg, { recursive: true })
  try {
    const r = removeLauncher({ pkgDir: pkg, manageShortcut: false })
    check('返回说明', typeof r.note === 'string' && r.note.length > 0, r.note)
    check('没有删任何东西', r.removed.length === 0)
  } finally { rmSync(pkg, { recursive: true, force: true }) }
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

/**
 * State snapshots: a description of the machine, plus an honest diff.
 *
 * The diff is what has to be right. A snapshot that silently misses a removed
 * plugin, or reports a config change that did not happen, is worse than no
 * snapshot: the user reads it while reconstructing a broken profile.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { captureState, diffStates, readState, writeState, listStates, STATE_SCHEMA } from '../lib/state-snapshot.mjs'

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

const work = mkdtempSync(join(tmpdir(), 'ug-state-'))
try {
  const profileDir = join(work, 'profile')
  const pkgDir = join(work, 'pkg')

  function seed (version, extraPlugin) {
    rmSync(profileDir, { recursive: true, force: true })
    mkdirSync(join(profileDir, 'node_modules', 'local-plugin'), { recursive: true })
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'desktop',
      dsh: { profile: { bundles: ['local-plugin'] } },
    }))
    writeFileSync(join(profileDir, 'node_modules', 'local-plugin', 'package.json'),
      JSON.stringify({ name: 'local-plugin', version }))
    writeFileSync(join(profileDir, '.dsh-update-guard.json'), JSON.stringify({
      autoLock: false, autoRestore: true, preflightOnStartup: true, installLauncher: false,
    }))
    if (extraPlugin) {
      const d = join(profileDir, 'node_modules', extraPlugin)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'package.json'), JSON.stringify({ name: extraPlugin, version: '1.0.0' }))
      const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
      pkg.dsh.profile.bundles.push(extraPlugin)
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify(pkg))
    }
  }

  console.log('\n[1] 采集')
  seed('1.0.0', null)
  const before = captureState({ profileDir, pkgDir, note: 'pre-update' })
  check('schema 版本', before.schemaVersion === STATE_SCHEMA)
  check('记录 note', before.note === 'pre-update')
  check('记录 bundles', JSON.stringify(before.profile.bundles) === JSON.stringify(['local-plugin']))
  check('记录插件版本', before.plugins.find(p => p.name === 'local-plugin')?.version === '1.0.0')
  check('记录配置', before.guard.config.autoRestore === true)
  check('没有 runtime 基线时为 null', before.runtime === null)
  check('没有报告时 pending 为 null', before.pending === null)
  check('DSH 版本来自 opts 或 unknown', typeof before.dsh.version === 'string')

  console.log('\n[2] 落盘与列表')
  const path = writeState(pkgDir, before)
  check('文件已写', existsSync(path))
  const rows = listStates(pkgDir)
  check('列表包含它', rows.some(r => r.file === path && r.note === 'pre-update'), JSON.stringify(rows.map(r => r.note)))
  check('能读回', readState(path).note === 'pre-update')

  const badPath = join(pkgDir, '.cache', 'snapshots', 'state-bad.json')
  writeFileSync(badPath, JSON.stringify({ schemaVersion: 99 }))
  let threw = false
  try { readState(badPath) } catch { threw = true }
  check('拒绝未知 schema', threw)

  console.log('\n[3] 差异：插件版本与新增')
  seed('2.0.0', 'second-plugin')
  const after = captureState({ profileDir, pkgDir, note: 'post-update' })
  const d = diffStates(before, after)
  const changed = d.plugins.find(p => p.name === 'local-plugin')
  check('版本变化被记录', changed?.change === 'version' && changed.before === '1.0.0' && changed.after === '2.0.0',
    JSON.stringify(changed))
  const added = d.plugins.find(p => p.name === 'second-plugin')
  check('新增被记录', added?.change === 'added', JSON.stringify(added))
  check('bundles 新增被记录', d.bundles.added.includes('second-plugin'), JSON.stringify(d.bundles.added))

  console.log('\n[4] 差异：配置变化')
  writeFileSync(join(profileDir, '.dsh-update-guard.json'), JSON.stringify({
    autoLock: true, autoRestore: true, preflightOnStartup: true, installLauncher: false,
  }))
  const after2 = captureState({ profileDir, pkgDir })
  const d2 = diffStates(after, after2)
  check('只报告真正变化的键', d2.config.length === 1 && d2.config[0].key === 'autoLock',
    JSON.stringify(d2.config))
  check('变化前后值正确', d2.config[0].before === false && d2.config[0].after === true, JSON.stringify(d2.config[0]))

  console.log('\n[5] 自比对为空')
  const same = diffStates(after2, after2)
  check('无插件差异', same.plugins.length === 0)
  check('无配置差异', same.config.length === 0)
  check('无 bundles 差异', same.bundles.added.length === 0 && same.bundles.removed.length === 0)

  console.log('\n[6] 缺 profile 不抛')
  let captureThrew
  try { captureState({ profileDir: join(work, 'missing'), pkgDir }) } catch (e) { captureThrew = e }
  check('不抛错', captureThrew === undefined, captureThrew ? String(captureThrew.message) : '')
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

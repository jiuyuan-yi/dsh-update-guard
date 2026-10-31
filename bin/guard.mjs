#!/usr/bin/env node
/**
 * dsh-update-guard — CLI. Thin shell over lib/run.mjs so the command line and
 * the host plugin can never disagree about what "safe to update" means.
 *
 *   check    report only, never writes
 *   lock     disable exactly the entry ids of the plugins that would break
 *   unlock   undo every change this tool recorded
 *   status   pending update / installed plugins / guarded ids
 *   config   show or set the guard config read by the host plugin
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  analyse, lockFromAnalysis, unlockAll, readConfig, writeConfig, defaultProfileDir, saveReport,
} from '../lib/run.mjs'
import { planRestore, applyRestore } from '../lib/restore.mjs'
import { basename } from 'node:path'
import { launcherState, removeLauncher } from '../lib/launcher.mjs'

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const CACHE_ROOT = join(PKG_DIR, '.cache')

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'check'
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? def : argv[i + 1]
}
const flag = (name) => argv.includes(`--${name}`)
const asJson = flag('json')
const profileDir = opt('profile', defaultProfileDir())
const installRoot = opt('root', undefined)

function out (r) {
  if (asJson) console.log(JSON.stringify(r, null, 2))
  return r
}

function fail (message, extra = {}) {
  if (asJson) console.log(JSON.stringify({ ok: false, error: message, ...extra }))
  else console.error(`\n[!] ${message}\n`)
  process.exit(1)
}

const ANALYSE_OPTS = {
  profileDir,
  installRoot,
  cacheRoot: CACHE_ROOT,
  keepTemp: flag('keep-temp'),
  force: flag('force'),
}

// ---------------------------------------------------------------- commands
if (cmd === 'check') {
  const r = analyse(ANALYSE_OPTS)
  if (r.stage === 'error') fail(explain(r), r)
  // Also publish the result the settings panel reads, so a manual check shows
  // up there without waiting for the next startup pass.
  if (r.stage === 'analysed') {
    try { saveReport(CACHE_ROOT, r) } catch { /* panel just keeps the old one */ }
  }
  if (asJson) out(r)
  else printReport(r)
  process.exit(r.stage === 'analysed' && r.findings.length > 0 ? 2 : 0)
} else if (cmd === 'lock') {
  const r = analyse(ANALYSE_OPTS)
  if (r.stage === 'error') fail(explain(r), r)
  if (r.stage !== 'analysed' || r.findings.length === 0) {
    if (asJson) out({ ok: true, locked: [], skipped: [] })
    else printReport(r)
    process.exit(0)
  }
  const allIds = r.findings.flatMap(f => f.ids)
  if (allIds.length === 0) fail('这些插件没有声明任何配置 id，无法安全锁定')
  const result = lockFromAnalysis(r, Infinity)
  if (asJson) out({ ok: true, ...result })
  else printLock(r, result)
} else if (cmd === 'unlock') {
  const result = unlockAll(profileDir)
  if (asJson) out({ ok: true, ...result })
  else {
    console.log('\n=== 已撤销锁定 ===\n')
    if (result.restored.length === 0) console.log('没有需要撤销的锁定。')
    else result.restored.forEach(id => console.log(`  ✓ ${id} 已恢复`))
    if (result.missing.length > 0) console.log(`\n  未找到对应块，未改动: ${result.missing.join(', ')}`)
    console.log('\n重启应用后生效。\n')
  }
} else if (cmd === 'restore') {
  const plan = planRestore(profileDir)
  if (asJson) {
    if (flag('apply')) out({ ok: true, plan, result: applyRestore(profileDir, plan) })
    else out({ ok: true, plan })
  } else {
    console.log('\n=== 配置还原 ===\n')
    console.log(`当前 bundle 数: ${plan.currentCount}`)
    if (plan.source === undefined) console.log('可用备份     : 无')
    else console.log(`使用备份     : ${plan.source.name}`)
    if (plan.patchBackup !== undefined) console.log(`补丁层备份   : ${plan.patchBackup.name}`)
    console.log('')
    if (!plan.actionable) {
      console.log('结论：没有需要还原的内容。\n')
      process.exit(0)
    }
    console.log(`将恢复 ${plan.wouldRestore.length} 个 bundle：`)
    for (const b of plan.wouldRestore) console.log(`  + ${b}`)
    if (plan.dropped.length > 0) {
      console.log(`\n将跳过 ${plan.dropped.length} 个（有问题，恢复会重新弄坏）：`)
      for (const d of plan.dropped) console.log(`  - ${d.name}    ${d.reason}`)
    }
    if (flag('apply')) {
      const res = applyRestore(profileDir, plan)
      console.log(`\n已写入。bundle 数: ${res.bundles}`)
      if (res.patchRestoredFrom) console.log(`补丁层已从 ${res.patchRestoredFrom} 恢复`)
      console.log(`原文件备份: ${(res.backups ?? []).map(p => p.split(/[\\/]/).pop()).join(', ')}`)
      console.log('\n重启应用后生效。\n')
    } else {
      console.log('\n这是预演，没有改动任何文件。要执行：')
      console.log(`    node "${join(PKG_DIR, 'bin', 'guard.mjs')}" restore --apply\n`)
      process.exit(2)
    }
  }
} else if (cmd === 'launcher') {
  // 位置参数：argv = [命令, 子命令, ...]，跳过 --开头的选项
  const action = (argv.slice(1).find(a => !a.startsWith('--')) ?? 'status')
  if (action === 'status') {
    const st = launcherState({ pkgDir: PKG_DIR })
    if (asJson) out({ ok: true, state: st })
    else {
      console.log('')
      console.log('=== 启动器状态 ===')
      console.log('')
      console.log('  已生成      : ' + (st.generated ? '是' : '否'))
      console.log('  快捷方式    : ' + (st.shortcut ?? '(未接管)'))
      console.log('  当前指向    : ' + (st.target ?? '(未知)'))
      console.log('  生成的文件  : ' + (st.files.length ? st.files.map(f => basename(f)).join(', ') : '无'))
      console.log('  快捷方式备份: ' + st.backupCount + ' 份')
      console.log('')
    }
    process.exit(0)
  }
  if (action === 'restore' || action === 'uninstall') {
    const dry = flag('dry-run')
    const r = removeLauncher({ pkgDir: PKG_DIR, dryRun: dry })
    if (asJson) out({ ok: true, result: r })
    else {
      console.log('')
      console.log('=== ' + (dry ? '预演：' : '') + '撤销启动器 ===')
      console.log('')
      if (r.note) console.log('  ' + r.note)
      if (r.restoredShortcut) console.log(dry ? '  快捷方式  : 将指回应用主程序' : '  快捷方式  : 已指回应用主程序')
      if (r.removed.length) r.removed.forEach(f => console.log('  已删除    : ' + basename(f)))
      if (!dry && action === 'uninstall') {
        const cfg = readConfig(profileDir)
        writeConfig(profileDir, { ...cfg, installLauncher: false })
        console.log('  配置      : installLauncher = false')
      }
      if (dry) console.log('  这是预演，没有改动任何文件。要执行请去掉 --dry-run。')
      console.log('')
    }
    process.exit(0)
  }
  fail('未知子命令: ' + action + '（可用 status / restore / uninstall）')
} else if (cmd === 'config') {
  const key = opt('set')
  if (key === undefined) {
    const c = readConfig(profileDir)
    if (asJson) out({ ok: true, config: c })
    else {
      console.log('\n=== 配置 ===\n')
      for (const [k, v] of Object.entries(c)) console.log(`  ${k.padEnd(20)} ${JSON.stringify(v)}`)
      console.log(`\n文件: ${join(profileDir, '.dsh-update-guard.json')}\n`)
    }
  } else {
    const value = opt('value')
    const c = readConfig(profileDir)
    if (!(key in c)) fail(`未知配置项: ${key}`)
    let parsed = value
    if (value === 'true') parsed = true
    else if (value === 'false') parsed = false
    else if (/^\d+$/.test(value ?? '')) parsed = Number(value)
    c[key] = parsed
    const p = writeConfig(profileDir, c)
    if (asJson) out({ ok: true, config: c, path: p })
    else console.log(`已保存 ${key} = ${JSON.stringify(parsed)}\n${p}\n`)
  }
} else if (cmd === 'status') {
  const r = analyse({ ...ANALYSE_OPTS, force: false })
  const config = readConfig(profileDir)
  const body = {
    ok: true,
    profile: profileDir,
    installRoot: r.installRoot ?? null,
    pending: r.pending ?? null,
    installedPlugins: r.checkedPlugins ?? 0,
    guarded: r.guarded ?? [],
    config,
  }
  if (asJson) out(body)
  else {
    console.log('\n=== 状态 ===\n')
    console.log(`profile     : ${body.profile}`)
    console.log(`安装目录    : ${body.installRoot ?? '(未找到)'}`)
    console.log(`待安装更新  : ${body.pending ? body.pending.version : '无'}`)
    console.log(`已装插件    : ${body.installedPlugins}`)
    console.log(`已锁定      : ${body.guarded.length ? body.guarded.join(', ') : '无'}`)
    console.log(`自动锁定    : ${config.autoLock ? '开' : '关'}`)
    console.log(`启动自检    : ${config.preflightOnStartup ? '开' : '关'}\n`)
  }
} else {
  console.log([
    '用法: node bin/guard.mjs <命令> [选项]',
    '',
    '命令:',
    '  check     只检查，不改动任何文件',
    '  lock      只锁定会失效的插件（其余不受影响）',
    '  unlock    撤销本工具做过的锁定',
    '  status    当前状态',
    '  config    查看/修改配置   --set <key> --value <v>',
    '',
    '选项:',
    '  --profile <dir>   指定 profile 目录',
    '  --root <dir>      指定 DSH 安装目录（含 resources\\app-update.yml）',
    '  --json            机器可读输出',
    '  --force           忽略接口面缓存，重新解包',
    '',
  ].join('\n'))
  process.exit(1)
}

// ---------------------------------------------------------------- rendering
function explain (r) {
  switch (r.reason) {
    case 'install-root-not-found': return '找不到 DSH 安装目录，用 --root 指定（该目录下应有 resources\\app-update.yml）'
    case 'seven-zip-not-found': return '找不到 7-Zip，安装它或设置环境变量 DSH_7Z 指向 7z.exe'
    case 'extract-failed': return '从安装包读取新版本失败: ' + (r.message ?? '')
    default: return r.reason ?? '未知错误'
  }
}

function printReport (r) {
  if (r.stage === 'no-pending') {
    console.log('\n=== DSH 更新前检查 ===\n')
    console.log(`已装插件 ${r.checkedPlugins} 个。`)
    console.log('当前没有「已下载、待安装」的更新。')
    console.log('请在应用里点下载，下载完成后再运行本检查。\n')
    return
  }

  console.log('\n=== DSH 更新前检查 ===\n')
  console.log(`待安装版本 : ${r.version}`)
  const tierLabel = r.tier === 'declared-only'
    ? '仅版本声明（没有可用的解压器）'
    : '版本声明 + 接口面比对'
  console.log(`检查层级   : ${tierLabel}`)
  if (r.tier !== 'declared-only') {
    console.log(`接口面来源 : ${r.source === 'cache' ? '本地缓存' : r.source === 'installer' ? '安装包内解出' : '运行中的版本'}`)
    console.log(`接口面规模 : ${Object.entries(r.surfaceSizes).map(([k, v]) => `${k.split('/').pop()}=${v}`).join('  ')}`)
  }
  if (r.extractor) console.log(`解压器     : ${r.extractor}`)
  console.log(`已装插件   : ${r.checkedPlugins} 个参与检查`)
  if (r.tier1) {
    const d = r.tier1.checked ?? 0
    const u = (r.tier1.undeclared ?? []).length
    console.log(`声明版本   : ${d} 个声明了支持范围，${u} 个没声明（没声明的不受版本检查约束）`)
  }
  if (typeof r.clientChecked === 'number') {
    console.log(`实际比对   : ${r.clientChecked} 个含界面组件（其余是纯宿主插件，没有接口可比）`)
  }
  if (r.guarded.length > 0) console.log(`已锁定     : ${r.guarded.join(', ')}`)
  if (r.tier === 'declared-only') {
    console.log('')
    console.log(r.note === 'extract-failed'
      ? `注意：解包失败（${r.surfaceError ?? '未知原因'}），只能做版本检查。`
      : '注意：没有找到 7-Zip 之类的解压器，只能做版本检查。')
    console.log('      装一个 7-Zip，或设置环境变量 DSH_7Z 指向 7z.exe，就能比对接口层。')
  }
  console.log('')

  if (r.findings.length === 0) {
    console.log('结论：没有发现问题。')
    console.log(r.tier === 'declared-only' ? '     （只验证了版本声明，接口层未检查）\n' : '     可以正常更新。\n')
    return
  }

  console.log(`发现 ${r.findings.length} 个插件可能在本次更新后失效：\n`)
  for (const f of r.findings) {
    console.log(`  ✗ ${f.plugin}`)
    if (f.declared) {
      console.log(`      声明: ${f.declared.field} = ${f.declared.range}`)
      console.log(`      ${f.declared.detail}`)
      console.log('      后果：加载器会直接跳过这个插件')
    } else {
      console.log(`      配置 id: ${f.ids.length > 0 ? f.ids.join(', ') : '(未声明，无法锁定)'}`)
      for (const b of f.broken) {
        console.log(`      缺少 ${b.moduleName.split('/').pop()}: ${b.missing.join(', ')}${b.note ? `  (${b.note})` : ''}`)
      }
      console.log('      后果：调用这些功能时会报错，通常表现为界面某处直接崩')
    }
    console.log('')
  }
  console.log('未做任何改动。要只锁定这些插件：')
  console.log(`    node "${join(PKG_DIR, 'bin', 'guard.mjs')}" lock\n`)
}

function printLock (r, result) {
  console.log('\n=== 已锁定 ===\n')
  if (result.locked.length === 0) console.log('没有新增锁定。')
  else {
    for (const f of r.findings) {
      const mine = f.ids.filter(id => result.locked.includes(id))
      if (mine.length === 0) continue
      console.log(`  ✗ ${f.plugin}`)
      console.log(`      已禁用: ${mine.join(', ')}`)
    }
  }
  console.log('')
  console.log(`其余 ${r.checkedPlugins - r.findings.length} 个插件保持正常。`)
  console.log('重启应用后生效。撤销：')
  console.log(`    node "${join(PKG_DIR, 'bin', 'guard.mjs')}" unlock\n`)
}

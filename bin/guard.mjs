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
import { runCookieHelper, parseList, parsePrune } from '../lib/cookies.mjs'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'

import {
  analyse, lockFromAnalysis, unlockAll, readConfig, writeConfig, defaultProfileDir, saveReport,
  guardedIds, lockTarget,
} from '../lib/run.mjs'
import { planRestore, applyRestore } from '../lib/restore.mjs'
import { diagnoseRestore } from '../lib/diagnose.mjs'
import { basename } from 'node:path'
import { launcherState, removeLauncher, ensureLauncher } from '../lib/launcher.mjs'
import { listInstalled } from '../lib/plugins.mjs'
import { scanAll } from '../lib/touchpoints.mjs'
import { readToolSurface, diffToolSurface } from '../lib/tool-surface.mjs'
import { buildSupportBundle } from '../lib/support-bundle.mjs'
import { buildSnapshot, diffSnapshots, readSnapshot, snapshotFileName } from '../lib/snapshot.mjs'
import { captureState, listStates, readState, diffStates, writeState } from '../lib/state-snapshot.mjs'
import { openAsar } from '../lib/asar.mjs'
import { detectGhost } from '../lib/ghost.mjs'
import { readFeedConfig, fetchFeed, versionDistance } from '../lib/feed.mjs'
import { checkDeclaredRanges } from '../lib/compat.mjs'
import { findInstallRoot, installedVersion } from '../lib/installer.mjs'

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
// Tests and diagnostics may analyse a throwaway profile; without this they all
// write one shared `last-report.json` and the panel then shows a report about a
// tree that no longer exists.
const cacheRoot = opt('cache', CACHE_ROOT)

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
  cacheRoot,
  keepTemp: flag('keep-temp'),
  force: flag('force'),
}

// ---------------------------------------------------------------- commands
if (cmd === 'check' && flag('remote')) {
  // Ask the feed what the newest published build is, without waiting for a
  // download. Only Tier 1 can run here — declared ranges need nothing but a
  // version string — so this answers "should I take this update", not "which
  // plugins break". The second question still needs the installer.
  const root = installRoot ?? findInstallRoot()
  if (!root) fail('找不到安装目录，无法读取 app-update.yml')
  const config = readFeedConfig(root)
  if (!config) fail(`没有可读的 app-update.yml：${join(root, 'resources', 'app-update.yml')}`)

  const feed = await fetchFeed(config)
  if (!feed.ok) fail(`读取更新源失败：${feed.error}`, { feedUrl: feed.feedUrl })

  const installed = installedVersion(root) ?? 'unknown'
  const distance = versionDistance(installed, feed.version)
  const upToDate = installed === feed.version

  const tier1 = upToDate ? null : checkDeclaredRanges(profileDir, feed.version)
  const body = {
    ok: true,
    mode: 'remote',
    feedUrl: feed.feedUrl,
    channel: config.channel,
    installed,
    available: feed.version,
    distance,
    upToDate,
    installer: { url: feed.fileUrl, size: feed.size, releaseDate: feed.releaseDate },
    tier1: tier1 ?? null
  }
  if (asJson) out(body)
  else {
    console.log('\n=== 线上版本 ===\n')
    console.log(`渠道     : ${config.channel}`)
    console.log(`已装     : ${installed}`)
    console.log(`线上     : ${feed.version}`)
    console.log(`跨度     : ${distance.label}（${distance.kind}）`)
    console.log(`大小     : ${feed.size ? Math.round(feed.size / 1024 / 1024) + ' MB' : '(未知)'}`)
    if (feed.releaseDate) console.log(`发布     : ${feed.releaseDate}`)
    console.log('')

    if (upToDate) {
      console.log('已是最新，没有可比的东西。\n')
    } else {
      console.log(`--- 声明范围检查（不需要下载） ---\n`)
      const declared = tier1.declared ?? 0
      const undeclared = tier1.undeclared ?? []
      const findings = tier1.findings ?? []
      console.log(`声明了支持范围的插件: ${declared} 个`)
      console.log(`没声明（不受版本约束）: ${undeclared.length} 个`)
      if (findings.length === 0) {
        console.log('\n声明范围里没有插件会被这个版本排除。')
      } else {
        console.log(`\n以下 ${findings.length} 个插件的声明范围不覆盖 ${feed.version}：`)
        for (const f of findings) console.log(`  · ${f.plugin}  ${f.range ?? ''}  ${f.reason ?? ''}`)
      }
      console.log('\n注意：这只是版本声明层。插件到底会不会坏，要等安装包下载完做接口面比对。')
      console.log(`下载完成后运行：node "${join(PKG_DIR, 'bin', 'guard.mjs')}" check\n`)
    }
  }
} else if (cmd === 'check') {
  const r = analyse(ANALYSE_OPTS)
  if (r.stage === 'error') fail(explain(r), r)
  // Also publish the result the settings panel reads, so a manual check shows
  // up there without waiting for the next startup pass.
  if (r.stage === 'analysed') {
    try { saveReport(cacheRoot, r) } catch { /* panel just keeps the old one */ }
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
} else if (cmd === 'diagnose') {
  const d = diagnoseRestore(profileDir)
  if (asJson) out({ ok: true, ...d })
  else {
    console.log('')
    console.log('=== 自动还原判定 ===')
    console.log('')
    for (const c of d.conditions) {
      console.log('  ' + (c.pass ? '过' : '不过') + '  ' + c.label.padEnd(24) + c.detail)
    }
    console.log('')
    console.log('结论: ' + d.note)
    console.log('profile: ' + profileDir)
    console.log('')
  }
  process.exit(0)
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
  if (action === 'install') {
    // 开必须是一个动作：改配置 + 生成脚本 + 接管图标，一次完成。
    // 之前没有这个命令，只能手改快捷方式，结果配置说"关"、图标说"开"，
    // 下一次启动就把脚本删了、图标悬空。
    const r = ensureLauncher({ profileDir, pkgDir: PKG_DIR, manageShortcut: !flag('no-shortcut') })
    if (!r.ok) fail('生成启动器失败: ' + r.reason)
    const cfg = readConfig(profileDir)
    writeConfig(profileDir, { ...cfg, installLauncher: true })
    if (asJson) out({ ok: true, launcher: r, installLauncher: true })
    else {
      console.log('')
      console.log('=== 已接管桌面快捷方式 ===')
      console.log('')
      console.log('  快捷方式  : ' + (r.shortcut ?? '(未修改)'))
      console.log('  目标程序  : ' + (r.exe ?? '(自动检测)'))
      console.log('  配置      : installLauncher = true')
      console.log('')
      console.log('  还原: node bin/guard.mjs launcher restore')
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
  fail('未知子命令: ' + action + '（可用 status / install / restore / uninstall）')
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
} else if (cmd === 'cookie') {
    // Cookie 罐维护。默认只看；--prune 才动手。
    // 只能在应用关着的时候操作：库被独占锁住时如实报告，不硬来。
    const doPrune = flag('prune')
    const result = runCookieHelper(PKG_DIR, { list: !doPrune })
    const parsed = doPrune ? parsePrune(result) : parseList(result)

    if (asJson) {
      out({ ok: parsed.ok, action: doPrune ? 'prune' : 'list', db: result.db, ...parsed })
    } else {
      console.log('\n=== Cookie 罐 ===\n')
      console.log(`数据库  : ${result.db}`)
      console.log(`python  : ${result.python ?? '(未找到)'}`)
      if (!parsed.ok) {
        const why = {
          'no-db': '数据库不存在（应用从没启动过？）',
          'no-python': '找不到 python，无法读取',
          'no-helper': '缺少 lib/prune-cookies.py',
          'locked-or-empty': '数据库被占用（应用正在运行），或罐是空的',
          'run-failed': '调用失败: ' + (result.message ?? ''),
        }[parsed.reason] ?? parsed.reason
        console.log(`结果    : ${why}\n`)
      } else if (doPrune) {
        console.log(`结果    : 保留 ${parsed.kept} 条，清掉 ${parsed.removed} 条\n`)
      } else {
        console.log(`dsh-auth: ${parsed.total} 条\n`)
        for (const n of parsed.names) console.log(`  ${n}`)
        console.log('')
        console.log(parsed.total > 2
          ? '数量偏多。关掉 DSH 后运行 `node bin/guard.mjs cookie --prune` 清理。\n'
          : '数量正常。\n')
      }
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
    lockTarget: lockTarget(profileDir),
    installedVersion: r.installedVersion ?? null,
    config,
  }
  // A lock never expires on its own. Once the version it was aimed at is the one
  // installed, the reason for it is gone and the user should be told.
  body.unlockNow = body.guarded.length > 0 &&
    body.lockTarget !== null &&
    body.lockTarget === body.installedVersion
  if (asJson) out(body)
  else {
    console.log('\n=== 状态 ===\n')
    console.log(`profile     : ${body.profile}`)
    console.log(`安装目录    : ${body.installRoot ?? '(未找到)'}`)
    console.log(`待安装更新  : ${body.pending ? body.pending.version : '无'}`)
    console.log(`已装插件    : ${body.installedPlugins}`)
    console.log(`已锁定      : ${body.guarded.length ? body.guarded.join(', ') : '无'}`)
    console.log(`锁定目标    : ${body.lockTarget ?? '(未记录)'}${body.unlockNow ? '  ← 已装同版本，可以解锁' : ''}`)
    console.log(`已装版本    : ${body.installedVersion ?? '(未知)'}`)
    console.log(`自动锁定    : ${config.autoLock ? '开' : '关'}`)
    console.log(`启动自检    : ${config.preflightOnStartup ? '开' : '关'}\n`)
  }
} else if (cmd === 'touchpoints') {
  // Tier-0: how much of the host's internals each installed plugin reaches into.
  // Needs no target version and downloads nothing — useful before you even know
  // whether an update is coming.
  const roots = [
    join(profileDir, 'node_modules'),
    join(profileDir, 'node_modules', '@deepseek-ai')
  ]
  const installed = listInstalled(roots)
  // Only bundles the profile actually mounts. node_modules also holds plain
  // library dependencies (@anthropic-ai/sdk and friends); ranking those tells
  // the operator nothing they can act on.
  let mounted = installed
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const bundles = pkg?.dsh?.profile?.bundles
    if (Array.isArray(bundles) && bundles.length > 0) {
      const want = new Set(bundles)
      mounted = installed.filter(p => want.has(p.name))
    }
  } catch { /* no readable package.json — scan everything and say so */ }
  const scopeNote = mounted === installed ? '全部已解析包' : 'bundles 列表内的插件'
  const withVersion = mounted.map(p => {
    let version = '?'
    try {
      version = JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8')).version ?? '?'
    } catch { /* unreadable manifest — keep the placeholder */ }
    return { ...p, version }
  })
  const rows = scanAll(withVersion, { maxFiles: Number(opt('max-files', '4000')) || 4000 })
  const only = opt('only', undefined)
  const shown = only === undefined ? rows : rows.filter(r => r.name === only)
  const tally = { high: 0, medium: 0, low: 0, none: 0 }
  for (const r of rows) tally[r.risk.band] += 1

  const body = { ok: true, profile: profileDir, tally, plugins: shown }
  if (asJson) out(body)
  else {
    console.log('\n=== 触点扫描 ===\n')
    console.log(`profile : ${profileDir}`)
    console.log(`已扫描  : ${rows.length} 个插件（${scopeNote}）`)
    console.log(`分布    : high ${tally.high} / medium ${tally.medium} / low ${tally.low} / none ${tally.none}\n`)
    for (const r of shown) {
      const mark = r.risk.band === 'high' ? '!!' : r.risk.band === 'medium' ? '! ' : '  '
      console.log(`${mark} ${r.name} ${r.version}  [${r.risk.band}] ${r.risk.reason}`)
      for (const c of r.classes) {
        console.log(`       - ${c.slug} ×${c.hits}  (${c.files.slice(0, 3).join(', ')})`)
      }
    }
    console.log('\n说明：这是启发式扫描，不是兼容性证明。')
    console.log('零命中只代表「这些模式没匹配到」，不代表升级一定安全。\n')
  }
} else if (cmd === 'tools') {
  // Tier-2b: the model-visible tool surface. Names, parameter sets and
  // optionality are what a saved prompt or another plugin actually calls.
  const asarPath = opt('asar', undefined)
  if (!asarPath) {
    if (asJson) out({ ok: false, error: 'tools needs --asar <path to app.asar>' })
    else console.error('\n[!] 需要 --asar <app.asar 路径>\n')
    process.exit(1)
  }
  const surface = readToolSurface(asarPath)
  const against = opt('diff', undefined)

  if (against) {
    const next = readToolSurface(against)
    const d = diffToolSurface(surface, next)
    const body = { ok: true, from: asarPath, to: against, count: { before: surface.length, after: next.length }, ...d }
    if (asJson) out(body)
    else {
      console.log('\n=== 工具表面差异 ===\n')
      console.log(`旧: ${asarPath}  (${surface.length} 个工具)`)
      console.log(`新: ${against}  (${next.length} 个工具)\n`)
      if (!d.breaking) console.log('没有破坏性变化。\n')
      if (d.removed.length) {
        console.log(`移除的工具 (${d.removed.length}) —— 引用它的提示词会直接失效:`)
        for (const n of d.removed) console.log(`  - ${n}`)
        console.log('')
      }
      if (d.added.length) {
        console.log(`新增的工具 (${d.added.length}):`)
        for (const n of d.added) console.log(`  + ${n}`)
        console.log('')
      }
      const paramBreaks = d.changed.filter(c => c.lostParams.length || c.newlyRequired.length)
      if (paramBreaks.length) {
        console.log(`参数变化 (${paramBreaks.length}) —— 按旧参数调用会失败:`)
        for (const c of paramBreaks) {
          console.log(`  ! ${c.name}`)
          if (c.lostParams.length) console.log(`      丢失参数: ${c.lostParams.join(', ')}`)
          if (c.newlyRequired.length) console.log(`      变为必填: ${c.newlyRequired.join(', ')}`)
        }
        console.log('')
      }
      const descOnly = d.changed.filter(c => !c.lostParams.length && !c.newlyRequired.length)
      if (descOnly.length) {
        console.log(`仅描述变化 (${descOnly.length})，不影响调用但可能改变模型行为:`)
        for (const c of descOnly) console.log(`  ~ ${c.name}`)
        console.log('')
      }
    }
  } else {
    const body = { ok: true, asar: asarPath, count: surface.length, tools: surface }
    if (asJson) out(body)
    else {
      console.log('\n=== 工具表面 ===\n')
      console.log(`${asarPath}`)
      console.log(`共 ${surface.length} 个工具定义\n`)
      for (const t of surface) {
        const p = t.params.names.length ? t.params.names.join(', ') : '(无参数)'
        console.log(`${t.name.padEnd(24)} ${t.module.replace(/^dsh-tool-/, '').padEnd(16)} ${p.slice(0, 70)}`)
      }
      console.log('')
    }
  }
} else if (cmd === 'ghost') {
  // Is the running host executing an older build than the one on disk? Every
  // compatibility conclusion is attributed to the wrong side of the upgrade
  // while this is true.
  const asarPath = opt('asar', join(installRoot ?? '', 'resources', 'app.asar'))
  const r = detectGhost(asarPath)
  const body = { ok: true, asar: asarPath, ...r }
  if (asJson) out(body)
  else {
    console.log('\n=== 幽灵宿主 ===\n')
    console.log(`归档 : ${asarPath}`)
    console.log(`写入 : ${r.asarMtime ?? '(不可读)'}`)
    console.log(`状态 : ${r.status}`)
    console.log(`说明 : ${r.reason}\n`)
    if (r.status === 'ghost') {
      console.log('磁盘上的版本比运行中的进程新。此刻做的任何兼容性判断，')
      console.log('都是在拿新版本的接口去比一个还在跑旧代码的进程。')
      console.log('重启 DSH 后再判断。\n')
    }
    if (r.processes.length) {
      console.log('进程:')
      for (const p of r.processes) console.log(`  ${String(p.id ?? '-').padEnd(8)} ${p.name ?? '-'}  启动于 ${p.start ?? '-'}`)
      console.log('')
    }
  }
} else if (cmd === 'snapshot') {
  // A readable record of "what this machine looked like", for comparing after an
  // update goes wrong. Description only: nothing here restores anything.
  if (flag('list')) {
    const rows = listStates(PKG_DIR)
    if (asJson) out({ ok: true, snapshots: rows })
    else {
      console.log('\n=== 状态快照 ===\n')
      if (rows.length === 0) console.log('（空。用 snapshot 生成一份）')
      for (const r of rows) {
        console.log('  ' + (r.at ?? '?') + '  DSH ' + (r.dsh ?? '?') + '  ' +
          String(r.plugins ?? '?').padStart(2) + ' 个插件  ' + (r.note || '') +
          (r.error ? '  [读不出: ' + r.error + ']' : ''))
      }
      console.log('')
    }
  } else if (flag('diff')) {
    const i = argv.indexOf('--diff')
    const a = argv[i + 1]
    const b = argv[i + 2]
    if (!a || !b) fail('用法: snapshot --diff <旧.json> <新.json>')
    let before, after
    try { before = readState(a) } catch (e) { fail('读不出旧快照: ' + (e instanceof Error ? e.message : e)) }
    try { after = readState(b) } catch (e) { fail('读不出新快照: ' + (e instanceof Error ? e.message : e)) }
    const d = diffStates(before, after)
    if (asJson) out({ ok: true, before: before.createdAt, after: after.createdAt, ...d })
    else printStateDiff(d)
  } else {
    let guardVersion
    try { guardVersion = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version } catch { guardVersion = null }
    const state = captureState({
      profileDir,
      installRoot: installRoot ?? findInstallRoot(),
      pkgDir: PKG_DIR,
      guardVersion,
      note: opt('note', ''),
    })
    const path = writeState(PKG_DIR, state)
    if (asJson) out({ ok: true, path, state })
    else {
      console.log('\n=== 状态快照已保存 ===\n')
      console.log(`路径   : ${path}`)
      console.log(`DSH    : ${state.dsh.version}`)
      console.log(`插件   : ${state.plugins.length} 个`)
      console.log(`配置   : ${JSON.stringify(state.guard.config)}`)
      console.log('\n它不是还原源。要对照，用 snapshot --diff <旧> <新>。\n')
    }
  }
} else if (cmd === 'surfaces') {
  // Interface snapshots: the compare-able part of a release, without the 200 MB
  // archive. Kept as a sub-command so `check` stays the only mutating path.
  const sub = argv[1]
  const dir = opt('dir', join(PKG_DIR, 'baselines'))

  if (sub === 'export') {
    const asarPath = opt('asar', undefined)
    if (!asarPath) fail('surfaces export 需要 --asar <app.asar>')
    if (!existsSync(asarPath)) fail('找不到归档：' + asarPath)
    let guardVersion
    try { guardVersion = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version } catch { guardVersion = null }
    const snap = buildSnapshot(asarPath, { version: opt('version', undefined), guardVersion })
    mkdirSync(dir, { recursive: true })
    const outPath = join(dir, opt('name', snapshotFileName(snap)))
    writeFileSync(outPath, JSON.stringify(snap, null, 2) + '\n', 'utf8')
    const body = { ok: true, path: outPath, version: snap.dsh.version, counts: snap.counts }
    if (asJson) out(body)
    else {
      console.log('\n=== 接口面快照 ===\n')
      console.log(`版本   : ${snap.dsh.version}`)
      console.log(`归档   : ${asarPath}`)
      console.log(`模块   : ${snap.counts.modules} 个，成员 ${snap.counts.members}`)
      console.log(`服务   : ${snap.counts.services} 个（${snap.counts.servicesWithMethods} 个有方法集，共 ${snap.counts.methods} 个方法）`)
      console.log(`工具   : ${snap.counts.tools} 个`)
      console.log(`写入   : ${outPath}\n`)
    }
  } else if (sub === 'list') {
    let files = []
    try { files = readdirSync(dir).filter(f => f.endsWith('.json')).sort() } catch { /* no dir yet */ }
    const rows = []
    for (const f of files) {
      try {
        const s = readSnapshot(join(dir, f))
        rows.push({ file: f, version: s.dsh?.version ?? '?', at: s.createdAt ?? '?', counts: s.counts ?? {} })
      } catch (e) {
        rows.push({ file: f, version: '?', error: e instanceof Error ? e.message : String(e) })
      }
    }
    if (asJson) out({ ok: true, dir, snapshots: rows })
    else {
      console.log('\n=== 快照库 ===\n')
      console.log(`目录 : ${dir}`)
      if (rows.length === 0) console.log('（空。用 surfaces export --asar <app.asar> 生成）')
      for (const r of rows) {
        console.log('  ' + r.file.padEnd(28) + ' ' + r.version + (r.error ? '  [读不出: ' + r.error + ']' : '  ' + (r.at ?? '')))
      }
      console.log('')
    }
  } else if (sub === 'diff') {
    const a = opt('before', argv[2])
    const b = opt('after', argv[3])
    if (!a || !b) fail('用法: surfaces diff <旧快照.json> <新快照.json>')
    let before, after
    try { before = readSnapshot(a) } catch (e) { fail('读不出旧快照: ' + (e instanceof Error ? e.message : e)) }
    try { after = readSnapshot(b) } catch (e) { fail('读不出新快照: ' + (e instanceof Error ? e.message : e)) }
    const d = diffSnapshots(before, after)
    const body = { ok: true, before: before.dsh, after: after.dsh, ...d }
    if (asJson) out(body)
    else printSnapshotDiff(before, after, d)
  } else {
    console.log([
      '用法: node bin/guard.mjs surfaces <子命令>',
      '',
      '  export --asar <app.asar> [--dir <目录>] [--version <版本>]   把一个版本的接口面存成 JSON',
      '  list   [--dir <目录>]                                       列出已有快照',
      '  diff   <旧.json> <新.json>                                   比较两个快照（新增/移除）',
      '',
    ].join('\n'))
    process.exit(1)
  }
} else if (cmd === 'support-bundle') {
  // Paste-ready diagnosis for an issue report.
  //
  // This exists because the binding constraint on this project is not code, it
  // is version pairs: almost every real bug is "DSH A + guard B + plugin C",
  // and a report that only says "it broke" cannot be reproduced. One command is
  // the difference between a usable report and a five-file back-and-forth.
  const bundle = buildSupportBundle({
    pkgDir: PKG_DIR,
    profileDir,
    installRoot: installRoot ?? findInstallRoot(),
    cacheRoot,
    ghost: flag('ghost'),
  })
  const outPath = opt('out', undefined)
  if (outPath) {
    writeFileSync(outPath, asJson ? JSON.stringify(bundle.data, null, 2) : bundle.markdown, 'utf8')
    console.log(`已写入 ${outPath}`)
  } else if (asJson) {
    out(bundle.data)
  } else {
    console.log('\n' + bundle.markdown + '\n')
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
    '  cookie    看 dsh-auth cookie 条数  --prune 清理（需先关 DSH）',
    '  config    查看/修改配置   --set <key> --value <v>',
    '  support-bundle  导出一段可贴进 Issue 的脱敏诊断  --out <file> --ghost',
    '  surfaces   export / list / diff 接口面快照（不保存整个 app.asar）',
    '  snapshot   升级前状态快照  --list / --diff <旧> <新> / --note <文字>',
    '',
    '选项:',
    '  --profile <dir>   指定 profile 目录',
    '  --root <dir>      指定 DSH 安装目录（含 resources\\app-update.yml）',
    '  --cache <dir>     指定缓存目录（默认 <插件>/.cache；测试用，避免污染真实报告）',
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

  const hard = r.findings.filter(f => (f.broken ?? []).some(b => b.note !== 'service-absent'))
  const soft = r.findings.filter(f => !hard.includes(f))

  if (r.installedVersion !== undefined && r.version === r.installedVersion) {
    console.log('')
    console.log('注意：待安装版本就是当前已装版本（' + r.version + '），没有真正的新更新。')
    console.log('下面的比对是当前版本对自己的自检，不代表"更新后会坏"。')
    console.log('')
  }

  if (hard.length > 0) {
    console.log('确定会失效：' + hard.length + ' 个')
    console.log('')
    for (const f of hard) {
      console.log('  ✗ ' + f.plugin)
      if (f.ids && f.ids.length) console.log('      配置 id: ' + f.ids.join(', '))
      for (const b of f.broken ?? []) {
        if (b.note === 'service-absent') continue
        const what = Array.isArray(b.missing) ? b.missing.join(', ') : String(b.missing ?? '')
        console.log('      缺少 ' + b.moduleName + ': ' + what)
      }
      console.log('')
    }
  } else {
    console.log('确定会失效：0 个')
    console.log('')
  }

  if (soft.length > 0) {
    console.log('仅提示（多数插件会自行降级，不锁定）：' + soft.length + ' 个')
    for (const f of soft) {
      const names = []
      for (const b of f.broken ?? []) {
        if (b.note === 'service-absent') {
          names.push('宿主服务 ' + (Array.isArray(b.missing) ? b.missing.join('/') : b.missing))
        }
      }
      for (const sname of f.softUnknown ?? []) names.push('宿主服务待确认 ' + sname)
      for (const u of f.methodUnknown ?? []) names.push('服务方法待确认 ' + u.service + '.' + u.method)
      for (const item of f.unverified ?? []) names.push('接口面未能解析 ' + item.moduleName)
      console.log('  · ' + f.plugin + '  ——  ' + (names.join('，') || '存在未验证项'))
    }
    console.log('')
  }

  if (hard.length === 0) {
    console.log('没有任何插件会因为这次更新而确定失效。')
    console.log('')
    process.exit(0)
  }

  console.log('要只锁定确定失效的这几个：')
  console.log('    node "' + join(PKG_DIR, 'bin', 'guard.mjs') + '" lock')
  console.log('')
}

function printSnapshotDiff (before, after, d) {
  const line = (s = '') => console.log(s)
  line('')
  line('=== 接口面差异 ===')
  line('')
  line(`旧 : ${before.dsh?.version ?? '?'}  (${before.createdAt ?? '?'})`)
  line(`新 : ${after.dsh?.version ?? '?'}  (${after.createdAt ?? '?'})`)
  line('')

  const lostMembers = d.modules.filter(m => m.removed.length > 0)
  line(`模块成员移除：${lostMembers.length} 个模块`)
  for (const m of lostMembers) line(`  - ${m.module}: ${m.removed.join(', ')}`)
  const addedOnly = d.modules.filter(m => m.removed.length === 0 && m.added.length > 0)
  if (addedOnly.length > 0) line(`仅新增成员：${addedOnly.length} 个模块（不影响已装插件）`)
  line('')

  line(`宿主服务移除：${d.services.removed.length} 个` +
    (d.services.removed.length > 0 ? ' → ' + d.services.removed.join(', ') : ''))
  const methodLoss = d.services.methods.filter(m => m.removed.length > 0)
  line(`服务方法移除：${methodLoss.length} 个服务`)
  for (const m of methodLoss) line(`  - ${m.service}: ${m.removed.join(', ')}`)
  line('')

  line(`工具移除：${d.tools.removed.length} 个` +
    (d.tools.removed.length > 0 ? ' → ' + d.tools.removed.join(', ') : ''))
  const paramLoss = d.tools.changed.filter(c => c.lostParams.length > 0 || c.newlyRequired.length > 0)
  line(`工具参数变化：${paramLoss.length} 个`)
  for (const c of paramLoss) {
    if (c.lostParams.length > 0) line(`  - ${c.name} 少了参数: ${c.lostParams.join(', ')}`)
    if (c.newlyRequired.length > 0) line(`  - ${c.name} 变必填: ${c.newlyRequired.join(', ')}`)
  }
  line('')
  line(d.breaking
    ? '结论：有破坏性变化（成员 / 服务 / 方法 / 工具至少一项消失）'
    : '结论：只有新增或描述变化，没有发现破坏性移除')
  line('')
}

function printStateDiff (d) {
  const line = (s = '') => console.log(s)
  line('')
  line('=== 状态差异 ===')
  line('')
  line(`DSH   : ${d.dsh.before ?? '?'} → ${d.dsh.after ?? '?'}`)
  line('')
  line(`插件变化：${d.plugins.length} 个`)
  for (const p of d.plugins) {
    const what = p.change === 'added'
      ? '新增 ' + (p.after ?? '')
      : p.change === 'removed'
        ? '移除 ' + (p.before ?? '')
        : (p.before ?? '?') + ' → ' + (p.after ?? '?')
    line(`  ${p.name}  ${what}`)
  }
  line('')
  line(`bundles 列表：新增 ${d.bundles.added.length} / 移除 ${d.bundles.removed.length}`)
  for (const x of d.bundles.added) line('  + ' + x)
  for (const x of d.bundles.removed) line('  - ' + x)
  line('')
  line(`配置变化：${d.config.length} 项`)
  for (const c of d.config) line(`  ${c.key}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`)
  line('')
  line(`runtime：${d.runtime.before ?? '?'} → ${d.runtime.after ?? '?'} 个文件` + (d.runtime.changed ? '（有变化）' : '（一致）'))
  line(`待安装更新：${d.pending.before ?? '无'} → ${d.pending.after ?? '无'}`)
  line('')
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

/**
 * The second leg: make DSH launchable even when a plugin breaks startup.
 *
 * A plugin cannot repair the process that hosts it, so while it is HEALTHY it
 * installs a launch wrapper. A double-click then goes through the wrapper:
 *
 *   1. sanity-check the profile (broken JSON, bundles the loader would reject,
 *      a patch layer that was reset),
 *   2. start DSH,
 *   3. if DSH dies quickly with a non-zero exit, treat that as a failed start,
 *      disable third-party plugins, and start again automatically,
 *   4. only if that also fails, show a message box.
 *
 * The wrapper is HIDDEN on purpose. An earlier version ran a visible console for
 * the whole session: DSH's own output leaked into it, it sat in the taskbar, and
 * closing it killed the launched app. A launcher must be invisible, so the
 * shortcut targets `wscript.exe` running a .vbs shim with window style 0.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, statSync, rmSync } from 'node:fs'
import { join, basename, resolve, win32 } from 'node:path'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'

import { findInstallRoot } from './installer.mjs'
import { CONFIG_DEFAULTS } from './run.mjs'

const basenameOf = (p) => basename(p)

/**
 * Where the desktop shortcut should point, best effort.
 * @returns {string|undefined}
 */
function desktopDir () {
  const home = homedir()
  for (const c of [join(home, 'Desktop'), join(home, 'OneDrive', 'Desktop'), join(home, '桌面')]) {
    if (existsSync(c)) return c
  }
  return undefined
}

function psQuote (s) {
  return String(s).replace(/'/g, "''")
}

/**
 * Which desktop .lnk should carry the launcher: either one that still points at
 * the DSH executable, or one this guard already repointed. Preferring the
 * user's own icon keeps a single icon: two icons that both start the app is
 * clutter, and the user may pick the unmanaged one.
 * @returns {string|undefined}
 */
/**
 * Compare two paths the way Windows does, not the way JS strings do.
 *
 * "D:/deep/App.exe" and "D:\deep\App.exe" are the same file but not the same
 * string. Without this, a caller that passes forward slashes fails to recognise
 * the existing shortcut, and the guard quietly creates a SECOND desktop icon
 * instead of managing the one the user already has.
 */
export function samePath (a, b) {
  if (a === undefined || b === undefined) return false
  // Shortcuts and the app executable are Windows paths, so compare them with
  // Windows rules even when this code is exercised on another platform. Using
  // the host `resolve()` made "D:\x\a.exe" and "D:/x/a.exe" differ on POSIX
  // (a backslash is an ordinary filename character there), which is a test
  // artefact, not a Windows behaviour difference.
  const isWindows = p => /^[A-Za-z]:[\\/]/.test(String(p)) || String(p).includes('\\')
  try {
    if (isWindows(a) || isWindows(b)) {
      return win32.resolve(String(a)).toLowerCase() === win32.resolve(String(b)).toLowerCase()
    }
    return resolve(a).toLowerCase() === resolve(b).toLowerCase()
  } catch {
    return String(a).toLowerCase().replace(/\\/g, '/') === String(b).toLowerCase().replace(/\\/g, '/')
  }
}

function findShortcutForExe (desk, exe) {
  let names
  try { names = readdirSync(desk).filter(f => f.toLowerCase().endsWith('.lnk')) } catch { return undefined }
  for (const name of names) {
    const p = join(desk, name)
    const info = probeShortcut(p)
    if (info === undefined || !info.target) continue
    if (samePath(info.target, exe)) return p
    if (info.args.includes('dsh-launch.vbs')) return p
  }
  return undefined
}

/**
 * The desktop application's own executable.
 *
 * `process.execPath` is the app when this runs inside the plugin, but it is
 * `node.exe` when the same code runs from the CLI — and using that as the icon
 * source gives the shortcut a green node logo. Fall back to the install root.
 */
function resolveDesktopExe (explicit) {
  if (explicit !== undefined) return explicit
  const base = basename(process.execPath ?? '').toLowerCase()
  if (base !== 'node.exe' && base !== 'nodejs.exe') return process.execPath

  const root = findInstallRoot()
  if (root === undefined) return process.execPath
  try {
    const exes = readdirSync(root)
      .filter(f => f.toLowerCase().endsWith('.exe'))
      .filter(f => !/^uninstall/i.test(f))
      .map(f => ({ name: f, size: statSync(join(root, f)).size }))
      .sort((a, b) => b.size - a.size)
    if (exes.length > 0) return join(root, exes[0].name)
  } catch { /* fall through */ }
  return process.execPath
}

/**
 * Read what a shortcut currently points at. Used to preserve the user's icon
 * when repointing: stamping our own icon over theirs is the kind of cosmetic
 * change that makes people distrust the whole tool.
 * @returns {{target: string, args: string, icon: string}|undefined}
 */
function probeShortcut (path) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      [
        '$w = New-Object -ComObject WScript.Shell',
        `$s = $w.CreateShortcut('${psQuote(path)}')`,
        '$s.TargetPath',
        '$s.Arguments',
        '$s.IconLocation',
      ].join('; ')],
    { encoding: 'utf8', timeout: 8000, windowsHide: true })
    const box = out.trim().split(/\r?\n/)
    return {
      target: (box[0] ?? '').trim(),
      args: (box[1] ?? '').trim(),
      icon: (box[2] ?? '').trim(),
    }
  } catch {
    return undefined
  }
}

/**
 * Icon sources that must never be adopted: they are what the wrapper runs on,
 * not what the user launched. Picking one turns the DSH icon into a blank
 * document or a green node logo.
 */
function isGenericIcon (icon) {
  if (!icon) return true
  const lower = icon.toLowerCase()
  for (const bad of ['\\node.exe', '\\wscript.exe', '\\powershell.exe', '\\cmd.exe', '\\shell32.dll']) {
    if (lower.includes(bad)) return true
  }
  return false
}

/**
 * Create or refresh a .lnk. Returns its path, or undefined when unavailable.
 * `iconSource` is only applied when it is a real application icon; otherwise the
 * existing one is left alone.
 */
/**
 * Is this shortcut still the one that routes through our launcher?
 *
 * A shortcut pointing straight at the app executable is the state after an
 * update, after the app rewrites its own icons, or after the user recreates it.
 * Treating that as "already done" would leave self-heal silently disabled.
 * @param {string|undefined} linkPath
 */
function isOurShortcut (linkPath) {
  if (linkPath === undefined || linkPath === null) return false
  if (!existsSync(linkPath)) return false
  const info = probeShortcut(linkPath)
  if (info === undefined) return false
  return info.args.includes('dsh-launch.vbs') || info.target.toLowerCase().includes('wscript')
}

function writeShortcut (linkPath, target, args, workDir, description, iconSource) {
  const existing = probeShortcut(linkPath)
  const keepIcon = !isGenericIcon(existing?.icon ?? '')
  const applyIcon = iconSource !== undefined && !isGenericIcon(iconSource)

  const script = [
    '$w = New-Object -ComObject WScript.Shell',
    `$s = $w.CreateShortcut('${psQuote(linkPath)}')`,
    `$s.TargetPath = '${psQuote(target)}'`,
    args === undefined ? '' : `$s.Arguments = '${psQuote(args)}'`,
    `$s.WorkingDirectory = '${psQuote(workDir)}'`,
    `$s.Description = '${psQuote(description)}'`,
    (applyIcon && !keepIcon) ? `$s.IconLocation = '${psQuote(iconSource)},0'` : '',
    '$s.Save()',
  ].filter(Boolean).join('\n')
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      timeout: 20000, windowsHide: true,
    })
    return existsSync(linkPath) ? linkPath : undefined
  } catch {
    return undefined
  }
}

/** Visible-by-hand runner, kept for debugging: shows what the launcher decides. */
const CMD_BODY = [
  '@echo off',
  'chcp 65001 >nul 2>&1',
  'setlocal',
  'set "PS1=%~dp0dsh-launch.ps1"',
  'if not exist "%PS1%" (',
  '  echo.',
  '  echo  [X] launcher files are missing. Reinstall dsh-update-guard.',
  '  pause',
  '  exit /b 1',
  ')',
  'powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -ShowConsole %*',
  'exit /b %ERRORLEVEL%',
  '',
].join('\r\n')

/**
 * The invisible entry point. `wscript` is a GUI-subsystem binary, so it never
 * allocates a console; window style 0 hides the child powershell entirely.
 */
const VBS_BODY = [
  "' Generated by dsh-update-guard. Starts DSH with no visible window.",
  'Dim shell, here, ps1, cmd',
  'Set shell = CreateObject("WScript.Shell")',
  'here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\\"))',
  'ps1 = here & "dsh-launch.ps1"',
  'cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """"',
  'shell.Run cmd, 0, False',
  '',
].join('\r\n')

function launcherPs1 (cfg) {
  return `# Generated by dsh-update-guard. Rewritten on every start; do not edit.
param([switch]$Repair, [switch]$Check, [switch]$NoStart, [switch]$ShowConsole)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$Exe       = '${psQuote(cfg.exe)}'
$Profile   = '${psQuote(cfg.profileDir)}'
$LogFile   = '${psQuote(join(cfg.pkgDir, 'rescue', 'launch.log'))}'
$PruneHelper = '${psQuote(join(cfg.pkgDir, 'lib', 'prune-cookies.py'))}'
$NL        = [Environment]::NewLine
# Baked from lib/run.mjs CONFIG_DEFAULTS. PowerShell must not keep its own copy of
# a default: two sources drift, and the one that runs is not the one documented.
$DefaultAutoRestore = $${CONFIG_DEFAULTS.autoRestore === true ? 'true' : 'false'}

# Overrides, so the same generated script can drive a different install or a
# throwaway profile (tests, diagnostics, a second copy of the app). Without this
# the only way to retarget it is editing the file, which is how a rewrite can
# silently break quoting.
if ($env:DSH_LAUNCHER_EXE) { $Exe = $env:DSH_LAUNCHER_EXE }
if ($env:DSH_LAUNCHER_PROFILE) { $Profile = $env:DSH_LAUNCHER_PROFILE }
function Log($t) {
  try {
    [System.IO.File]::AppendAllText($LogFile, ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $t + $NL), (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

# 最后一道保险：这段脚本里任何未捕获的异常都不该让用户失去桌面图标。
# 出错就退回直接启动原程序——启动器可以坏，DSH 必须能起来。
trap {
  try { Add-Content -Path $LogFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  启动器异常，退回直接启动: ' + $_.Exception.Message) -ErrorAction SilentlyContinue } catch { }
  try { Start-Process -FilePath $Exe } catch { }
  exit 0
}

Log '--- 启动器被调用 ---'

# 只有一个启动器能跑。用户连点几下图标时，多个实例会互相判对方的进程为"启动失败"，
# 于是弹出修复询问，把人吓住。互斥量把这件事从根上掐掉。
$mutex = $null
$gotMutex = $false
try {
$mutex = New-Object System.Threading.Mutex($false, 'dsh-update-guard-' + ((Split-Path $Profile -Leaf) -replace '[^A-Za-z0-9_.-]', '_'))
  try { $gotMutex = $mutex.WaitOne(0) }
  catch [System.Threading.AbandonedMutexException] { $gotMutex = $true }
} catch {
  $gotMutex = $true   # 互斥量不可用时不阻塞用户
}
if (-not $gotMutex) {
  Log '另一个启动器正在运行，本次直接退出（不重复拉起）'
  exit 0
}

# DSH 已经在跑时不要再起第二个：那只会立刻退出，并被误记成启动失败。
$exeName = [System.IO.Path]::GetFileNameWithoutExtension($Exe)
$already = @(Get-Process -Name $exeName -ErrorAction SilentlyContinue)
if ($already.Count -gt 0) {
  Log ('DSH 已在运行（PID ' + ($already[0].Id -join ',') + '），本次不重复启动')
  exit 0
}

# 0xC000013A：进程被控制台事件终止（关了窗口/控制台），不是"启动失败"。
$EXTERNAL_TERMINATION = -1073741510

# Launched hidden there is no console, so any feedback must be a message box.
$Visible = [bool]$ShowConsole

function Say($t) { if ($Visible) { Write-Host $t } }
function Ok($t)  { if ($Visible) { Write-Host "  [OK] $t" -ForegroundColor Green } }
function Warn($t){ if ($Visible) { Write-Host "  [!]  $t" -ForegroundColor Yellow } }
function Bad($t) { if ($Visible) { Write-Host "  [X]  $t" -ForegroundColor Red } }

function Show-Box($text, $title, $icon) {
  # Never raise a window when driven non-interactively (tests, automation). A
  # modal dialog appearing on someone's desktop because a test ran is exactly
  # the kind of side effect a guard must not have.
  if ($env:DSH_LAUNCHER_QUIET -eq '1') { Log ('对话框(静默): ' + $title + ' / ' + $text); return }
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    [void][System.Windows.Forms.MessageBox]::Show($text, $title, [System.Windows.Forms.MessageBoxButtons]::OK, $icon)
  } catch {
    try { Write-Host $text } catch { }
  }
}

# Yes/No, defaulting to No: any destructive step must be opted into explicitly.
function Show-Box-Ask($text) {
  if ($env:DSH_LAUNCHER_QUIET -eq '1' -and -not $env:DSH_LAUNCHER_ANSWER) {
    Log ('询问(静默，默认否): ' + $text)
    return 'no'
  }
  # 无人值守时可以预先给答案，避免测试卡在对话框上
  if ($env:DSH_LAUNCHER_ANSWER -eq 'yes') { Log '询问(自动 yes): ' + $text; return 'yes' }
  if ($env:DSH_LAUNCHER_ANSWER -eq 'no') { Log '询问(自动 no): ' + $text; return 'no' }
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $r = [System.Windows.Forms.MessageBox]::Show($text, 'DSH 启动器',
      [System.Windows.Forms.MessageBoxButtons]::YesNo,
      [System.Windows.Forms.MessageBoxIcon]::Warning,
      [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
    if ($r -eq [System.Windows.Forms.DialogResult]::Yes) { return 'yes' }
    return 'no'
  } catch {
    try { Write-Host $text } catch { }
    return 'no'
  }
}

function Read-Json($path) {
  $raw = [System.IO.File]::ReadAllText($path)
  if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
  return $raw | ConvertFrom-Json
}

# Profile package names and dsh.bundle.patch paths come from JSON, not from
# trusted code. Reject traversal/absolute paths before Test-Path can inspect
# files outside node_modules or the plugin directory.
function Resolve-PluginDir($name) {
  if ($name -isnot [string] -or [string]::IsNullOrWhiteSpace($name)) { return $null }
  if ($name -notmatch '^(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$') { return $null }
  $base = [System.IO.Path]::GetFullPath((Join-Path $Profile 'node_modules')).TrimEnd('\\') + '\\'
  $candidate = [System.IO.Path]::GetFullPath((Join-Path $base ($name -replace '/', '\\')))
  if (-not $candidate.StartsWith($base, [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
  return $candidate
}

function Resolve-PluginPatch($dir, $file) {
  if ($file -isnot [string] -or [string]::IsNullOrWhiteSpace($file)) { return $null }
  if ([System.IO.Path]::IsPathRooted($file) -or $file -match '(^|[\\\\/])\\.\\.([\\\\/]|$)') { return $null }
  $base = [System.IO.Path]::GetFullPath($dir).TrimEnd('\\') + '\\'
  $candidate = [System.IO.Path]::GetFullPath((Join-Path $base $file))
  if (-not $candidate.StartsWith($base, [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
  return $candidate
}

function Save-Json($path, $obj) {
  $json = $obj | ConvertTo-Json -Depth 30
  [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Test-Profile {
  $pkgPath = Join-Path $Profile 'package.json'
  if (-not (Test-Path $pkgPath)) { return @{ ok = $false; why = 'package.json 不存在' } }
  try { $m = Read-Json $pkgPath } catch { return @{ ok = $false; why = 'package.json 无法解析' } }
  if ($null -eq $m.dsh -or $null -eq $m.dsh.profile) { return @{ ok = $false; why = 'package.json 缺 dsh.profile' } }

  $bad = @()
  foreach ($name in @($m.dsh.profile.bundles)) {
    $dir = Resolve-PluginDir $name
    if ($null -eq $dir) { $bad += [string]$name; continue }
    if ($name -like '@deepseek-ai/*') { continue }
    if (-not (Test-Path (Join-Path $dir 'package.json'))) { $bad += $name; continue }
    try { $bm = Read-Json (Join-Path $dir 'package.json') } catch { $bad += $name; continue }
    if ($null -eq $bm.dsh -or $null -eq $bm.dsh.bundle) { $bad += $name; continue }
    foreach ($f in @($bm.dsh.bundle.patch)) {
      $patchFile = Resolve-PluginPatch $dir $f
      if ($null -eq $patchFile -or -not (Test-Path -LiteralPath $patchFile)) { $bad += $name; break }
    }
  }
  return @{ ok = ($bad.Count -eq 0); why = ($bad -join ', '); bad = $bad }
}

function Test-Bundle($name) {
  $dir = Resolve-PluginDir $name
  if ($null -eq $dir) { return @{ ok = $false; why = 'bundle 名称不是安全的 npm 包路径' } }
  if ($name -like '@deepseek-ai/*') { return @{ ok = $true } }
  if (-not (Test-Path (Join-Path $dir 'package.json'))) { return @{ ok = $false; why = '包未安装' } }
  try { $bm = Read-Json (Join-Path $dir 'package.json') } catch { return @{ ok = $false; why = 'package.json 无法解析' } }
  if ($null -eq $bm.dsh -or $null -eq $bm.dsh.bundle) { return @{ ok = $false; why = '缺 dsh.bundle' } }
  foreach ($f in @($bm.dsh.bundle.patch)) {
    $patchFile = Resolve-PluginPatch $dir $f
    if ($null -eq $patchFile -or -not (Test-Path -LiteralPath $patchFile)) { return @{ ok = $false; why = ('patch 路径缺失或不安全: ' + $f) } }
  }
  return @{ ok = $true }
}

function Get-GuardConfig {
  $cfg = @{ autoRestore = $DefaultAutoRestore }
  $p = Join-Path $Profile '.dsh-update-guard.json'
  if (-not (Test-Path $p)) { return $cfg }
  try {
    $j = Read-Json $p
    if ($null -ne $j.autoRestore) { $cfg.autoRestore = [bool]$j.autoRestore }
  } catch { }
  return $cfg
}

# 配置被重置（例如点了官方的「禁用第三方插件」）时，从最新备份恢复，
# 但只恢复能通过结构校验的那些：把坏的那个留在外面，而不是把全部关掉。
# 上一次健康启动时看到的插件清单。判定的主角是它，不是文件时间或大小：
# "上次有 23 个，这次一个都没有" 是事实，而"时间接近"只是巧合。
function Seen-File { return (Join-Path $Profile '.dsh-update-guard-lastseen.json') }

# 启动前清理堆积的 dsh-auth cookie。
#
# 宿主按 host:port 给 cookie 起名，而浏览器按 domain/path/name 存储：桌面端每次
# 启动换一个随机端口，就多一条永不淘汰的 cookie。七十来条之后请求头越过 Node
# 的 16 KB 上限，每个请求在解析阶段就 431，界面报 "Web authentication failed"。
#
# 只能在这里做：此刻应用还没起来，cookie 库没有被独占锁住。失败一律忽略——
# 清不掉 cookie 是小事，拦着应用启动是大事。
function Prune-StaleAuthCookies {
  try {
    $db = Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop\Network\Cookies'
    if (-not (Test-Path $db)) { return }
    if (@(Get-Process -Name $exeName -ErrorAction SilentlyContinue).Count -gt 0) { return }

    $helper = $PruneHelper
    if (-not (Test-Path $helper)) { Log 'cookie prune: helper missing, skipped'; return }

    $py = (Get-Command python -ErrorAction SilentlyContinue)
    if (-not $py) { Log 'cookie prune: python not found, skipped'; return }

    $out = & $py.Source $helper $db 2>&1
    Log ('cookie prune: ' + (($out | Out-String).Trim()))
  } catch {
    Log ('cookie prune threw: ' + $_.Exception.Message)
  }
}

function Save-Seen {
  try {
    $m = Read-Json (Join-Path $Profile 'package.json')
    $patchPath = Join-Path $Profile 'cordis.patch.yml'
    $ps = -1
    try { $ps = (Get-Item $patchPath).Length } catch { $ps = -1 }
    $now = @($m.dsh.profile.bundles)
    $thirdNow = @($now | Where-Object { $_ -and $_ -notlike '@deepseek-ai/*' })

    # 关键：记录不能被它要检测的那件事抹掉。重置后第一次启动看到的是空清单，
    # 如果直接覆盖，等到用户想恢复时证据已经没了。所以"含第三方的清单"只增不减。
    $prev = Read-Seen
    $lastWithThird = @()
    if ($null -ne $prev -and $null -ne $prev.lastWithThirdParty) {
      $lastWithThird = @($prev.lastWithThirdParty)
    } elseif ($null -ne $prev -and $null -ne $prev.bundles) {
      $lastWithThird = @(@($prev.bundles) | Where-Object { $_ -and $_ -notlike '@deepseek-ai/*' })
    }
    # 单独记"最后一次看到第三方的时间"：at 字段每次启动都刷新，不能用它判断
    # 补丁备份是否属于本次变化，否则重置前那份备份会显得比记录还旧。
    $lastWithThirdAt = $null
    $lastPatchSize = -1
    if ($null -ne $prev -and $null -ne $prev.lastWithThirdPartyAt) { $lastWithThirdAt = $prev.lastWithThirdPartyAt }
    if ($null -ne $prev -and $null -ne $prev.lastPatchSize) { $lastPatchSize = [int]$prev.lastPatchSize }
    if ($thirdNow.Count -gt 0) {
      $lastWithThird = $thirdNow
      $lastWithThirdAt = (Get-Date).ToString('o')
      # 补丁尺寸也只在"有第三方"时更新：重置后的那次启动会看到空补丁，
      # 记下去就把"原来 900 字节"这个信号抹掉了。
      $lastPatchSize = $ps
    }

    $rec = [ordered]@{
      at                = (Get-Date).ToString('o')
      bundles           = $now
      patchSize          = $ps
      lastWithThirdParty = $lastWithThird
      lastWithThirdPartyAt = $lastWithThirdAt
      lastPatchSize      = $lastPatchSize
    }
    [System.IO.File]::WriteAllText((Seen-File), ($rec | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

function Read-Seen {
  $f = Seen-File
  if (-not (Test-Path $f)) { return $null }
  try { return (Get-Content $f -Raw | ConvertFrom-Json) } catch { return $null }
}

# 自动还原的判定顺序（任一关不过就不动手）：
#   1. 上次记录里确实有第三方插件（没有记录 = 第一次跑，不猜）
#   2. 现在一个第三方都不剩
#   3. 补丁层被改名且只剩空壳（官方按钮的第二个痕迹）
#   4. 备份里确实有那些插件，且它们现在装在磁盘上
function Restore-Surgical {
  $pkgPath = Join-Path $Profile 'package.json'
  $cur = @()
  try { $cur = @((Read-Json $pkgPath).dsh.profile.bundles) } catch { $cur = @() }

  $thirdPartyNow = @($cur | Where-Object { $_ -notlike '@deepseek-ai/*' })
  if ($thirdPartyNow.Count -gt 0) {
    Log ('还原跳过: 当前仍有 ' + $thirdPartyNow.Count + ' 个第三方插件')
    return $false
  }

  $seen = Read-Seen
  if ($null -eq $seen) {
    Log '还原跳过: 没有上一次的清单记录（首次运行不做推断）'
    return $false
  }
  $recorded = @()
  if ($null -ne $seen.lastWithThirdParty) { $recorded = @($seen.lastWithThirdParty) }
  if ($recorded.Count -eq 0) { $recorded = @(@($seen.bundles) | Where-Object { $_ -and $_ -notlike '@deepseek-ai/*' }) }
  $thirdPartySeen = @($recorded | Where-Object { $_ -and $_ -notlike '@deepseek-ai/*' })
  if ($thirdPartySeen.Count -eq 0) {
    Log '还原跳过: 上次记录里也没有第三方插件'
    return $false
  }

  # 补丁层证据必须属于"这一次"，不能沿用很久以前那次重置留下的备份：
  #   1. 备份文件的时间在最近一次健康记录之后（之后才发生的改名）
  #   2. 当前补丁比记录时更小（内容真的被拿走了），或者补丁已经不在了
  # 只要求"备份存在"是不够的——旧备份会变成永久有效的证据。
  $seenAt = $null
  if ($null -ne $seen.lastWithThirdPartyAt) {
    try { $seenAt = [datetime]::Parse($seen.lastWithThirdPartyAt) } catch { $seenAt = $null }
  }
  if ($null -eq $seenAt) {
    Log '还原跳过: 没有"最后一次看到第三方"的时间，无法判断补丁备份是否属于本次'
    return $false
  }

  $patchPath = Join-Path $Profile 'cordis.patch.yml'
  $patchSize = -1
  try { $patchSize = (Get-Item $patchPath).Length } catch { $patchSize = -1 }
  $renamed = @(Get-ChildItem $Profile -Filter 'cordis.patch.yml.bak-*' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $seenAt })

  $seenPatch = -1
  if ($null -ne $seen.lastPatchSize) { $seenPatch = [int]$seen.lastPatchSize }
  elseif ($null -ne $seen.patchSize) { $seenPatch = [int]$seen.patchSize }
  $shrunk = ($patchSize -lt 0) -or ($seenPatch -ge 0 -and $patchSize -lt $seenPatch)

  $patchEvidence = ($renamed.Count -gt 0) -and $shrunk
  if (-not $patchEvidence) {
    Log ('还原跳过: 补丁层证据不足（上次 ' + $thirdPartySeen.Count + ' 个第三方 → 现在 0 个）')
    Log ('  依据: 本次改名备份 ' + $renamed.Count + ' 份 / 补丁 ' + $seenPatch + ' → ' + $patchSize + ' 字节 / 记录时间 ' + $seen.at)
    Say '  插件列表突然清空，但补丁层变化对不上，未自动还原'
    Say '  如确认是意外重置，运行: node bin/guard.mjs restore --apply'
    return $false
  }

  $baks = @(Get-ChildItem $Profile -Filter 'package.json.bak-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
  $best = $null
  $bestList = @()
  # 优先选"确实包含记录里那些插件"的备份，其次才是任意含第三方的备份。
  # 否则可能用一份更老、内容不同的备份覆盖当前状态。
  $fallback = $null
  $fallbackList = @()
  foreach ($b in $baks) {
    try { $l = @((Read-Json $b.FullName).dsh.profile.bundles) } catch { continue }
    $thirdInBak = @($l | Where-Object { $_ -and $_ -notlike '@deepseek-ai/*' })
    if ($thirdInBak.Count -eq 0) { continue }
    $overlap = @($thirdInBak | Where-Object { $thirdPartySeen -contains $_ })
    if ($overlap.Count -gt 0) { $best = $b; $bestList = $l; break }
    if ($null -eq $fallback) { $fallback = $b; $fallbackList = $l }
  }
  if ($null -eq $best -and $null -ne $fallback) { $best = $fallback; $bestList = $fallbackList }
  if ($null -eq $best) {
    Log '还原跳过: 备份里没有可恢复的第三方插件'
    return $false
  }

  $keep = @()
  $dropped = @()
  foreach ($n in $bestList) {
    $v = Test-Bundle $n
    if ($v.ok) { $keep += $n } else { $dropped += ($n + ' (' + $v.why + ')') }
  }
  if ($keep.Count -le $cur.Count) { return $false }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Copy-Item $pkgPath "$pkgPath.bak-restore-$stamp" -Force
  try {
    $m = Read-Json $pkgPath
    $m.dsh.profile.bundles = $keep
    Save-Json $pkgPath $m
  } catch {
    Log ("还原失败: 无法写入 package.json - " + $_.Exception.Message)
    Say '  还原失败：package.json 无法写入'
    return $false
  }

  Log ('还原: 上次 ' + $thirdPartySeen.Count + ' 个第三方 → 现在 0 个，从 ' + $best.Name + ' 恢复 ' + $keep.Count + ' 个')
  if ($dropped.Count -gt 0) { Log ('  跳过: ' + ($dropped -join ', ')) }
  Say ('  已从备份还原 ' + $keep.Count + ' 个插件，跳过 ' + $dropped.Count + ' 个有问题的')
  return $true
}

# 配置损坏时不要假装能读它。四种情况分开处理：
#   a) 文件不存在        -> 用 node_modules 里实际装了的官方包重建
#   b) 文件读不出/解析失败 -> 改名留证，再重建
#   c) 结构缺失          -> 补上结构
#   d) 结构正常          -> 只保留官方
function Repair-Official {
  $pkgPath = Join-Path $Profile 'package.json'
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

  # 官方包清单从磁盘来，不依赖那个坏掉的文件
  $officialOnDisk = @()
  $nmDeepseek = Join-Path (Join-Path $Profile 'node_modules') '@deepseek-ai'
  if (Test-Path $nmDeepseek) {
    $officialOnDisk = @(Get-ChildItem $nmDeepseek -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { '@deepseek-ai/' + $_.Name })
  }

  $m = $null
  $case = 'unknown'
  if (-not (Test-Path $pkgPath)) { $case = 'missing' }
  else {
    try {
      $raw = [System.IO.File]::ReadAllText($pkgPath)
      if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
      $m = $raw | ConvertFrom-Json
      $case = 'parsed'
    } catch { $case = 'corrupt' }
  }

  if ($case -eq 'corrupt') {
    Copy-Item $pkgPath "$pkgPath.bak-corrupt-$stamp" -Force
    Log ("修复: package.json 无法解析，已留证 package.json.bak-corrupt-" + $stamp)
  }
  if ($case -eq 'missing') { Log '修复: package.json 不存在，按磁盘上的官方包重建' }

  if ($null -eq $m) { $m = New-Object psobject }
  if ($null -eq $m.PSObject.Properties['name']) { $m | Add-Member -NotePropertyName name -NotePropertyValue 'desktop' -Force }
  if ($null -eq $m.PSObject.Properties['dsh'] -or $null -eq $m.dsh) {
    $m | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  if ($null -eq $m.dsh.PSObject.Properties['profile'] -or $null -eq $m.dsh.profile) {
    $m.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force
  }

  $official = @()
  if ($null -ne $m.dsh.profile.PSObject.Properties['bundles'] -and $null -ne $m.dsh.profile.bundles) {
    $official = @($m.dsh.profile.bundles | Where-Object { $_ -like '@deepseek-ai/*' })
  }
  if ($official.Count -eq 0) { $official = $officialOnDisk }
  if ($official.Count -eq 0) {
    Log '修复失败: 既读不出官方插件，磁盘上也没有 @deepseek-ai/*'
    Say '  修复失败：找不到任何官方插件，需要手动处理'
    return
  }

  if ($case -ne 'missing') { Copy-Item $pkgPath "$pkgPath.bak-launcher-$stamp" -Force }
  $m.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $official -Force
  try { Save-Json $pkgPath $m } catch {
    Log ("修复失败: 无法写入 package.json - " + $_.Exception.Message)
    Say '  修复失败：package.json 无法写入（可能被占用或没有权限）'
    return
  }

  Log ("修复(" + $case + "): 退回官方 " + $official.Count + " 个")
  Say ("  已退回官方插件 " + $official.Count + " 个（备份: package.json.bak-launcher-" + $stamp + "）")
}

function Repair-Surgical($bad) {
  $pkgPath = Join-Path $Profile 'package.json'
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Copy-Item $pkgPath "$pkgPath.bak-launcher-$stamp" -Force
  $m = Read-Json $pkgPath
  $keep = @($m.dsh.profile.bundles | Where-Object { $bad -notcontains $_ })
  $m.dsh.profile.bundles = $keep
  Save-Json $pkgPath $m
  Log ("修复: 只移除 " + $bad.Count + " 个有问题的 bundle（" + ($bad -join ', ') + "），保留 " + $keep.Count + " 个")
  Say ("  已停用 " + $bad.Count + " 个有问题的插件：" + ($bad -join ', '))
  Say ("  其余 " + $keep.Count + " 个照常加载")
}

if ($Check) {
  $h = Test-Profile
  $Visible = $true
  Say ''
  Say '=== 启动前检查 ==='
  Say "  exe     : $Exe"
  Say "  profile : $Profile"
  if ($h.ok) { Ok '配置正常' } else { Bad "配置有问题: $($h.why)" }
  exit 0
}

if (-not (Test-Path $Exe)) {
  Log "失败: exe 不存在 $Exe"
  Show-Box ("找不到 DeepSeek Harness：" + $NL + $Exe + $NL + $NL + "可能被移动或卸载了。") 'DSH 启动器' 'Error'
  exit 1
}

# ── runtime 目录自愈 ──────────────────────────────────────────────────────
# 桌面端更新器升级时会清空 <install>\\resources\\runtime，而 dsh-skill-office
# 启动时必须读 runtime\\office-skills\\office\\SKILL.md —— readFileSync 抛 ENOENT，
# 整个 host 起不来（2026-11-05 因此连崩四次，重装才恢复）。
# runtime 不在 app.asar 内，只能从已下载的安装包里解出来。
#
# 用"一个文件在不在"当探针，而不是比对整个目录：SKILL.md 缺失正是那次崩溃
# 的报错点，且它足够小、足够稳定，不会因为版本内容变化而误判。
function Test-Runtime {
  $root = Split-Path -Parent $Exe
  $runtime = Join-Path $root 'resources\\runtime'
  if (-not (Test-Path -LiteralPath $runtime -PathType Container)) { return $false }

  # 一个探针只能证明"这一层还在"。runtime 没有整体消失、只是丢了部分文件时，
  # 单个 SKILL.md 完全可能幸存 —— 那样永远不会触发恢复。0.2.2-rc.1 的 runtime
  # 是四个顶层目录加一个 versions.json（实测 6144 个文件）：
  #   bin(2) cli(3) office-skills(8) primary-runtime(6130) versions.json
  # 四个子树缺任何一个都算不完整。
  foreach ($rel in @('versions.json', 'bin', 'cli', 'office-skills', 'primary-runtime')) {
    if (-not (Test-Path -LiteralPath (Join-Path $runtime $rel))) { return $false }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $runtime 'office-skills\\office\\SKILL.md'))) { return $false }

  # 结构对了还要看规模：部分文件缺失时目录仍在。
  try {
    $files = @(Get-ChildItem -LiteralPath $runtime -Recurse -File -ErrorAction SilentlyContinue).Count
    if ($files -lt 5000) { return $false }
  } catch {
    # 无法统计意味着无法证明 runtime 完整；交给恢复分支处理，不做乐观放行。
    Log ('runtime 探针：无法统计文件数，按不完整处理（' + $_.Exception.Message + ')')
    return $false
  }
  return $true
}

# 7-Zip 的探测顺序与 lib/installer.mjs 的 detectExtractor 逐条对齐：
#   env(DSH_7Z / DSH_7ZA) → 随包 vendor → PATH → 注册表 → 常见安装目录
# 顺序不同就会让启动器和检查用上不同的二进制；之前 PATH 和注册表是反的，
# 而且缺了 DSH_7ZA 和常见目录（含 NanaZip、D:\\7-Zip）。
function Find-SevenZip {
  foreach ($name in @('DSH_7Z', 'DSH_7ZA')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value -and (Test-Path -LiteralPath $value -PathType Leaf)) { return $value }
  }
  try {
    $bundled = Join-Path (Split-Path -Parent $PSCommandPath) '..\\vendor\\7z.exe'
    if (Test-Path -LiteralPath $bundled -PathType Leaf) { return (Resolve-Path -LiteralPath $bundled).Path }
  } catch { }
  foreach ($name in @('7z', '7za', '7zz')) {
    try {
      $cmd = Get-Command $name -ErrorAction Stop
      if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source -PathType Leaf)) { return $cmd.Source }
    } catch { }
  }
  foreach ($key in @('HKLM:\\SOFTWARE\\7-Zip', 'HKLM:\\SOFTWARE\\WOW6432Node\\7-Zip')) {
    try {
      $installPath = (Get-ItemProperty -Path $key -ErrorAction Stop).Path
      if ($installPath) {
        foreach ($exe in @('7z.exe', '7za.exe')) {
          $candidate = Join-Path $installPath $exe
          if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        }
      }
    } catch { }
  }
  $roots = @(
    [Environment]::GetEnvironmentVariable('ProgramFiles'),
    [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'),
    $(if ([Environment]::GetEnvironmentVariable('LOCALAPPDATA')) { Join-Path ([Environment]::GetEnvironmentVariable('LOCALAPPDATA')) 'Programs' }),
    'D:\\7-Zip',
    'C:\\7-Zip'
  ) | Where-Object { $_ }
  foreach ($root in $roots) {
    foreach ($rel in @('7-Zip\\7z.exe', '7-Zip\\7za.exe', 'NanaZip\\NanaZip.exe', 'NanaZip\\7z.exe')) {
      $candidate = Join-Path $root $rel
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
  }
  return $null
}

# 从 pending 里的安装包解出 resources\\runtime。返回是否恢复成功。
# 如果 runtime 仍不完整，调用方会阻止启动并提示修复，避免已知必崩的启动循环。
function Repair-Runtime {
  $root = Split-Path -Parent $Exe
  # 只有真实安装才有 resources/。测试用的假 exe 放在临时目录里，没有这一层，
  # 不设这道门的话每个假启动都会去解 292 MB 的包，测试从秒级变成分钟级。
  $resources = Join-Path $root 'resources'
  if (-not (Test-Path -LiteralPath $resources -PathType Container)) {
    Log 'runtime 自愈跳过：安装目录下没有 resources（不是完整安装）'
    return $false
  }
  $pending = Join-Path $env:LOCALAPPDATA '@deepseek-aidsh-desktop-updater\\pending'
  if (-not (Test-Path -LiteralPath $pending)) { Log 'runtime 自愈跳过：没有 pending 目录'; return $false }
  $installer = Get-ChildItem -LiteralPath $pending -Filter 'deepseek-harness-*.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $installer) { Log 'runtime 自愈跳过：pending 里没有安装包'; return $false }
  $seven = Find-SevenZip
  if (-not $seven) { Log 'runtime 自愈跳过：找不到 7-Zip'; return $false }

  $work = Join-Path $env:TEMP ('dsh-runtime-restore-' + $PID)
  try {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    Log ('runtime 自愈：从 ' + $installer.Name + ' 解包（7z: ' + $seven + '）')

    # 第一层：NSIS 里的 app-64.7z
    & $seven e $installer.FullName '$PLUGINSDIR\\app-64.7z' "-o$work" -y 2>&1 | Out-Null
    $payload = Join-Path $work 'app-64.7z'
    if (-not (Test-Path -LiteralPath $payload)) { Log 'runtime 自愈失败：安装包里没有 app-64.7z'; return $false }

    # 第二层：只解 runtime 子树，直接落到安装根目录（包内路径就带 resources\\）
    #
    # 7-Zip 的退出码必须看：0 是全部成功，1 是「有警告但完成」，>=2 是出错。
    # 之前只检查探针文件在不在 —— 解到一半失败、探针恰好先落地，就会被报成
    # 「恢复成功」，而 runtime 其余文件仍然缺失，下一次启动照样可能崩。
    & $seven x $payload 'resources\\runtime\\*' "-o$root" -y 2>&1 | Out-Null
    $extractCode = $LASTEXITCODE
    if ($extractCode -gt 1) {
      Log ('runtime 自愈失败：7-Zip 解包退出码 ' + $extractCode)
      return $false
    }

    if (-not (Test-Runtime)) {
      Log 'runtime 自愈失败：解包已完成但探针文件仍然不存在'
      return $false
    }

    # 单一探针只证明解包开了个头。用文件数做一个下界：0.2.2-rc.1 实测 6144 个，
    # 定 5000 既容忍版本间增减，又能挡住「只解出一部分」。
    try {
      $actual = @(Get-ChildItem -LiteralPath (Join-Path $root 'resources\\runtime') -Recurse -File -ErrorAction SilentlyContinue).Count
      if ($actual -lt 5000) {
        Log ('runtime 自愈失败：解出 ' + $actual + ' 个文件，少于预期的 5000')
        return $false
      }
      Log ('runtime 自愈完成：' + $actual + ' 个文件')
    } catch {
      Log ('runtime 自愈失败：无法验证解包后的文件数（' + $_.Exception.Message + ')')
      return $false
    }

    return $true
  } catch {
    Log ('runtime 自愈异常: ' + $_.Exception.Message)
    return $false
  } finally {
    try { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue } catch { }
  }
}

$repaired = $false

# "崩溃后自动还原" 开关：配置被重置过就从备份恢复，只跳过坏的。
$guardCfg = Get-GuardConfig
if ($guardCfg.autoRestore) {
  try {
    if (Restore-Surgical) { $repaired = $true }
  } catch {
    Log ("还原失败（继续启动）: " + $_.Exception.Message)
  }
}

if ($Repair) {
  $h0 = Test-Profile
  if ($h0.ok) { Log '按参数要求修复，但配置本来就是好的，不做改动' }
  elseif ($h0.bad.Count -gt 0) { Repair-Surgical $h0.bad; $repaired = $true }
  else { Repair-Official; $repaired = $true }
  Log '按参数要求先做了修复'
}

# 最多三次。第 1、2 次不动配置；只有在用户通过消息框点头之后，才做破坏性的第 3 次。
for ($attempt = 1; $attempt -le 3; $attempt++) {
  $health = Test-Profile
  if (-not $health.ok -and -not $repaired) {
    Log ("配置校验失败: " + $health.why)
    Say ("配置有问题: " + $health.why)
    if ($health.bad.Count -gt 0) {
      # 只摘掉真正过不了校验的那几个，其余原样保留。
      Repair-Surgical $health.bad
    } else {
      Repair-Official
    }
    $repaired = $true
  }

  # 记录"我这次看到的清单"：判定意外重置时以它为准。检查模式下也记，
  # 否则只用 -Check 的人永远不会积累证据。
  Save-Seen

  # 启动前清理堆积的 dsh-auth cookie。
  #
  # 宿主按 host:port 给 cookie 起名，而 cookie 是按 domain/path/name 存的 ——
  # 桌面端每次启动换一个随机端口，就多一条永不淘汰的 cookie。七十来条之后
  # 请求头越过 Node 的 16 KB 上限，每个请求都在解析阶段就 431，界面报
  # "Web authentication failed"。
  #
  # 只能在这里做：此刻应用还没起来，cookie 库没有被独占锁住。
  Prune-StaleAuthCookies

  # runtime 目录预检：更新器升级时会把 resources\\runtime 清空，而
  # dsh-skill-office 启动要读里面的 SKILL.md，读不到就整个 host 起不来。
  # 必须在 Start-Process 之前补回来，否则这一次启动注定崩溃。
  if (-not (Test-Runtime)) {
    Log 'runtime 目录不完整（疑似被更新器清空），尝试从安装包恢复'
    Say 'runtime 目录缺失，正在从安装包恢复…'
    $restored = $false
    try { $restored = Repair-Runtime } catch { Log ('runtime 自愈调用失败: ' + $_.Exception.Message) }
    if ($restored -and (Test-Runtime)) {
      Log 'runtime 恢复成功'
      Ok 'runtime 目录已恢复'
    } else {
      $message = 'DSH runtime 目录仍不完整，已阻止启动以避免重复崩溃。' + $NL + $NL +
        '当前 pending 安装包可能不存在、版本不匹配，或 7-Zip 无法完成恢复。' + $NL +
        '请使用与当前 DSH 版本一致的安装程序执行修复/重新安装。' + $NL + $NL +
        '若确认 runtime 实际可用，可设置 DSH_LAUNCHER_FORCE_START=1 后再次启动。' + $NL + $NL +
        '详细原因见：' + $LogFile
      Log 'runtime 仍不完整：停止启动；需要修复或重新安装当前版本'

      # 逃生门。这个判定是启发式的（四个子树 + versions.json + 文件数），依据的
      # 是 0.2.2-rc.1 的目录布局。一旦它假阴性 —— 版本改了布局、装在非常规位置、
      # 或 Get-ChildItem 因权限报错 —— 用户就被彻底锁在门外，而这个工具的本职是
      # "别崩溃"，不是"别启动"。所以留一个显式覆盖。
      if ($env:DSH_LAUNCHER_FORCE_START -eq '1') {
        Log 'DSH_LAUNCHER_FORCE_START=1：忽略完整性判定，继续启动'
      } else {
        Show-Box $message 'DSH 启动器' 'Error'
        exit 1
      }
    }
  }

  if ($NoStart) { Log '仅检查，不启动'; exit 0 }

  Log ("尝试启动 #" + $attempt)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    # Same working directory the shipped shortcut uses; some resources resolve
    # relative to it.
    $spArgs = @{ FilePath = $Exe; WorkingDirectory = (Split-Path -Parent $Exe); PassThru = $true }
    if ($env:DSH_LAUNCHER_ARGS) { $spArgs['ArgumentList'] = $env:DSH_LAUNCHER_ARGS }
    # 测试专用开关，与 DSH_LAUNCHER_QUIET 分开。
    # 原来挂在 QUIET 上是错的：QUIET 只该管"弹不弹对话框"，如果它同时决定应用
    # 窗口是否隐藏，一旦有人在环境里设了 QUIET，DSH 主界面就会被一起藏掉。
    if ($env:DSH_LAUNCHER_TEST_HIDE_WINDOW -eq '1') { $spArgs['WindowStyle'] = 'Hidden' }
    $p = Start-Process @spArgs
  } catch {
    Log "启动抛错: $($_.Exception.Message)"
    Show-Box ("无法启动 DeepSeek Harness：" + $NL + $($_.Exception.Message)) 'DSH 启动器' 'Error'
    exit 1
  }
  $p.WaitForExit()
  $sw.Stop()
  $seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)

  # 被外部终止（关窗口/控制台）不是启动失败，更不能据此改配置。
  if ($p.ExitCode -eq $EXTERNAL_TERMINATION) {
    Log ("进程被外部终止（退出码 " + $p.ExitCode + "，运行 " + $seconds + " 秒），不算启动失败")
    exit 0
  }

  # A clean exit, or a long run, means startup succeeded.
  if ($p.ExitCode -eq 0 -or $seconds -ge 30) {
    Log ("启动成功: 运行 " + $seconds + " 秒，退出码 " + $p.ExitCode)
    exit 0
  }

  Log ("启动失败: " + $seconds + " 秒，退出码 " + $p.ExitCode)
  Say ("启动失败：" + $seconds + " 秒后退出（退出码 " + $p.ExitCode + "）")

  if ($attempt -eq 1) { continue }        # 第二次仍按原配置重试，不动任何东西

  if ($attempt -eq 2) {
    # 换配置是有代价的（会少加载插件），必须由用户决定，而不是脚本自作主张。
    Log '两次失败，询问用户是否停用第三方插件'
    $answer = Show-Box-Ask ("DeepSeek Harness 连续两次启动失败（" + $seconds + " 秒后退出）。" + $NL + $NL +
      "可以停用全部第三方插件再试一次，但那样所有插件都不会加载。" + $NL + $NL +
      "点「是」停用第三方插件后重试；点「否」就此停下、不改任何配置。")
    if ($answer -ne 'yes') { Log '用户选择不改配置'; exit 1 }
    Repair-Official
    $repaired = $true
    continue
  }

  Log '第三次仍失败，放弃'
  Show-Box ("DeepSeek Harness 启动失败。" + $NL + $NL +
    "已停用第三方插件并备份了配置，仍然起不来。" + $NL + $NL +
    "问题很可能不在插件。配置备份在 profile 目录下的 package.json.bak-launcher-*。") 'DSH 启动器' 'Error'
  exit 1
}
exit 1
`
}

const GENERATED = ['dsh-launch.ps1', 'dsh-launch.cmd', 'dsh-launch.vbs']

/**
 * Ensure the launch wrapper and shortcut exist and match this install.
 * Idempotent: safe to call on every start.
 *
 * @param {{exePath?: string, profileDir?: string, pkgDir: string, shortcutName?: string}} opts
 * @returns {{ok: boolean, dir?: string, vbs?: string, shortcut?: string, reason?: string}}
 */
export function ensureLauncher (opts) {
  const pkgDir = opts.pkgDir
  const exe = resolveDesktopExe(opts.exePath)
  const profileDir = opts.profileDir
  if (exe === undefined || profileDir === undefined) return { ok: false, reason: 'missing-inputs' }

  const dir = join(pkgDir, 'rescue')
  const ps1Path = join(dir, 'dsh-launch.ps1')
  const cmdPath = join(dir, 'dsh-launch.cmd')
  const vbsPath = join(dir, 'dsh-launch.vbs')
  const stampPath = join(dir, '.generated.json')

  const cfg = { exe, profileDir, pkgDir }

  try {
    const complete = GENERATED.every(f => existsSync(join(dir, f)))
    if (complete && existsSync(stampPath)) {
      try {
        const prev = JSON.parse(readFileSync(stampPath, 'utf8'))
        // Reuse only when the files AND the shortcut still match. The stamp alone
        // is not proof: the desktop icon gets reset to the bare executable by the
        // app, by an update, or by a user who deleted and recreated it. Skipping
        // on an unchanged stamp leaves the guard permanently disarmed — exactly
        // when self-heal is supposed to matter.
        const shortcutStillMine = opts.manageShortcut === false || isOurShortcut(prev.shortcut)
        if (shortcutStillMine &&
            prev.exe === cfg.exe && prev.profileDir === cfg.profileDir && prev.pkgDir === cfg.pkgDir) {
          return { ok: true, dir, vbs: vbsPath, shortcut: prev.shortcut }
        }
      } catch { /* regenerate */ }
    }

    mkdirSync(dir, { recursive: true })

    // .cmd: ASCII, CRLF, no BOM — cmd.exe mis-reads anything else.
    writeFileSync(cmdPath, Buffer.from(CMD_BODY, 'ascii'))

    // .vbs: ASCII, CRLF. wscript has no console, so this is the silent entry.
    writeFileSync(vbsPath, Buffer.from(VBS_BODY, 'ascii'))

    // .ps1: UTF-8 WITH BOM so Windows PowerShell 5.1 decodes the Chinese text.
    const ps1 = launcherPs1(cfg).replace(/\r?\n/g, '\r\n')
    writeFileSync(ps1Path, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(ps1, 'utf8')]))

    // Shortcut -> wscript.exe (GUI subsystem: never allocates a console).
    // Prefer repointing the icon the user already has over adding a second one.
    //
    // `manageShortcut: false` keeps this function to file generation only. Any
    // caller that just wants the wrapper (tests, diagnostics, another machine's
    // dry run) must pass it, because otherwise a stray call silently rewrites
    // the user's desktop icon — which is exactly how a desktop shortcut once got
    // pointed at a temp directory.
    let shortcut
    const desk = opts.manageShortcut === false ? undefined : desktopDir()
    if (desk !== undefined) {
      const wscript = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe')
      const targetExe = existsSync(wscript) ? wscript : 'wscript.exe'
      const args = `//nologo "${vbsPath}"`

      const existing = findShortcutForExe(desk, exe)
      if (existing !== undefined) {
        // Keep the user's original target, but NOT beside it: a `*.lnk.bak-*`
        // sitting on the desktop renders as a blank file icon and confuses the
        // very people this tool is meant to help.
        try {
          const bakDir = join(dir, 'shortcut-backups')
          mkdirSync(bakDir, { recursive: true })
          const bak = join(bakDir, basenameOf(existing))
          if (!existsSync(bak)) copyFileSync(existing, bak)
        } catch { /* backup is best effort */ }
        shortcut = writeShortcut(existing, targetExe, args, dir,
          'DeepSeek Harness（启动失败自动修复）', exe)
      } else {
        const linkName = opts.shortcutName ?? 'DeepSeek Harness.lnk'
        shortcut = writeShortcut(join(desk, linkName), targetExe, args, dir,
          'DeepSeek Harness（启动失败自动修复）', exe)
      }
    }

    writeFileSync(stampPath, JSON.stringify({ ...cfg, shortcut, at: new Date().toISOString() }, null, 2), 'utf8')
    return { ok: true, dir, vbs: vbsPath, shortcut }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * What the launcher currently owns on this machine.
 * @returns {{generated: boolean, files: string[], shortcut: (string|undefined), target: (string|undefined), backupCount: number}}
 */
/**
 * Every desktop icon that currently starts our wrapper.
 *
 * A stale stamp is not hypothetical: the stamp once recorded a shortcut that was
 * then deleted by hand, so the restore step was skipped and the generated
 * scripts were removed while the real icon still pointed at them — a desktop
 * icon that does nothing. Scanning for whoever actually points at the wrapper
 * removes the dependency on the stamp being right.
 */
function findLauncherShortcuts () {
  const desk = desktopDir()
  if (desk === undefined) return []
  let names
  try { names = readdirSync(desk).filter(f => f.toLowerCase().endsWith('.lnk')) } catch { return [] }
  const found = []
  for (const name of names) {
    const p = join(desk, name)
    const info = probeShortcut(p)
    if (info !== undefined && String(info.args ?? '').includes('dsh-launch.vbs')) found.push(p)
  }
  return found
}

export function launcherState ({ pkgDir }) {
  const dir = join(pkgDir, 'rescue')
  const stamp = join(dir, '.generated.json')
  let record
  try { record = JSON.parse(readFileSync(stamp, 'utf8')) } catch { record = undefined }

  const files = GENERATED.map(f => join(dir, f)).filter(p => existsSync(p))
  let target
  if (record?.shortcut !== undefined && existsSync(record.shortcut)) {
    const info = probeShortcut(record.shortcut)
    // A missing .lnk still returns a COM object, and its empty fields parse as
    // junk like ",0". Only trust a value that looks like a path.
    const t = info?.target ?? ''
    if (t.length > 2 && !t.startsWith(',')) target = t
  }
  let backupCount = 0
  try { backupCount = readdirSync(join(dir, 'shortcut-backups')).length } catch { /* none */ }

  return {
    generated: record !== undefined && files.length > 0,
    files,
    shortcut: record?.shortcut,
    target,
    backupCount,
  }
}

/**
 * Undo the launcher: point the shortcut back at the app and drop our files.
 *
 * "Turn the feature off" has to mean the machine goes back to how it was.
 * Leaving a shortcut aimed at a wrapper nobody maintains is worse than never
 * having installed one.
 */
export function removeLauncher ({ pkgDir, manageShortcut = true, dryRun = false }) {
  const dir = join(pkgDir, 'rescue')
  const state = launcherState({ pkgDir })
  const removed = []

  if (!state.generated && state.shortcut === undefined) {
    return { dryRun, restoredShortcut: undefined, removed, note: '没有生成过启动器' }
  }

  const appExe = resolvedAppExe(dir, state.target)

  if (dryRun) {
    return {
      dryRun: true,
      restoreTo: appExe,
      restoredShortcut: state.shortcut,
      removed: state.files,
      note: state.shortcut
        ? ('会把快捷方式指回 ' + (appExe ?? '(原程序)'))
        : undefined,
    }
  }

  let restoredShortcut
  let note
  if (manageShortcut && appExe !== undefined) {
    // Restore the recorded icon AND anything else pointing at the wrapper: the
    // stamp may name a file that no longer exists while the real icon still
    // depends on these scripts.
    const targets = new Set()
    if (state.shortcut !== undefined && existsSync(state.shortcut)) targets.add(state.shortcut)
    for (const p of findLauncherShortcuts()) targets.add(p)

    for (const p of targets) {
      const kept = probeShortcut(p)
      const done = writeShortcut(p, appExe, '', dirnameOf(appExe), 'DeepSeek Harness', kept?.icon)
      if (done !== undefined && restoredShortcut === undefined) restoredShortcut = done
    }
    if (targets.size > 0 && restoredShortcut === undefined) {
      note = '快捷方式未能还原，请手动改回指向应用主程序'
    }
  }

  // Deleting the scripts while the icon still points at them is how a user ends
  // up with a desktop icon that does nothing. That happened once: the config was
  // off, something removed the files, and the shortcut kept aiming at
  // dsh-launch.vbs. If the shortcut could not be pointed back, the scripts are
  // the only thing keeping the icon working, so they stay.
  if (manageShortcut && state.shortcut !== undefined && existsSync(state.shortcut) &&
      restoredShortcut === undefined && isOurShortcut(state.shortcut)) {
    Log('撤销中止: 快捷方式仍指向启动器且无法还原，保留生成的文件')
    return {
      dryRun: false,
      restoredShortcut: undefined,
      removed: [],
      note: '快捷方式没能指回应用，保留启动脚本以免图标失效。请先手动还原快捷方式',
    }
  }

  for (const f of state.files) {
    try { rmSync(f, { force: true }); removed.push(f) } catch { /* locked */ }
  }
  try { rmSync(join(dir, '.generated.json'), { force: true }) } catch { /* ignore */ }

  return { dryRun: false, restoredShortcut, removed, note }
}

/** The app executable a restored shortcut should point at. */
function resolvedAppExe (dir, currentTarget) {
  if (currentTarget !== undefined && !/wscript/i.test(currentTarget)) return currentTarget
  try { return JSON.parse(readFileSync(join(dir, '.generated.json'), 'utf8')).exe } catch { return undefined }
}

function dirnameOf (p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf(String.fromCharCode(92)))
  return i > 0 ? p.slice(0, i) : p
}

/** Files the launcher needs, for diagnostics. */
export function launcherFiles (pkgDir) {
  const dir = join(pkgDir, 'rescue')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.startsWith('dsh-launch'))
}

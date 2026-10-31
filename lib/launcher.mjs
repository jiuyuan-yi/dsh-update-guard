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
import { join, basename } from 'node:path'
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
function findShortcutForExe (desk, exe) {
  let names
  try { names = readdirSync(desk).filter(f => f.toLowerCase().endsWith('.lnk')) } catch { return undefined }
  for (const name of names) {
    const p = join(desk, name)
    const info = probeShortcut(p)
    if (info === undefined || !info.target) continue
    if (info.target.toLowerCase() === exe.toLowerCase()) return p
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
$NL        = [Environment]::NewLine
# Baked from lib/run.mjs CONFIG_DEFAULTS. PowerShell must not keep its own copy of
# a default: two sources drift, and the one that runs is not the one documented.
$DefaultAutoRestore = $${CONFIG_DEFAULTS.autoRestore === true ? 'true' : 'false'}

function Log($t) {
  try {
    [System.IO.File]::AppendAllText($LogFile, ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $t + $NL), (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

Log '--- 启动器被调用 ---'

# 只有一个启动器能跑。用户连点几下图标时，多个实例会互相判对方的进程为"启动失败"，
# 于是弹出修复询问，把人吓住。互斥量把这件事从根上掐掉。
$mutex = $null
$gotMutex = $false
try {
  $mutex = New-Object System.Threading.Mutex($false, 'Local\dsh-update-guard-launcher')
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
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    [void][System.Windows.Forms.MessageBox]::Show($text, $title, [System.Windows.Forms.MessageBoxButtons]::OK, $icon)
  } catch {
    try { Write-Host $text } catch { }
  }
}

# Yes/No, defaulting to No: any destructive step must be opted into explicitly.
function Show-Box-Ask($text) {
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
    if ($name -like '@deepseek-ai/*') { continue }
    $dir = Join-Path $Profile ('node_modules\\' + ($name -replace '/', '\\'))
    if (-not (Test-Path (Join-Path $dir 'package.json'))) { $bad += $name; continue }
    try { $bm = Read-Json (Join-Path $dir 'package.json') } catch { $bad += $name; continue }
    if ($null -eq $bm.dsh -or $null -eq $bm.dsh.bundle) { $bad += $name; continue }
    foreach ($f in @($bm.dsh.bundle.patch)) {
      if (-not (Test-Path (Join-Path $dir $f))) { $bad += $name; break }
    }
  }
  return @{ ok = ($bad.Count -eq 0); why = ($bad -join ', '); bad = $bad }
}

function Test-Bundle($name) {
  if ($name -like '@deepseek-ai/*') { return @{ ok = $true } }
  $dir = Join-Path $Profile ('node_modules\\' + ($name -replace '/', '\\'))
  if (-not (Test-Path (Join-Path $dir 'package.json'))) { return @{ ok = $false; why = '包未安装' } }
  try { $bm = Read-Json (Join-Path $dir 'package.json') } catch { return @{ ok = $false; why = 'package.json 无法解析' } }
  if ($null -eq $bm.dsh -or $null -eq $bm.dsh.bundle) { return @{ ok = $false; why = '缺 dsh.bundle' } }
  foreach ($f in @($bm.dsh.bundle.patch)) {
    if (-not (Test-Path (Join-Path $dir $f))) { return @{ ok = $false; why = ('patch 缺失: ' + $f) } }
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
function Restore-Surgical {
  $pkgPath = Join-Path $Profile 'package.json'
  $cur = @()
  try { $cur = @((Read-Json $pkgPath).dsh.profile.bundles) } catch { $cur = @() }

  $best = $null
  $bestList = @()
  $baks = @(Get-ChildItem $Profile -Filter 'package.json.bak-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
  foreach ($b in $baks) {
    try { $l = @((Read-Json $b.FullName).dsh.profile.bundles) } catch { continue }
    if ($l.Count -gt $bestList.Count) { $best = $b; $bestList = $l }
  }
  if ($null -eq $best -or $bestList.Count -le $cur.Count) { return $false }

  $keep = @()
  $dropped = @()
  foreach ($n in $bestList) {
    $v = Test-Bundle $n
    if ($v.ok) { $keep += $n } else { $dropped += ($n + ' (' + $v.why + ')') }
  }
  if ($keep.Count -le $cur.Count) { return $false }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Copy-Item $pkgPath "$pkgPath.bak-restore-$stamp" -Force
  $m = Read-Json $pkgPath
  $m.dsh.profile.bundles = $keep
  Save-Json $pkgPath $m

  Log ("还原: 从 " + $best.Name + " 恢复 " + $keep.Count + " 个（原来只有 " + $cur.Count + " 个）")
  if ($dropped.Count -gt 0) { Log ("  跳过: " + ($dropped -join ', ')) }
  Say ("  已从备份还原 " + $keep.Count + " 个插件，跳过 " + $dropped.Count + " 个有问题的")
  return $true
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

# 只有在 package.json 完全读不出来时才走这条：那时无法判断谁坏，只能退回官方。
function Repair-Official {
  $pkgPath = Join-Path $Profile 'package.json'
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Copy-Item $pkgPath "$pkgPath.bak-launcher-$stamp" -Force
  $m = Read-Json $pkgPath
  $official = @($m.dsh.profile.bundles | Where-Object { $_ -like '@deepseek-ai/*' })
  $m.dsh.profile.bundles = $official
  Save-Json $pkgPath $m
  Log ("修复: 配置不可解析，退回官方 " + $official.Count + " 个")
  Say ("  已退回官方插件 " + $official.Count + " 个（备份: package.json.bak-launcher-" + $stamp + "）")
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

  if ($NoStart) { Log '仅检查，不启动'; exit 0 }

  Log ("尝试启动 #" + $attempt)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    # Same working directory the shipped shortcut uses; some resources resolve
    # relative to it.
    $p = Start-Process -FilePath $Exe -WorkingDirectory (Split-Path -Parent $Exe) -PassThru
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
  if (manageShortcut && state.shortcut !== undefined && existsSync(state.shortcut)) {
    const exe = appExe
    if (exe !== undefined) {
      const kept = probeShortcut(state.shortcut)
      restoredShortcut = writeShortcut(state.shortcut, exe, '', dirnameOf(exe), 'DeepSeek Harness', kept?.icon)
    }
    if (restoredShortcut === undefined) note = '快捷方式未能还原，请手动改回指向应用主程序'
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

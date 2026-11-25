/**
 * Behaviour test for the runtime key-file manifest in the generated launcher.
 *
 * The probe used to decide "runtime is complete" by counting files. A count cannot
 * tell a healthy tree from one whose entry points were truncated: the number stays
 * right while `cli/command-manager.js` is half-written. This test builds a fake
 * runtime, generates a real baseline through the generated PowerShell, and then
 * proves four properties:
 *
 *   1. a clean tree passes,
 *   2. a same-size content change fails (a count would have passed it),
 *   3. a deleted key file fails,
 *   4. a changed versions.json skips the manifest (a new version legitimately has
 *      different entry points; pinning it would deadlock every upgrade).
 *
 * Skips when there is no DSH executable to generate a launcher for, which is the
 * normal case on CI and on a fresh machine.
 */
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

function findExe () {
  if (process.env.DSH_LAUNCHER_TEST_EXE) return process.env.DSH_LAUNCHER_TEST_EXE
  try {
    const stamp = JSON.parse(readFileSync(join(PKG, 'rescue', '.generated.json'), 'utf8'))
    return stamp.exe
  } catch {
    return undefined
  }
}

function findShell () {
  for (const name of ['pwsh', 'powershell']) {
    const r = spawnSync(name, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' })
    if (r.status === 0) return name
  }
  return undefined
}

const DRIVER = String.raw`
param([string]$Ps1, [string]$Work)

$ErrorActionPreference = 'Stop'
$NL = [Environment]::NewLine
$LogFile = Join-Path $Work 'probe.log'
$steps = @()

function Note($name, $ok, $detail) {
  $script:steps += [ordered]@{ name = $name; ok = [bool]$ok; detail = [string]$detail }
}

try {
$text = Get-Content -LiteralPath $Ps1 -Raw
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$null, [ref]$parseErrors)
if ($parseErrors -and $parseErrors.Count -gt 0) {
  Note 'parse' $false ($parseErrors[0].Message)
  [ordered]@{ ok = $false; steps = $script:steps } | ConvertTo-Json -Compress -Depth 5
  exit 0
}
$script:UGScriptPath = Join-Path $Work 'rescue\dsh-launch.ps1'
$fnAsts = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true))
foreach ($f in $fnAsts) {
  # The generated script locates rescue\ through $PSCommandPath. A harness is not
  # that script, and assigning the automatic variable does not reach into a
  # function, so route this one lookup to an injected path instead of pretending
  # to be a file.
  $src = $f.Extent.Text -replace '\$PSCommandPath', '$script:UGScriptPath'
  . ([scriptblock]::Create($src))
}
Note 'parse' ($fnAsts.Count -gt 0) ($fnAsts.Count.ToString() + ' functions')

# A fake install. Test-Runtime only needs the tree and the parent of $Exe.
$root = Join-Path $Work 'install'
$runtime = Join-Path $root 'resources\runtime'
New-Item -ItemType Directory -Path (Join-Path $runtime 'bin') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $runtime 'cli') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $runtime 'primary-runtime') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $runtime 'versions.json') -Value '{"schemaVersion":1,"node":"1.0.0"}' -NoNewline -Encoding UTF8
Set-Content -LiteralPath (Join-Path $runtime 'bin\node.txt') -Value 'AAAA' -NoNewline -Encoding UTF8
Set-Content -LiteralPath (Join-Path $runtime 'cli\command-manager.js') -Value 'module.exports={}' -NoNewline -Encoding UTF8
Set-Content -LiteralPath (Join-Path $runtime 'primary-runtime\runtime.json') -Value '{"ok":true}' -NoNewline -Encoding UTF8

$script:Exe = Join-Path $root 'DeepSeek Harness.exe'
$rescue = Join-Path $Work 'rescue'
New-Item -ItemType Directory -Path $rescue -Force | Out-Null
Note 'pscmdpath-points-at-rescue' ((Split-Path -Parent $script:UGScriptPath) -eq $rescue) $script:UGScriptPath

$script:LastRuntimeFiles = 0
Note 'exe-visible' ([bool]$Exe) $Exe
Note 'runtime-tree' (Test-Path -LiteralPath $runtime -PathType Container) $runtime
$probeKeys = @(Get-RuntimeKeyFiles $runtime)
Note 'keyfiles' ($probeKeys.Count -ge 3) ($probeKeys -join ',')
Save-RuntimeBaseline
$baselinePath = Join-Path $rescue 'runtime-baseline.json'
Note 'baseline-written' (Test-Path -LiteralPath $baselinePath) $baselinePath

$baseline = Get-Content -LiteralPath $baselinePath -Raw | ConvertFrom-Json
$manifest = @($baseline.manifest)
Note 'manifest-has-entries' ($manifest.Count -ge 3) ($manifest.Count.ToString() + ' entries')
$paths = @($manifest | ForEach-Object { $_.path })
Note 'manifest-covers-bin' ($paths -contains 'bin\node.txt') ($paths -join ',')
Note 'manifest-covers-cli' ($paths -contains 'cli\command-manager.js') ''
Note 'manifest-covers-versions' ($paths -contains 'versions.json') ''

Note 'clean-tree-passes' (Test-Runtime) ''

# Same size, different bytes: a file count cannot see this, a digest must.
Set-Content -LiteralPath (Join-Path $runtime 'bin\node.txt') -Value 'BBBB' -NoNewline -Encoding UTF8
Note 'same-size-change-fails' (-not (Test-Runtime)) ''

Set-Content -LiteralPath (Join-Path $runtime 'bin\node.txt') -Value 'AAAA' -NoNewline -Encoding UTF8
Note 'restored-passes-again' (Test-Runtime) ''

Remove-Item -LiteralPath (Join-Path $runtime 'cli\command-manager.js') -Force
Note 'deleted-key-file-fails' (-not (Test-Runtime)) ''

# A new version ships different entry points; the old manifest must not veto it.
Set-Content -LiteralPath (Join-Path $runtime 'cli\command-manager.js') -Value 'module.exports={}' -NoNewline -Encoding UTF8
Set-Content -LiteralPath (Join-Path $runtime 'versions.json') -Value '{"schemaVersion":1,"node":"2.0.0"}' -NoNewline -Encoding UTF8
Note 'version-bump-skips-manifest' (Test-Runtime) ''
} catch {
  Note 'driver-error' $false ($_.Exception.Message)
}

[ordered]@{ ok = (($script:steps | Where-Object { -not $_.ok }).Count -eq 0); steps = $script:steps } | ConvertTo-Json -Compress -Depth 5
`

const exe = findExe()
if (!exe || !existsSync(exe)) {
  console.log('SKIP: 没有可用的 DSH 可执行文件（设 DSH_LAUNCHER_TEST_EXE，或先生成启动器）')
  process.exit(0)
}

const shell = findShell()
if (shell === undefined) {
  console.log('SKIP: 找不到 PowerShell')
  process.exit(0)
}

console.log('\n[runtime-manifest] 关键清单校验')

const work = mkdtempSync(join(tmpdir(), 'ug-manifest-'))
try {
  // Generate with the real template, but into a throwaway package dir.
  const mod = await import(new URL('../lib/launcher.mjs', import.meta.url).href)
  const gen = mod.ensureLauncher({
    exePath: exe,
    profileDir: join(work, 'profile'),
    pkgDir: join(work, 'pkg'),
    manageShortcut: false,
  })
  check('生成启动器', gen.ok === true, JSON.stringify(gen.reason ?? ''))
  const ps1 = join(work, 'pkg', 'rescue', 'dsh-launch.ps1')
  check('ps1 存在', existsSync(ps1))

  if (existsSync(ps1)) {
    const driver = join(work, 'driver.ps1')
    // UTF-8 with BOM: Windows PowerShell 5.1 decodes BOM-less UTF-8 as ANSI.
    writeFileSync(driver, Buffer.concat([
      Buffer.from([0xEF, 0xBB, 0xBF]),
      Buffer.from(DRIVER, 'utf8'),
    ]))
    const workDir = join(work, 'run')
    mkdirSync(workDir, { recursive: true })

    const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver, ps1, workDir], {
      encoding: 'utf8',
      timeout: 120000,
    })
    const stdout = (r.stdout ?? '').trim()
    const last = stdout.split(/\r?\n/).filter(l => l.trim().startsWith('{')).pop()
    let result
    try { result = JSON.parse(last) } catch { result = undefined }
    if (result === undefined) {
      check('驱动脚本产出结果', false, (stdout + (r.stderr ?? '')).slice(0, 300))
    } else {
      for (const step of result.steps) {
        check(step.name, step.ok === true, step.detail)
      }
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

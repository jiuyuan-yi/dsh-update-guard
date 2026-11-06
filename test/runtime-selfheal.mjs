/**
 * Regression test for the runtime self-heal path in the generated launcher.
 *
 * The failure this pins down: the desktop updater wipes
 * `<install>\resources\runtime` on upgrade, and `dsh-skill-office` reads
 * `runtime\office-skills\office\SKILL.md` during startup with `readFileSync`.
 * A missing file is an ENOENT inside a Fiber, so the whole host fails to boot —
 * four consecutive crashes on 2026-11-05, recoverable only by reinstalling.
 *
 * Two separate classes of defect are covered here:
 *
 *   1. The feature is present and wired before Start-Process.
 *   2. The generated PowerShell is not corrupted by JavaScript escape
 *      sequences. `launcherPs1()` builds the script as a template literal, so a
 *      lone `\r` in a Windows path becomes a carriage return and breaks the line
 *      it sits in. That actually happened: a comment containing
 *      `resources\runtime` was split into `resources` + `untime`, and PowerShell
 *      tried to execute `untime` as a command.
 */
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = readFileSync(join(PKG, 'lib', 'launcher.mjs'), 'utf8')

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

// Rebuild the PowerShell body the same way ensureLauncher() does, without
// touching the real rescue directory or the desktop shortcut.
async function generate () {
  const mod = await import(new URL('../lib/launcher.mjs', import.meta.url).href)
  const dir = mkdtempSync(join(tmpdir(), 'ug-runtime-'))
  try {
    const r = mod.ensureLauncher({
      pkgDir: dir,
      profileDir: join(dir, 'profile'),
      manageShortcut: false,
    })
    const ps1 = join(dir, 'rescue', 'dsh-launch.ps1')
    const text = existsSync(ps1) ? readFileSync(ps1, 'utf8') : null
    return { result: r, text }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n[1] 源码含 runtime 自愈的两个函数')
{
  check('定义 Test-Runtime', /function Test-Runtime\s*\{/.test(SRC))
  check('定义 Find-SevenZip', /function Find-SevenZip\s*\{/.test(SRC))
  check('定义 Repair-Runtime', /function Repair-Runtime\s*\{/.test(SRC))
}

console.log('\n[2] 7-Zip 探测覆盖四种来源')
{
  check('环境变量 DSH_7Z', /DSH_7Z/.test(SRC))
  check('环境变量 DSH_7ZA（与 installer.mjs 一致）', /DSH_7ZA/.test(SRC))
  check('随包 vendor 副本', /vendor/.test(SRC) && /7z\.exe/.test(SRC))
  check('注册表键', /SOFTWARE.*7-Zip/.test(SRC))
  check('PATH 兜底', /Get-Command/.test(SRC))
  check('常见安装目录（含 NanaZip）', /NanaZip/.test(SRC))
}

console.log('\n[3] 生成的 ps1 里路径没有被 JS 转义毁掉')
{
  const { text } = await generate()
  check('生成成功', typeof text === 'string' && text.length > 1000,
    text === null ? 'no ps1 produced' : `${text.length} bytes`)
  if (typeof text === 'string') {
    const bs = '\\'
    const want = [
      // The probe is assembled with Join-Path now, so the full path never
      // appears as one literal. Check the two pieces instead.
      ['runtime 根路径', 'resources' + bs + 'runtime'],
      ['SKILL.md 探针（相对 runtime）', 'office-skills' + bs + 'office' + bs + 'SKILL.md'],
      ['四个子树完整性检查', 'primary-runtime'],
      ['NSIS 内层包名', '$PLUGINSDIR' + bs + 'app-64.7z'],
      ['解包 filter', 'resources' + bs + 'runtime' + bs + '*'],
      ['注册表键', 'HKLM:' + bs + 'SOFTWARE' + bs + '7-Zip'],
      ['7-Zip 退出码检查', '$LASTEXITCODE'],
    ]
    for (const [label, needle] of want) {
      check(label, text.includes(needle), needle)
    }

    // 裸 CR 就是 `\r` 被吃掉的证据：它会把一行切成两行。
    const bareCr = (text.match(/\r(?!\n)/g) ?? []).length
    check('没有裸 CR（说明路径里的反斜杠都写成了 \\\\）', bareCr === 0, `count=${bareCr}`)

    // 被切断的那半截不该作为独立 token 出现在行首。
    const orphan = text.split(/\r?\n/).filter((line) => /^\s*untime\b/.test(line))
    check('没有残留的断行碎片', orphan.length === 0, orphan.slice(0, 2).join(' | '))
  }
}

console.log('\n[4] 自愈发生在启动之前')
{
  const { text } = await generate()
  if (typeof text === 'string') {
    const callAt = text.indexOf('if (-not (Test-Runtime))')
    // Anchor on the real spawn, not the trap's `Start-Process -FilePath $Exe`
    // fallback: the trap appears much earlier and would make this pass by luck.
    const startAt = text.indexOf('Start-Process @spArgs')
    check('存在调用点', callAt > 0)
    check('主启动点存在', startAt > 0)
    check('先检查再启动', callAt > 0 && startAt > 0 && callAt < startAt,
      `check=${callAt} start=${startAt}`)
    check('失败只告警不阻塞', /Repair-Runtime/.test(text) && /可能无法启动/.test(text))
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

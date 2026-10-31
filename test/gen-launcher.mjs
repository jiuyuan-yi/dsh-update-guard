/** Harness for generating the launcher with correct paths. */
import { ensureLauncher, launcherFiles } from '../lib/launcher.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultProfileDir } from '../lib/run.mjs'
import { findInstallRoot } from '../lib/installer.mjs'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))

// No machine-specific defaults: resolve from the environment, then from the
// install root. Anything a single developer's path would give away is gone.
const root = findInstallRoot()
const exeArg = process.argv[2] ?? (root === undefined ? undefined : join(root, 'DeepSeek Harness.exe'))
const profileArg = process.argv[3] ?? process.env.DSH_PROFILE_DIR ?? defaultProfileDir()

if (exeArg === undefined || !existsSync(exeArg)) {
  console.log('SKIP: 找不到 DSH 可执行文件（参数 1 指定，或设 DSH_DESKTOP_ROOT）')
  process.exit(0)
}

// Generation only. Repointing a desktop icon from a test harness is how a
// real desktop once ended up aimed at a temp directory.
const r = ensureLauncher({ exePath: exeArg, profileDir: profileArg, pkgDir: PKG, manageShortcut: false })
console.log(JSON.stringify(r, null, 2))
console.log('files:', launcherFiles(PKG).join(', '))

const ps1 = join(PKG, 'rescue', 'dsh-launch.ps1')
if (existsSync(ps1)) {
  const b = readFileSync(ps1)
  console.log('ps1 BOM:', b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF, ' size:', b.length)
  const text = b.toString('utf8')
  console.log('含 DSH 路径:', text.includes(exeArg))
  console.log('含 profile :', text.includes(profileArg))
}
const cmd = join(PKG, 'rescue', 'dsh-launch.cmd')
if (existsSync(cmd)) {
  const b = readFileSync(cmd)
  console.log('cmd BOM:', b[0] === 0xEF, ' size:', b.length)
}

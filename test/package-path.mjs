import { resolvePackageDir, resolvePackageFile } from '../lib/package-path.mjs'
import { join, resolve } from 'node:path'

let failures = 0
function check (label, condition, detail = '') {
  console.log(`${condition ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!condition) failures++
}

const profile = join('tmp', 'profile')
const root = join(profile, 'node_modules')
console.log('\n[1] package name resolution')
check('普通包', resolvePackageDir(profile, 'alpha') === resolve(root, 'alpha'))
check('scope 包', resolvePackageDir(profile, '@scope/plugin') === resolve(root, '@scope', 'plugin'))
check('拒绝路径穿越', resolvePackageDir(profile, '../../outside') === undefined)
check('拒绝多段路径', resolvePackageDir(profile, '@scope/plugin/extra') === undefined)
check('拒绝反斜杠', resolvePackageDir(profile, '..\\outside') === undefined)
check('拒绝非字符串', resolvePackageDir(profile, 42) === undefined)

console.log('\n[2] package-relative patch paths')
const plugin = join(root, 'alpha')
check('相对 patch 路径', resolvePackageFile(plugin, './cordis.patch.yml') === resolve(plugin, 'cordis.patch.yml'))
check('拒绝上级目录', resolvePackageFile(plugin, '../outside.yml') === undefined)
check('拒绝 Windows 盘符路径', resolvePackageFile(plugin, 'C:\\outside.yml') === undefined)
check('拒绝 UNC 路径', resolvePackageFile(plugin, '\\\\server\\share\\x') === undefined)
check('拒绝空路径', resolvePackageFile(plugin, '') === undefined)

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

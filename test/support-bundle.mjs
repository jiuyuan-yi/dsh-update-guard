/**
 * Support-bundle test.
 *
 * Two properties matter more than the layout:
 *   1. it must redact the account name and the install roots — a bundle that
 *      leaks `C:\Users\<real name>` is not a bundle anyone will paste,
 *   2. it must actually report plugin coupling, or it becomes a wall of "unknown".
 *
 * No DSH install is needed; the fixture is a synthetic profile with one plugin
 * whose source trips the source-patch class.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { buildSupportBundle, redact } from '../lib/support-bundle.mjs'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

console.log('\n[support-bundle] 脱敏与内容')

const work = mkdtempSync(join(tmpdir(), 'ug-support-'))
try {
  const profileDir = join(work, 'profile')
  const pkgDir = join(work, 'guard')
  const cacheRoot = join(pkgDir, '.cache')
  const pluginDir = join(profileDir, 'node_modules', 'local-plugin')

  mkdirSync(pluginDir, { recursive: true })
  mkdirSync(join(pkgDir, 'rescue'), { recursive: true })
  mkdirSync(cacheRoot, { recursive: true })

  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'desktop',
    dsh: { profile: { bundles: ['local-plugin'] } },
  }))
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'local-plugin', version: '1.2.3' }))
  writeFileSync(join(pluginDir, 'index.js'), [
    "writeFileSync('app.asar', 'x')",
    "copyFileSync('a', 'app.asar')",
    "const home = process.env.DSH_HOME",
  ].join('\n'))

  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-update-guard', version: '9.9.9' }))
  writeFileSync(join(pkgDir, 'rescue', 'runtime-baseline.json'), JSON.stringify({
    files: 6136,
    versionsHash: 'ABCDEF0123456789',
    manifestVersion: 1,
    manifest: [{ path: 'bin/node', size: 1, sha256: 'x' }],
    at: '2026-01-01T00:00:00.000Z',
  }))
  writeFileSync(join(cacheRoot, 'last-report.json'), JSON.stringify({
    stage: 'analysed',
    tier: 'declared+surface',
    version: '0.9.0',
    installedVersion: '0.8.0',
    checkedPlugins: 1,
    clientChecked: 1,
    hostChecked: 1,
    surfaceUnverifiedModules: ['@deepseek-ai/dsh-client-store'],
    findings: [{
      plugin: 'local-plugin',
      broken: [{ moduleName: '@deepseek-ai/dsh-client-ui-primitives', missing: ['Switch'], note: 'module-absent' }],
    }],
  }))

  // A log line carrying the real home directory: the bundle must not repeat it.
  const home = homedir()
  writeFileSync(join(pkgDir, 'rescue', 'launch.log'), [
    `2026-01-01 00:00:00  runtime 自愈失败：${home}\\AppData\\Local\\secret.txt`,
    '2026-01-01 00:00:01  启动成功',
  ].join('\r\n'))

  const { data, markdown } = buildSupportBundle({
    pkgDir,
    profileDir,
    cacheRoot,
    installRoot: join(work, 'dsh-install'),
    ghost: false,
  })

  check('guard 版本', data.guard === '9.9.9', String(data.guard))
  check('runtime 基线条目数', data.runtimeBaseline?.manifestEntries === 1, String(data.runtimeBaseline?.manifestEntries))
  check('上次报告被摘要', data.lastReport?.version === '0.9.0')
  check('未验证模块保留', data.lastReport?.surfaceUnverifiedModules?.includes('@deepseek-ai/dsh-client-store') === true)

  const row = data.plugins.find(p => p.name === 'local-plugin')
  check('插件进入列表', row !== undefined)
  check('source-patch 判为 high', row?.band === 'high', row ? row.reason : '')
  check('打包不含插件源码内容', !markdown.includes("copyFileSync('a', 'app.asar')"))

  check('markdown 有标题', markdown.includes('## dsh-update-guard support bundle'))
  check('markdown 列出插件', markdown.includes('local-plugin'))
  check('markdown 含基线信息', markdown.includes('6136'))
  check('markdown 含报告结论', markdown.includes('Switch'))

  // Redaction: none of these may survive into the pasted block.
  check('不含真实家目录', !markdown.includes(home), home)
  check('不含临时工作目录', !markdown.includes(work), work)
  check('家目录显示为占位符', markdown.includes('<HOME>'))
  check('用户名不出现', !new RegExp(escapeRe(home.split(/[\\/]/).filter(Boolean).pop())).test(markdown))

  const direct = redact(`x ${home}\\a y ${join(profileDir, 'z')} w ${join(pkgDir, 'q')}`, { pkgDir, profileDir })
  check('redact 直接调用', direct.includes('<HOME>') && direct.includes('<PROFILE>') && direct.includes('<GUARD>'), direct)
} finally {
  rmSync(work, { recursive: true, force: true })
}

function escapeRe (s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

/**
 * Panel data: cache behaviour is the whole point.
 *
 * The panel must open instantly, so the expensive scan is cached and only
 * rebuilt on a TTL or an explicit refresh. A wrong cache key or a broken
 * invalidation turns "instant" into "four seconds every time", which is exactly
 * the defect this tier would introduce if left untested.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { buildPanel, panelFor, readPanelCache } from '../lib/panel.mjs'

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

const work = mkdtempSync(join(tmpdir(), 'ug-panel-'))
try {
  const profileDir = join(work, 'profile')
  const cacheRoot = join(work, 'cache')
  const pluginDir = join(profileDir, 'node_modules', 'local-plugin')
  mkdirSync(pluginDir, { recursive: true })
  mkdirSync(cacheRoot, { recursive: true })

  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'desktop', dsh: { profile: { bundles: ['local-plugin'] } },
  }))
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'local-plugin', version: '2.3.4' }))
  writeFileSync(join(pluginDir, 'index.js'), [
    "writeFileSync('app.asar', 'x')",
    "copyFileSync('a', 'app.asar')",
    'const home = process.env.DSH_HOME',
    'const sub = spawnSync("node", ["-v"])',
  ].join('\n'))

  // A dependency that is NOT in bundles must stay out of the panel: node_modules
  // also holds plain libraries, and ranking those tells the user nothing.
  const depDir = join(profileDir, 'node_modules', 'some-library')
  mkdirSync(depDir, { recursive: true })
  writeFileSync(join(depDir, 'package.json'), JSON.stringify({ name: 'some-library', version: '1.0.0' }))
  writeFileSync(join(depDir, 'index.js'), "writeFileSync('app.asar', 'x')")

  console.log('\n[1] 首次构建')
  const first = buildPanel({ profileDir, cacheRoot, ghost: false })
  check('返回插件列表', Array.isArray(first.plugins) && first.plugins.length === 1, String(first.plugins.length))
  check('只含 bundles 内的插件', first.plugins[0]?.name === 'local-plugin', first.plugins[0]?.name)
  check('版本来自 package.json', first.plugins[0]?.version === '2.3.4', first.plugins[0]?.version)
  check('风险判为 high', first.plugins[0]?.band === 'high', first.plugins[0]?.band)
  check('命中类带文件名', Array.isArray(first.plugins[0]?.classes) && first.plugins[0].classes.some(c => c.files.length > 0))
  check('counts 汇总', first.counts.high === 1, JSON.stringify(first.counts))
  check('写入了缓存', existsSync(join(cacheRoot, 'panel.json')))

  console.log('\n[2] 命中缓存')
  const second = panelFor({ profileDir, cacheRoot, ghost: false })
  check('第二次读缓存', second.cached === true)
  check('缓存内容一致', second.payload.generatedAt === first.generatedAt, second.payload.generatedAt)
  check('age 非负', typeof second.ageMs === 'number' && second.ageMs >= 0)

  console.log('\n[3] 强制刷新')
  const forced = panelFor({ profileDir, cacheRoot, ghost: false, refresh: true })
  check('强制刷新不走缓存', forced.cached === false)
  check('重新生成了时间戳', forced.payload.generatedAt !== first.generatedAt, forced.payload.generatedAt)

  console.log('\n[4] 缓存损坏 -> 重建而不是崩')
  writeFileSync(join(cacheRoot, 'panel.json'), '{not json')
  check('坏缓存读成 undefined', readPanelCache(cacheRoot) === undefined)
  const rebuilt = panelFor({ profileDir, cacheRoot, ghost: false })
  check('重建成功', Array.isArray(rebuilt.payload.plugins) && rebuilt.payload.plugins.length === 1)
  const after = JSON.parse(readFileSync(join(cacheRoot, 'panel.json'), 'utf8'))
  check('缓存已修复', Array.isArray(after.plugins))

  console.log('\n[5] 缺 profile 不抛')
  let threw
  let empty
  try { empty = buildPanel({ cacheRoot: join(work, 'cache2'), ghost: false }) } catch (e) { threw = e }
  check('不抛错', threw === undefined, threw ? String(threw.message) : '')
  check('返回空列表', empty?.plugins?.length === 0)

  console.log('\n[6] ghost 关闭时不调用进程查询')
  check('ghost 状态为 not checked', first.ghost.status === 'unknown' && /not checked/.test(first.ghost.reason), JSON.stringify(first.ghost))
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

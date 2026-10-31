/** The cache must actually be reused: a miss re-extracts a 276 MB installer. */
import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadOrExtractSurface } from '../lib/installer.mjs'

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

const root = join(tmpdir(), `cache-${process.pid}`)
const cacheRoot = join(root, 'cache')
mkdirSync(cacheRoot, { recursive: true })
const installer = join(root, 'fake-installer.exe')
writeFileSync(installer, 'x'.repeat(1024))

let builds = 0
const buildSurface = () => { builds++; return { tracked: { m: ['a'] } } }

// 先手工写入一个「已生成」缓存，模拟第一次解包完成
const { cacheKeyOf } = await import('../lib/installer.mjs')
const key = cacheKeyOf(installer)
mkdirSync(cacheRoot, { recursive: true })
const record = {
  key,
  version: '1.0.0',
  installer,
  shellEntry: 'x',
  shellSha256: 'y',
  surface: { tracked: { m: ['a'] } },
  services: { declared: ['svc'], mentioned: [] },
}
writeFileSync(join(cacheRoot, `surface-v2-${key}.json`), JSON.stringify(record))

try {
  let r
  try {
    r = loadOrExtractSurface({ installer, version: '1.0.0' }, { cacheRoot }, buildSurface)
  } catch (e) {
    r = { error: String(e.message) }
  }
  check('命中缓存（没有重新解包）', r.cached === true, JSON.stringify(r).slice(0, 120))
  check('没有调用解包', builds === 0, 'builds=' + builds)
  check('带回了 services', Array.isArray(r.services?.declared), JSON.stringify(r.services))
  const files = readdirSync(cacheRoot).filter(f => f.startsWith('surface-v2-'))
  check('缓存文件只有一个', files.length === 1, files.join(','))
} finally { rmSync(root, { recursive: true, force: true }) }

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

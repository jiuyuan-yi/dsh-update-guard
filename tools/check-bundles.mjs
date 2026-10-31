/**
 * Report profile bundles that the loader will SKIP.
 *
 * `dsh-app-boot` wraps each bundle in try/catch and pushes failures into
 * `skippedBundles` — the app starts, the plugin silently never loads. A bundle
 * whose package.json lacks `dsh.bundle` (exactly the mistake this tool's own
 * author made) lands here with no visible symptom.
 *
 * Usage: node tools/check-bundles.mjs [--profile DIR] [--json]
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const pi = argv.indexOf('--profile')
const profileDir = pi === -1 ? join(homedir(), '.dsh', 'profiles', 'desktop') : argv[pi + 1]

const manifestPath = join(profileDir, 'package.json')
if (!existsSync(manifestPath)) {
  console.error(`[!] 找不到 ${manifestPath}`)
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const bundles = manifest.dsh?.profile?.bundles ?? []

/** Resolve a bundle name from the profile, then from the dsh installation. */
function resolveDir (name) {
  const candidates = [
    join(profileDir, 'node_modules', ...name.split('/')),
    // The installation anchor differs per machine; the profile's own
    // node_modules is where out-of-tree bundles actually live.
  ]
  for (const c of candidates) if (existsSync(join(c, 'package.json'))) return c
  return undefined
}

const rows = []
for (const name of bundles) {
  // Official bundles resolve from the dsh installation, which is packed inside
  // app.asar and not readable as a directory here. Treat them as out of scope
  // rather than reporting a false "not installed".
  if (name.startsWith('@deepseek-ai/')) {
    rows.push({ name, skip: false, official: true, reason: '官方包（安装目录内），此处不检查' })
    continue
  }
  const dir = resolveDir(name)
  if (dir === undefined) {
    rows.push({ name, skip: true, reason: '包未安装（profile/node_modules 下找不到）' })
    continue
  }
  let pkg
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch (e) {
    rows.push({ name, skip: true, reason: 'package.json 无法解析: ' + e.message })
    continue
  }
  const bundle = pkg.dsh?.bundle
  if (bundle === undefined) {
    rows.push({ name, skip: true, reason: '缺 dsh.bundle 声明 → 加载器抛错并静默跳过' })
    continue
  }
  const declared = bundle.patch
  const files = Array.isArray(declared) ? declared : [declared]
  if (!files.every(f => typeof f === 'string')) {
    rows.push({ name, skip: true, reason: 'dsh.bundle.patch 不是路径或路径数组' })
    continue
  }
  const missing = files.filter(f => !existsSync(join(dir, f)))
  if (missing.length > 0) {
    rows.push({ name, skip: true, reason: `patch 文件不存在: ${missing.join(', ')}` })
    continue
  }
  rows.push({ name, skip: false, reason: `ok (${files.join(', ')})` })
}

const skipped = rows.filter(r => r.skip)

if (asJson) {
  console.log(JSON.stringify({ profileDir, total: rows.length, skipped, all: rows }, null, 2))
} else {
  const official = rows.filter(r => r.official).length
  console.log(`\n=== bundle 加载检查 (${profileDir}) ===\n`)
  console.log(`共 ${rows.length} 个 bundle：官方 ${official} 个（不检查），第三方 ${rows.length - official} 个，其中 ${skipped.length} 个会被跳过\n`)
  for (const r of rows) {
    if (r.official) continue
    console.log(`  ${r.skip ? '✗ 跳过' : '✓ 加载'}  ${r.name}`)
    if (r.skip) console.log(`           ${r.reason}`)
  }
  console.log('')
}

process.exit(skipped.length > 0 ? 2 : 0)

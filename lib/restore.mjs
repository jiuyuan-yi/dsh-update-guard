/**
 * Surgical restore.
 *
 * Every reset path in this ecosystem loses the whole profile: the shipped
 * "disable third-party plugins" button rewrites the bundle list to the official
 * core and renames the user's patch to `cordis.patch.yml.bak-<ts>`; a launcher
 * that panics does the same. The fix is not to restore everything blindly —
 * that reinstates whatever broke — nor to keep everything off. It is to take the
 * newest backup, drop ONLY the bundles that fail validation, and write the rest
 * back.
 *
 * Nothing here executes plugin code; validation is structural (does the package
 * exist, does it declare dsh.bundle, does the patch file exist).
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolvePackageDir, resolvePackageFile } from './package-path.mjs'

const OFFICIAL = /^@deepseek-ai\//

/** Timestamped backups, newest first. */
export function backups (profileDir, prefix) {
  let names
  try { names = readdirSync(profileDir) } catch { return [] }
  return names
    .filter(n => n.startsWith(prefix))
    .map(n => {
      const p = join(profileDir, n)
      let mtime = 0
      try { mtime = statSync(p).mtimeMs } catch { /* ignore */ }
      return { name: n, path: p, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

function readJson (path) {
  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(raw)
}

/** Bundles listed in a profile manifest. */
function bundlesOf (manifest) {
  const list = manifest?.dsh?.profile?.bundles
  return Array.isArray(list) ? list : []
}

/**
 * Structural validation of one bundle, with a human-readable reason.
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function validateBundle (profileDir, name) {
  if (typeof name !== 'string' || name.length === 0) return { ok: false, reason: 'bundle 名称不是字符串' }
  if (OFFICIAL.test(name)) {
    return resolvePackageDir(profileDir, name) === undefined
      ? { ok: false, reason: '官方 bundle 名称不是有效的 npm 包路径' }
      : { ok: true }
  }
  const dir = resolvePackageDir(profileDir, name)
  if (dir === undefined) return { ok: false, reason: 'bundle 名称不是安全的 npm 包路径' }
  if (!existsSync(join(dir, 'package.json'))) return { ok: false, reason: '包未安装' }
  let manifest
  try { manifest = readJson(join(dir, 'package.json')) } catch { return { ok: false, reason: 'package.json 无法解析' } }
  const bundle = manifest?.dsh?.bundle
  if (bundle === undefined) return { ok: false, reason: '缺 dsh.bundle 声明（加载器会跳过）' }
  const declared = bundle.patch
  const files = Array.isArray(declared) ? declared : [declared]
  if (!files.every(f => typeof f === 'string')) return { ok: false, reason: 'dsh.bundle.patch 不是路径' }
  for (const f of files) {
    const patchPath = resolvePackageFile(dir, f)
    if (patchPath === undefined) return { ok: false, reason: `patch 路径越出插件目录或不是相对路径: ${String(f)}` }
    if (!existsSync(patchPath)) return { ok: false, reason: `patch 文件缺失: ${f}` }
  }
  return { ok: true }
}

/**
 * Work out what a restore would do, without touching anything.
 * @returns {object} plan; `actionable` is false when there is nothing to undo
 */
export function planRestore (profileDir) {
  const pkgPath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')

  let current = []
  let currentOk = false
  try {
    current = bundlesOf(readJson(pkgPath))
    currentOk = true
  } catch { /* unreadable: restore is exactly what is needed */ }

  // Prefer our own pre-change snapshots, then the loader's, then anything.
  const candidates = [
    ...backups(profileDir, 'package.json.bak-launcher-'),
    ...backups(profileDir, 'package.json.bak-rescue-'),
    ...backups(profileDir, 'package.json.bak-'),
  ]

  const chosen = []
  const seen = new Set()
  for (const c of candidates) {
    if (seen.has(c.name)) continue
    seen.add(c.name)
    chosen.push(c)
  }

  let source
  let target = []
  for (const c of chosen) {
    let list
    try { list = bundlesOf(readJson(c.path)) } catch { continue }
    if (list.length > current.length) { source = c; target = list; break }
  }
  // If nothing is bigger, fall back to the newest readable backup.
  if (source === undefined) {
    for (const c of chosen) {
      try {
        const list = bundlesOf(readJson(c.path))
        if (list.length > 0) { source = c; target = list; break }
      } catch { /* keep looking */ }
    }
  }

  const keep = []
  const dropped = []
  for (const name of target) {
    const v = validateBundle(profileDir, name)
    if (v.ok) keep.push(name)
    else dropped.push({ name, reason: v.reason })
  }

  // Patch layer: the shipped reset renames it aside, leaving a stub behind.
  let patchBackup
  let patchBytes = 0
  try { patchBytes = statSync(patchPath).size } catch { patchBytes = 0 }
  const patchCandidates = backups(profileDir, 'cordis.patch.yml.bak-')
  if (patchBytes < 200 && patchCandidates.length > 0) {
    const newest = patchCandidates[0]
    try {
      if (statSync(newest.path).size > patchBytes) patchBackup = newest
    } catch { /* ignore */ }
  }

  const needsBundles = currentOk ? keep.length > current.length : keep.length > 0
  return {
    profileDir,
    currentCount: current.length,
    source,
    wouldRestore: keep,
    dropped,
    patchBackup,
    actionable: needsBundles || patchBackup !== undefined,
  }
}

/**
 * Apply a plan. Both files are backed up first, so this stays reversible.
 * @returns {{applied: boolean, backupDir: string, bundles: number, dropped: object[]}}
 */
export function applyRestore (profileDir, plan = planRestore(profileDir)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const pkgPath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')

  if (!plan.actionable) {
    return { applied: false, backupDir: '', bundles: plan.currentCount, dropped: plan.dropped }
  }

  // Snapshot current state before writing.
  const keepDir = join(profileDir, '.restore-backups')
  try { statSync(keepDir) } catch {
    try { readdirSync(keepDir) } catch { /* fallthrough creates on write */ }
  }
  const backupNames = []
  if (existsSync(pkgPath)) {
    const p = `${pkgPath}.bak-restore-${stamp}`
    copyFileSync(pkgPath, p)
    backupNames.push(p)
  }
  if (existsSync(patchPath)) {
    const p = `${patchPath}.bak-restore-${stamp}`
    copyFileSync(patchPath, p)
    backupNames.push(p)
  }

  let manifest
  try { manifest = readJson(pkgPath) } catch { manifest = { name: 'profile', private: true, dsh: { profile: {} } } }
  if (manifest.dsh === undefined) manifest.dsh = {}
  if (manifest.dsh.profile === undefined) manifest.dsh.profile = {}
  manifest.dsh.profile.bundles = plan.wouldRestore
  writeFileSync(pkgPath, JSON.stringify(manifest, null, 2), 'utf8')

  if (plan.patchBackup !== undefined) {
    copyFileSync(plan.patchBackup.path, patchPath)
  }

  return {
    applied: true,
    backups: backupNames,
    bundles: plan.wouldRestore.length,
    dropped: plan.dropped,
    patchRestoredFrom: plan.patchBackup?.name,
  }
}

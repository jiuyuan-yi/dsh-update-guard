/**
 * Panel data: the one endpoint the settings UI reads.
 *
 * Two very different costs live here:
 *
 *   touchpoints  reads every installed plugin's source (seconds),
 *   ghost        asks Windows for host process start times (seconds),
 *
 * and neither may run on every panel open. So the result is cached on disk and
 * refreshed in the background at startup, which is the difference between "the
 * settings page opens instantly" and "the settings page freezes for four
 * seconds the first time you look at it".
 *
 * The cache is display data, not evidence: a stale entry is better than a slow
 * panel, and every payload carries `generatedAt` so the UI can say how old it is.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { listInstalled } from './plugins.mjs'
import { scanAll } from './touchpoints.mjs'
import { detectGhost } from './ghost.mjs'
import { findInstallRoot } from './installer.mjs'

const CACHE_FILE = 'panel.json'
const CACHE_TTL_MS = 5 * 60 * 1000
const DEFAULT_MAX_FILES = 1500

function cachePath (cacheRoot) {
  return join(cacheRoot, CACHE_FILE)
}

/** Newest cached panel, or undefined. Never throws. */
export function readPanelCache (cacheRoot) {
  try {
    const p = cachePath(cacheRoot)
    if (!existsSync(p)) return undefined
    const j = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
    if (j === null || typeof j !== 'object' || !Array.isArray(j.plugins)) return undefined
    return j
  } catch {
    return undefined
  }
}

function ageOf (cacheRoot) {
  try {
    return Date.now() - statSync(cachePath(cacheRoot)).mtimeMs
  } catch {
    return Infinity
  }
}

/** Mounted bundles only; node_modules also holds plain library dependencies. */
function mountedPlugins (profileDir) {
  const roots = [join(profileDir, 'node_modules'), join(profileDir, 'node_modules', '@deepseek-ai')]
  const installed = listInstalled(roots)
  let bundles
  try {
    bundles = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dsh?.profile?.bundles
  } catch {
    bundles = undefined
  }
  if (!Array.isArray(bundles) || bundles.length === 0) return { plugins: installed, scoped: false }
  const want = new Set(bundles)
  return { plugins: installed.filter(p => want.has(p.name)), scoped: true }
}

function versionOf (dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? '?'
  } catch {
    return '?'
  }
}

/**
 * Rebuild the panel payload. Always writes the cache, even on partial failure:
 * a payload with `ghost.status = 'unknown'` is still useful.
 *
 * @param {{profileDir?: string, cacheRoot: string, installRoot?: string, maxFiles?: number, ghost?: boolean}} opts
 */
export function buildPanel (opts) {
  const profileDir = opts.profileDir
  const cacheRoot = opts.cacheRoot
  const maxFiles = Number.isFinite(opts.maxFiles) ? opts.maxFiles : DEFAULT_MAX_FILES

  const { plugins: mounted, scoped } = profileDir === undefined
    ? { plugins: [], scoped: false }
    : mountedPlugins(profileDir)

  const withVersion = mounted.map(p => ({ ...p, version: versionOf(p.dir) }))

  let rows = []
  let scanError
  try {
    rows = scanAll(withVersion, { maxFiles })
  } catch (error) {
    scanError = error instanceof Error ? error.message : String(error)
  }

  const counts = { high: 0, medium: 0, low: 0, none: 0 }
  for (const r of rows) counts[r.risk.band] += 1

  let ghost = { status: 'unknown', reason: 'not checked' }
  if (opts.ghost !== false) {
    try {
      const root = opts.installRoot ?? findInstallRoot()
      if (root === undefined) {
        ghost = { status: 'unknown', reason: 'install root not found' }
      } else {
        const g = detectGhost(join(root, 'resources', 'app.asar'))
        ghost = { status: g.status, reason: g.reason, asarMtime: g.asarMtime }
      }
    } catch (error) {
      ghost = { status: 'unknown', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  const payload = {
    ok: true,
    generatedAt: new Date().toISOString(),
    scope: scoped ? 'bundles' : 'all-resolved',
    maxFiles,
    counts,
    plugins: rows.map(r => ({
      name: r.name,
      version: r.version,
      band: r.risk.band,
      score: r.risk.score,
      reason: r.risk.reason,
      classes: r.classes.map(c => ({
        slug: c.slug,
        hits: c.hits,
        weight: c.weight,
        files: c.files.slice(0, 3),
      })),
    })),
    ghost,
  }
  if (scanError !== undefined) payload.error = scanError

  try {
    mkdirSync(cacheRoot, { recursive: true })
    writeFileSync(cachePath(cacheRoot), JSON.stringify(payload), 'utf8')
  } catch { /* a panel that cannot cache still renders */ }

  return payload
}

/**
 * Cached when fresh, rebuilt when stale or `refresh` is set.
 * @returns {{payload: object, cached: boolean, ageMs: number}}
 */
export function panelFor (opts) {
  const cacheRoot = opts.cacheRoot
  if (opts.refresh !== true) {
    const age = ageOf(cacheRoot)
    const cached = readPanelCache(cacheRoot)
    if (cached !== undefined && age < CACHE_TTL_MS) {
      // A cache file with an mtime in the future is not impossible (clock
      // adjustments, restored backups). Report 0 rather than a negative age; the
      // freshness decision above still treats it as fresh, which is the safe
      // direction — never rescan in a loop because the clock moved.
      return { payload: cached, cached: true, ageMs: Math.max(0, age) }
    }
  }
  const payload = buildPanel(opts)
  return { payload, cached: false, ageMs: 0 }
}

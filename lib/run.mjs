/**
 * Shared analysis core. Used by both the CLI (`bin/guard.mjs`) and the host
 * plugin (`lib/index.js`), so the two can never disagree about what "safe to
 * update" means.
 *
 * Every entry point here is side-effect free except `lockFromAnalysis`, and
 * every failure is returned rather than thrown to the caller's plugin context.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { surfaceOf, TRACKED } from './surface.mjs'
import { detectExtractor, findInstallRoot, findPendingUpdate, loadOrExtractSurface } from './installer.mjs'
import { listInstalled, referencesOf } from './plugins.mjs'
import { entryIdsOf, lockIds, unlockAll, guardedIds } from './patch.mjs'
import { checkDeclaredRanges } from './compat.mjs'

export const CONFIG_NAME = '.dsh-update-guard.json'

/** Default profile directory, honouring the loader's own environment. */
export function defaultProfileDir () {
  const explicit = process.env.DSH_PROFILE_DIR
  if (explicit && existsSync(explicit)) return explicit
  const profile = process.env.DSH_PROFILE || 'desktop'
  return join(homedir(), '.dsh', 'profiles', profile)
}

const CONFIG_DEFAULTS = Object.freeze({
  version: 1,
  // Report only. Turning this on makes the guard edit the profile patch layer
  // without asking, which is a deliberate, reversible choice and must be opted into.
  autoLock: false,
  // Never auto-disable more than this many plugins at once: several at once
  // almost always means the surface parse drifted, not that they all broke.
  maxAutoLock: 3,
  // Run the check in the background when a downloaded update is waiting.
  preflightOnStartup: true,
  // Keep a launch wrapper + desktop shortcut current, so DSH can still be
  // started (and repaired) when a plugin breaks startup entirely.
  installLauncher: true,
  // If the profile was reset (the shipped button, or a panic repair), restore
  // the newest backup minus the bundles that fail structural validation.
  autoRestore: true,
})

export function readConfig (profileDir) {
  const p = join(profileDir, CONFIG_NAME)
  if (!existsSync(p)) return { ...CONFIG_DEFAULTS }
  try {
    return { ...CONFIG_DEFAULTS, ...JSON.parse(readFileSync(p, 'utf8')) }
  } catch {
    return { ...CONFIG_DEFAULTS }
  }
}

export function writeConfig (profileDir, config) {
  const p = join(profileDir, CONFIG_NAME)
  writeFileSync(p, JSON.stringify({ ...CONFIG_DEFAULTS, ...config }, null, 2), 'utf8')
  return p
}

function enabledBundles (profileDir) {
  const p = join(profileDir, 'package.json')
  if (!existsSync(p)) return undefined
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return new Set(j.dsh?.profile?.bundles ?? [])
  } catch { return undefined }
}

/**
 * Compare installed plugins against a runtime surface.
 * @param {{profileDir:string, installRoot?:string, cacheRoot:string, surface?:object, force?:boolean}} opts
 * @returns {object} report; `stage` is 'no-pending' | 'analysed'
 */
export function analyse (opts) {
  const profileDir = opts.profileDir

  // The install root is only needed to find a downloaded installer. When the
  // caller already supplies the surface (the running runtime), nothing about the
  // installation matters — requiring it there was a needless failure mode.
  let installRoot = opts.installRoot
  if (opts.surface === undefined) {
    installRoot = installRoot ?? findInstallRoot()
    if (installRoot === undefined) {
      return { stage: 'error', reason: 'install-root-not-found' }
    }
  }

  const bundles = enabledBundles(profileDir)
  const plugins = (() => {
    const roots = [join(profileDir, 'node_modules'), join(homedir(), '.dsh', 'plugins')]
    const all = listInstalled(roots)
    return bundles === undefined ? all : all.filter(p => bundles.has(p.name))
  })()

  // An explicit surface (e.g. the running runtime) short-circuits the update path.
  let surface = opts.surface
  let source = 'provided'
  let version
  let pending
  let tier1
  let extractor
  let surfaceError

  if (surface === undefined) {
    pending = findPendingUpdate(installRoot)
    if (pending === undefined) {
      return { stage: 'no-pending', profileDir, installRoot, checkedPlugins: plugins.length }
    }

    // Tier 1 needs nothing but the target version, which the installer file name
    // carries. It runs even when no archive tool exists, so the check degrades
    // to "declared ranges" instead of failing outright.
    version = pending.version
    try {
      tier1 = checkDeclaredRanges(profileDir, version)
    } catch (error) {
      tier1 = { checked: 0, findings: [], undeclared: [], error: String(error?.message ?? error) }
    }

    extractor = detectExtractor()
    if (extractor === undefined) {
      // No way to look inside the payload: report what tier 1 found and stop.
      return {
        stage: 'analysed',
        tier: 'declared-only',
        tier1,
        extractor: undefined,
        profileDir,
        installRoot,
        version,
        pending: { version, installer: pending.installer },
        source: 'none',
        trackedModules: TRACKED,
        surfaceSizes: {},
        checkedPlugins: plugins.length,
        findings: (tier1?.findings ?? []).map(f => ({
          plugin: f.plugin,
          ids: [],
          broken: [],
          declared: f,
        })),
        guarded: guardedIds(profileDir),
        note: 'no-extractor',
      }
    }

    try {
      const built = loadOrExtractSurface(
        pending,
        { cacheRoot: opts.cacheRoot, sevenZip: extractor.path, keepTemp: opts.keepTemp, force: opts.force },
        surfaceOf,
      )
      surface = built.surface.tracked ?? {}
      source = built.cached ? 'cache' : 'installer'
      version = built.version
      pending = { version: built.version, installer: pending.installer }
    } catch (error) {
      surfaceError = String(error?.message ?? error)
    }
  }

  // A failed extraction is not a failed check: tier 1 still answered something.
  if (surface === undefined) {
    return {
      stage: 'analysed',
      tier: 'declared-only',
      tier1,
      extractor: extractor?.path,
      surfaceError,
      profileDir,
      installRoot,
      version,
      pending: pending ? { version: pending.version, installer: pending.installer } : undefined,
      source: 'none',
      trackedModules: TRACKED,
      surfaceSizes: {},
      checkedPlugins: plugins.length,
      findings: (tier1?.findings ?? []).map(f => ({
        plugin: f.plugin,
        ids: [],
        broken: [],
        declared: f,
      })),
      guarded: guardedIds(profileDir),
      note: 'extract-failed',
    }
  }

  const findings = []
  // How many plugins actually had a client API to compare. Reporting only the
  // bundle count would claim more coverage than the check provides: a host-only
  // plugin has nothing on this surface to break.
  let clientChecked = 0
  let withDeclaredRange = 0
  for (const plugin of plugins) {
    // Never judge itself: this package's own tests mention member names as
    // fixtures, and a guard that disables itself protects nothing.
    if (plugin.name === 'dsh-update-guard') continue
    let refs
    try { refs = referencesOf(plugin.dir) } catch { continue }
    if (refs.size === 0) continue
    clientChecked++
    if (entryIdsOf(plugin.dir).length > 0) withDeclaredRange++
    const broken = []
    for (const [moduleName, members] of refs) {
      const available = surface[moduleName]
      if (available === undefined) {
        broken.push({ moduleName, missing: [...members], note: 'module-absent' })
        continue
      }
      const set = new Set(available)
      const missing = [...members].filter(m => !set.has(m))
      if (missing.length > 0) broken.push({ moduleName, missing })
    }
    if (broken.length === 0) continue
    findings.push({
      plugin: plugin.name,
      dir: plugin.dir,
      ids: entryIdsOf(plugin.dir),
      broken,
    })
  }

  return {
    stage: 'analysed',
    tier: 'declared+surface',
    tier1,
    extractor: extractor?.path,
    profileDir,
    installRoot,
    version,
    pending,
    source,
    trackedModules: TRACKED,
    surfaceSizes: Object.fromEntries(Object.entries(surface).map(([k, v]) => [k, v.length])),
    checkedPlugins: plugins.length,
    clientChecked,
    withDeclaredRange,
    findings,
    guarded: guardedIds(profileDir),
  }
}

/**
 * Lock every entry id of every finding, subject to a ceiling.
 * @returns {{locked: string[], skipped: string[], refused: {id: string, reason: string}[]}}
 */
export function lockFromAnalysis (analysis, limit = Infinity) {
  const targets = analysis.findings.slice(0, limit)
  const skipped = analysis.findings.slice(limit).map(f => f.plugin)
  const ids = targets.flatMap(f => f.ids)
  if (ids.length === 0) return { locked: [], skipped, refused: [] }
  const result = lockIds(analysis.profileDir, ids, { expectedVersion: analysis.version })
  return { locked: result.changed, skipped, refused: result.refused ?? [] }
}

export { unlockAll, guardedIds, entryIdsOf }

/** Persist the latest report next to the cache so a UI or the CLI can read it. */
export function saveReport (cacheRoot, analysis) {
  try {
    mkdirSync(cacheRoot, { recursive: true })
    const p = join(cacheRoot, 'last-report.json')
    writeFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...analysis }, null, 2), 'utf8')
    return p
  } catch { return undefined }
}

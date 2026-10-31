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
import { servicesFromDir, serviceUsageOf, readPluginText } from './services.mjs'

export const CONFIG_NAME = '.dsh-update-guard.json'

/** Default profile directory, honouring the loader's own environment. */
export function defaultProfileDir () {
  const explicit = process.env.DSH_PROFILE_DIR
  if (explicit && existsSync(explicit)) return explicit
  const profile = process.env.DSH_PROFILE || 'desktop'
  return join(homedir(), '.dsh', 'profiles', profile)
}

export const CONFIG_DEFAULTS = Object.freeze({
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
  //
  // Opt-in on purpose. This is the only setting that changes something the user
  // sees outside the app (the desktop shortcut), so a fresh install must not do
  // it silently. It is reachable from the settings panel and the CLI.
  installLauncher: false,
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
  let surfaceServices = opts.services
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
      surfaceServices = built.services ?? []
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
  let hostChecked = 0

  // Services provided by third-party plugins count as present: a plugin is
  // allowed to depend on a service another plugin supplies.
  const providedByPlugins = new Set()
  for (const plugin of plugins) {
    if (plugin.name === 'dsh-update-guard') continue
    try { for (const s of servicesFromDir(plugin.dir)) providedByPlugins.add(s) } catch { /* unreadable */ }
  }

  // Two levels of evidence:
  //   declared  — the runtime clearly constructs/provides this service
  //   mentioned — the name appears as a literal somewhere in the runtime
  // A name in `mentioned` but not `declared` is not reported: extraction can
  // miss a computed registration, and a false "this will break" costs more than
  // a quiet miss. Host findings are advisory and never lock on their own.
  const svc = surfaceServices
  const declaredServices = Array.isArray(svc) ? svc : (svc?.declared ?? [])
  const mentionedServices = Array.isArray(svc) ? [] : (svc?.mentioned ?? [])
  const knownServices = new Set([...declaredServices, ...mentionedServices, ...providedByPlugins])

  for (const plugin of plugins) {
    // Never judge itself: this package's own tests mention member names as
    // fixtures, and a guard that disables itself protects nothing.
    if (plugin.name === 'dsh-update-guard') continue
    let refs = new Map()
    try { refs = referencesOf(plugin.dir) } catch { /* unreadable */ }
    const usage = (() => {
      try { return serviceUsageOf(readPluginText(plugin.dir)) } catch { return { hard: [], soft: [] } }
    })()
    if (refs.size === 0 && usage.hard.length === 0 && usage.soft.length === 0) continue

    const broken = []
    if (refs.size > 0) clientChecked++
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

    // Host services: a service a required plugin injects but the new version no
    // longer provides aborts boot, which is the failure the client check cannot
    // see. Soft probes are reported separately — they usually have guards.
    const hardMissing = usage.hard.filter(s => !knownServices.has(s))
    const softUnknown = usage.soft.filter(s => !knownServices.has(s))
    if (usage.hard.length > 0 || usage.soft.length > 0) hostChecked++
    if (hardMissing.length > 0) {
      broken.push({ moduleName: 'host services', missing: hardMissing, note: 'service-absent' })
    }

    if (broken.length === 0) {
      if (softUnknown.length > 0) {
        findings.push({
          plugin: plugin.name,
          dir: plugin.dir,
          ids: entryIdsOf(plugin.dir),
          broken: [],
          softUnknown,
        })
      }
      continue
    }
    findings.push({
      plugin: plugin.name,
      dir: plugin.dir,
      ids: entryIdsOf(plugin.dir),
      broken,
      softUnknown,
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
    hostChecked,
    withDeclaredRange,
    findings,
    guarded: guardedIds(profileDir),
  }
}

/**
 * Lock the findings that are safe to act on automatically.
 *
 * Client-module evidence is hard: a member the new build does not export throws
 * at render time. Host-service evidence is softer — a service can be provided
 * dynamically (not via `super(ctx, ...)`), so a missing name may be a false
 * positive; locking on it would disable a plugin that works. Those findings are
 * reported and left for a human to confirm.
 * @returns {{locked: string[], skipped: string[], refused: object[], advisory: string[]}}
 */
export function lockFromAnalysis (analysis, limit = Infinity) {
  const actionable = analysis.findings.filter(f =>
    Array.isArray(f.broken) && f.broken.some(b => b.note !== 'service-absent'))
  const advisory = analysis.findings.filter(f => !actionable.includes(f))

  const targets = actionable.slice(0, limit)
  const skipped = [
    ...actionable.slice(limit).map(f => f.plugin),
    ...advisory.map(f => f.plugin),
  ]
  const ids = targets.flatMap(f => f.ids)
  if (ids.length === 0) return { locked: [], skipped, refused: [], advisory: advisory.map(f => f.plugin) }
  const result = lockIds(analysis.profileDir, ids, { expectedVersion: analysis.version })
  return {
    locked: result.changed,
    skipped,
    refused: result.refused ?? [],
    advisory: advisory.map(f => f.plugin),
  }
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

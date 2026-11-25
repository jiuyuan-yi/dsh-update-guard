/**
 * Pre-upgrade state snapshots.
 *
 * The launcher already keeps per-write backups (`package.json.bak-*`, the undo
 * journal, `runtime-baseline.json`). What it does not keep is one readable record
 * of "what this machine looked like right before the update" — the thing you
 * want when an upgrade goes wrong and you are reconstructing from memory.
 *
 * A snapshot is a flat JSON file under `.cache/snapshots/`. It is a description,
 * not a restore source: nothing here repairs the profile, and deliberately so.
 * Restoring from a snapshot would be a second destructive path next to the
 * existing surgical restore, and two ways to rewrite `bundles` is how a working
 * profile gets broken.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { listInstalled } from './plugins.mjs'
import { installedVersion } from './installer.mjs'

export const STATE_SCHEMA = 1

/** The version on disk, which is the only one a snapshot can claim. */
function versionOf (installRoot) {
  if (!installRoot) return undefined
  try { return installedVersion(installRoot) } catch { return undefined }
}

function readJson (path) {
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) } catch { return undefined }
}

function guardConfig (profileDir) {
  const j = readJson(join(profileDir, '.dsh-update-guard.json'))
  return j ?? {}
}

function bundlesOf (profileDir) {
  const pkg = readJson(join(profileDir, 'package.json'))
  const list = pkg?.dsh?.profile?.bundles
  return Array.isArray(list) ? list.filter(x => typeof x === 'string') : []
}

function installedVersions (profileDir, bundles) {
  const roots = [join(profileDir, 'node_modules'), join(profileDir, 'node_modules', '@deepseek-ai')]
  const installed = listInstalled(roots)
  const want = new Set(bundles)
  return installed
    .filter(p => want.size === 0 || want.has(p.name))
    .map(p => ({
      name: p.name,
      version: readJson(join(p.dir, 'package.json'))?.version ?? '?',
      mounted: want.has(p.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * @param {{profileDir: string, installRoot?: string, pkgDir?: string, version?: string, note?: string}} opts
 */
export function captureState (opts) {
  const profileDir = opts.profileDir
  const bundles = bundlesOf(profileDir)
  const baseline = readJson(join(opts.pkgDir ?? '', 'rescue', 'runtime-baseline.json'))
  const report = readJson(join(opts.pkgDir ?? '', '.cache', 'last-report.json'))

  return {
    schemaVersion: STATE_SCHEMA,
    createdAt: new Date().toISOString(),
    note: typeof opts.note === 'string' ? opts.note : '',
    dsh: {
      version: opts.version ?? versionOf(opts.installRoot) ?? report?.installedVersion ?? 'unknown',
      installRoot: opts.installRoot ?? null,
    },
    profile: { dir: profileDir, bundles },
    guard: {
      version: opts.guardVersion ?? null,
      config: guardConfig(profileDir),
    },
    runtime: baseline === undefined
      ? null
      : {
          files: baseline.files ?? null,
          versionsHash: typeof baseline.versionsHash === 'string' ? baseline.versionsHash : null,
          manifestEntries: Array.isArray(baseline.manifest) ? baseline.manifest.length : 0,
          at: baseline.at ?? null,
        },
    pending: report === undefined || report.stage !== 'analysed'
      ? null
      : {
          stage: report.stage,
          version: report.version ?? null,
          tier: report.tier ?? null,
          findings: Array.isArray(report.findings) ? report.findings.length : 0,
        },
    plugins: installedVersions(profileDir, bundles),
  }
}

/** What the user would notice as different between two snapshots. */
export function diffStates (before, after) {
  const beforeBundles = new Set(before?.profile?.bundles ?? [])
  const afterBundles = new Set(after?.profile?.bundles ?? [])
  const beforePlugins = new Map((before?.plugins ?? []).map(p => [p.name, p.version]))
  const afterPlugins = new Map((after?.plugins ?? []).map(p => [p.name, p.version]))

  const plugins = []
  for (const name of [...new Set([...beforePlugins.keys(), ...afterPlugins.keys()])].sort()) {
    const b = beforePlugins.get(name)
    const a = afterPlugins.get(name)
    if (b === a) continue
    plugins.push({
      name,
      before: b ?? null,
      after: a ?? null,
      change: b === undefined ? 'added' : a === undefined ? 'removed' : 'version',
    })
  }

  const configBefore = before?.guard?.config ?? {}
  const configAfter = after?.guard?.config ?? {}
  const config = []
  for (const key of [...new Set([...Object.keys(configBefore), ...Object.keys(configAfter)])].sort()) {
    const b = configBefore[key]
    const a = configAfter[key]
    if (JSON.stringify(b) === JSON.stringify(a)) continue
    config.push({ key, before: b ?? null, after: a ?? null })
  }

  return {
    dsh: { before: before?.dsh?.version ?? null, after: after?.dsh?.version ?? null },
    bundles: {
      removed: [...beforeBundles].filter(x => !afterBundles.has(x)),
      added: [...afterBundles].filter(x => !beforeBundles.has(x)),
    },
    plugins,
    config,
    runtime: {
      before: before?.runtime?.files ?? null,
      after: after?.runtime?.files ?? null,
      changed: JSON.stringify(before?.runtime ?? null) !== JSON.stringify(after?.runtime ?? null),
    },
    pending: {
      before: before?.pending?.version ?? null,
      after: after?.pending?.version ?? null,
    },
  }
}

export function snapshotDir (pkgDir) {
  return join(pkgDir, '.cache', 'snapshots')
}

/** Write one snapshot; returns its path. Throws only on an unwritable cache. */
export function writeState (pkgDir, state) {
  const dir = snapshotDir(pkgDir)
  mkdirSync(dir, { recursive: true })
  const stamp = state.createdAt.replace(/[:.]/g, '-')
  const path = join(dir, `state-${stamp}.json`)
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf8')
  return path
}

/** Newest first. Unreadable entries are reported, not skipped silently. */
export function listStates (pkgDir) {
  const dir = snapshotDir(pkgDir)
  let files
  try { files = readdirSync(dir).filter(f => /^state-.*\.json$/.test(f)) } catch { return [] }
  const rows = []
  for (const f of files) {
    const full = join(dir, f)
    try {
      const s = JSON.parse(readFileSync(full, 'utf8'))
      rows.push({
        file: full,
        at: s.createdAt ?? null,
        note: s.note ?? '',
        dsh: s.dsh?.version ?? '?',
        plugins: Array.isArray(s.plugins) ? s.plugins.length : 0,
        bytes: statSync(full).size,
      })
    } catch (error) {
      rows.push({ file: full, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return rows.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
}

export function readState (path) {
  if (!existsSync(path)) throw new Error('snapshot not found: ' + path)
  const s = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  if (s?.schemaVersion !== STATE_SCHEMA) {
    throw new Error(`unsupported snapshot schema: ${s?.schemaVersion ?? 'none'}`)
  }
  return s
}

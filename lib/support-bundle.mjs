/**
 * Support bundle: one paste-ready diagnosis block for an issue report.
 *
 * The bottleneck for this project is not code, it is *version pairs*. Almost
 * every real bug here is "DSH A + guard B + plugin C", and a report that says
 * "it crashed" cannot be reproduced. This module turns the state a maintainer
 * would otherwise have to ask for into a single block a user can paste:
 *
 *   - DSH version and install layout (redacted),
 *   - the runtime baseline the launcher actually wrote,
 *   - what the last pre-update check saw,
 *   - per-plugin touchpoint bands (risk ranking, not a verdict),
 *   - every module the surface scan could not verify.
 *
 * Two rules it must never break:
 *
 *   1. **No absolute paths, no user name.** Everything is passed through
 *      `redact()` before it reaches the output. A support bundle that leaks
 *      `C:\Users\<real name>` will not get pasted twice.
 *   2. **No plugin source.** File *names* and counts only. This is a report, not
 *      a copy of the user's machine.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { installedVersion, findInstallRoot } from './installer.mjs'
import { detectGhost } from './ghost.mjs'
import { listInstalled } from './plugins.mjs'
import { scanAll } from './touchpoints.mjs'

const VERSION_CACHE = 'last-report.json'
const BASELINE = 'runtime-baseline.json'

function readJson (path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
}

function err (e) {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Replace machine-specific text with stable placeholders.
 *
 * Order matters: the longest/most specific roots are replaced first, otherwise
 * `C:\Users\me\.dsh` is eaten by the `C:\Users\me` rule and the profile marker
 * is lost. The user-name sweep comes last, so a path that only exists in a log
 * line still loses the account name.
 */
export function redact (text, roots = {}) {
  let out = String(text)
  const map = [
    [roots.pkgDir, '<GUARD>'],
    [roots.profileDir, '<PROFILE>'],
    [roots.installRoot, '<DSH_ROOT>'],
    [roots.cacheRoot, '<CACHE>'],
  ]
  for (const [from, to] of map) {
    if (!from) continue
    out = out.split(from).join(to)
    out = out.split(from.replace(/\\/g, '/')).join(to)
  }

  const home = homedir()
  if (home) {
    out = out.split(home).join('<HOME>')
    out = out.split(home.replace(/\\/g, '/')).join('<HOME>')
    const account = home.split(/[\\/]/).filter(Boolean).pop()
    if (account && account.length > 1) {
      out = out.split(new RegExp(`\\\\Users\\\\${escapeRe(account)}`, 'gi')).join('\\Users\\<USER>')
      out = out.split(new RegExp(`/Users/${escapeRe(account)}`, 'gi')).join('/Users/<USER>')
      out = out.split(new RegExp(`/home/${escapeRe(account)}`, 'gi')).join('/home/<USER>')
    }
  }
  return out
}

function escapeRe (s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Bounded, redacted excerpt of the launcher log: the last N lines only. */
export function logTail (logPath, lines = 40, roots = {}) {
  try {
    if (!existsSync(logPath)) return []
    const text = readFileSync(logPath, 'utf8')
    const all = text.split(/\r?\n/).filter(Boolean)
    return all.slice(-lines).map(line => redact(line, roots))
  } catch {
    return []
  }
}

/** Collect everything the report needs. Never throws. */
export function collect (opts = {}) {
  const profileDir = opts.profileDir
  const pkgDir = opts.pkgDir
  const cacheRoot = opts.cacheRoot ?? (pkgDir ? join(pkgDir, '.cache') : undefined)
  const installRoot = opts.installRoot ?? safeFindInstallRoot()
  const roots = { pkgDir, profileDir, installRoot, cacheRoot }

  const data = {
    generatedAt: new Date().toISOString(),
    guard: guardVersion(pkgDir),
    platform: {
      os: process.platform,
      arch: process.arch,
      node: process.versions.node,
    },
    dsh: {
      installRoot: installRoot ? '<DSH_ROOT>' : null,
      installedVersion: safe(() => installedVersion(installRoot)) ?? null,
      ghost: null,
    },
    runtimeBaseline: null,
    lastReport: null,
    plugins: [],
    logTail: logTail(join(pkgDir ?? '', 'rescue', 'launch.log'), 40, roots),
  }

  if (opts.ghost === true && installRoot) {
    try {
      const g = detectGhost(join(installRoot, 'resources', 'app.asar'))
      data.dsh.ghost = { status: g.status, reason: redact(g.reason ?? '', roots) }
    } catch (e) {
      data.dsh.ghost = { status: 'unknown', reason: redact(err(e), roots) }
    }
  }

  const baselinePath = join(pkgDir ?? '', 'rescue', BASELINE)
  const baseline = readJson(baselinePath)
  if (baseline) {
    data.runtimeBaseline = {
      files: baseline.files ?? null,
      versionsHash: typeof baseline.versionsHash === 'string' ? baseline.versionsHash.slice(0, 16) : null,
      manifestEntries: Array.isArray(baseline.manifest) ? baseline.manifest.length : 0,
      manifestVersion: baseline.manifestVersion ?? null,
      at: baseline.at ?? null,
    }
  }

  const report = readJson(join(cacheRoot ?? '', VERSION_CACHE))
  if (report) data.lastReport = summarizeReport(report, roots)

  data.plugins = safe(() => pluginRows(profileDir, roots)) ?? []

  return data
}

function safe (fn) {
  try { return fn() } catch { return undefined }
}

function safeFindInstallRoot () {
  try { return findInstallRoot() } catch { return undefined }
}

function guardVersion (pkgDir) {
  if (!pkgDir) return null
  return readJson(join(pkgDir, 'package.json'))?.version ?? null
}

/** Only the parts of a report that answer "what did it see", never the paths. */
function summarizeReport (report, roots) {
  const findings = Array.isArray(report.findings) ? report.findings : []
  return {
    stage: report.stage ?? null,
    tier: report.tier ?? null,
    version: report.version ?? null,
    installedVersion: report.installedVersion ?? null,
    checkedPlugins: report.checkedPlugins ?? null,
    clientChecked: report.clientChecked ?? null,
    hostChecked: report.hostChecked ?? null,
    serviceMethodsChecked: report.serviceMethodsChecked ?? null,
    surfaceUnverifiedModules: Array.isArray(report.surfaceUnverifiedModules)
      ? report.surfaceUnverifiedModules.map(m => redact(m, roots)).slice(0, 40)
      : [],
    findings: findings.slice(0, 40).map(f => ({
      plugin: f.plugin,
      broken: Array.isArray(f.broken)
        ? f.broken.map(b => ({
          module: b.moduleName,
          missing: Array.isArray(b.missing) ? b.missing.slice(0, 20) : [],
          note: b.note ?? null,
        }))
        : [],
      serviceMethods: Array.isArray(f.methodUnknown)
        ? f.methodUnknown.slice(0, 20).map(u => `${u.service}.${u.method}`)
        : [],
      declared: f.declared?.kind ?? null,
    })),
  }
}

/** Mounted bundles with their risk band. File names only, capped. */
function pluginRows (profileDir, roots) {
  if (!profileDir || !existsSync(profileDir)) return []
  const rootsToScan = [join(profileDir, 'node_modules'), join(profileDir, 'node_modules', '@deepseek-ai')]
  const installed = listInstalled(rootsToScan)

  let mounted = installed
  const pkg = readJson(join(profileDir, 'package.json'))
  const bundles = pkg?.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.length > 0) {
    const want = new Set(bundles)
    mounted = installed.filter(p => want.has(p.name))
  }

  const withVersion = mounted.map(p => ({
    ...p,
    version: readJson(join(p.dir, 'package.json'))?.version ?? '?',
  }))
  const rows = scanAll(withVersion, { maxFiles: 4000 })
  return rows.map(r => ({
    name: r.name,
    version: r.version,
    band: r.risk.band,
    score: r.risk.score,
    reason: r.risk.reason,
    classes: r.classes.map(c => ({
      slug: c.slug,
      hits: c.hits,
      files: c.files.slice(0, 3).map(f => redact(f, roots)),
    })),
  }))
}

const BAND_LABEL = { high: 'HIGH', medium: 'MED', low: 'low', none: '-' }

/** Render the collected data as one markdown block. */
export function toMarkdown (data) {
  const lines = []
  const push = (s = '') => lines.push(s)

  push('## dsh-update-guard support bundle')
  push()
  push(`- guard: \`${data.guard ?? '?'}\``)
  push(`- generated: ${data.generatedAt}`)
  push(`- platform: ${data.platform.os} ${data.platform.arch}, node ${data.platform.node}`)
  push()

  push('### DSH')
  push()
  push(`- installed version: \`${data.dsh.installedVersion ?? 'unknown'}\``)
  push(`- install root: ${data.dsh.installRoot ?? 'not found'}`)
  if (data.dsh.ghost) {
    push(`- ghost host: **${data.dsh.ghost.status}** — ${data.dsh.ghost.reason}`)
  } else {
    push('- ghost host: not checked')
  }
  push()

  push('### Runtime integrity baseline')
  push()
  if (data.runtimeBaseline) {
    const b = data.runtimeBaseline
    push(`- files: ${b.files ?? '?'}`)
    push(`- versions.json: \`${b.versionsHash ?? '?'}\``)
    push(`- key-file manifest: ${b.manifestEntries} entries (v${b.manifestVersion ?? '?'})`)
    push(`- written at: ${b.at ?? '?'}`)
  } else {
    push('- no baseline on disk (launcher never completed a clean start)')
  }
  push()

  push('### Last pre-update check')
  push()
  if (data.lastReport) {
    const r = data.lastReport
    push(`- stage: ${r.stage ?? '?'} / tier: ${r.tier ?? '?'}`)
    push(`- target version: \`${r.version ?? '?'}\` (installed \`${r.installedVersion ?? '?'}\`)`)
    push(`- plugins checked: ${r.checkedPlugins ?? '?'} (client ${r.clientChecked ?? '?'}, host ${r.hostChecked ?? '?'}, service methods ${r.serviceMethodsChecked ?? '?'})`)
    if (r.surfaceUnverifiedModules.length > 0) {
      push(`- unverified modules: ${r.surfaceUnverifiedModules.map(m => '`' + m + '`').join(', ')}`)
    }
    if (r.findings.length > 0) {
      push('- findings:')
      for (const f of r.findings) {
        const why = f.broken.length > 0
          ? f.broken.map(b => `${b.module}${b.note ? ' (' + b.note + ')' : ''}: ${b.missing.join(', ')}`).join('; ')
          : (f.declared ?? 'advisory')
        push(`  - \`${f.plugin}\` — ${why}`)
        if (Array.isArray(f.serviceMethods) && f.serviceMethods.length > 0) {
          push(`    - service methods not found in the target: ${f.serviceMethods.map(m => '`' + m + '`').join(', ')}`)
        }
      }
    } else {
      push('- findings: none')
    }
  } else {
    push('- no cached report (nothing was pending, or the check has not run)')
  }
  push()

  push('### Plugin touchpoints (risk ranking, not a verdict)')
  push()
  if (data.plugins.length === 0) {
    push('- no mounted third-party plugins resolved')
  } else {
    push('| plugin | version | band | classes |')
    push('| --- | --- | --- | --- |')
    for (const p of data.plugins) {
      const cls = p.classes.length === 0
        ? '-'
        : p.classes.map(c => `${c.slug}×${c.hits}${c.files.length ? ' (' + c.files.join(', ') + ')' : ''}`).join('<br>')
      push(`| \`${p.name}\` | ${p.version} | **${BAND_LABEL[p.band] ?? p.band}** | ${cls} |`)
    }
  }
  push()

  if (data.logTail.length > 0) {
    push('### Launcher log (last 40 lines, redacted)')
    push()
    push('```')
    for (const line of data.logTail) push(line)
    push('```')
    push()
  }

  push('---')
  push('Heuristic output. Zero hits means "no pattern matched", not "safe to upgrade".')
  return lines.join('\n')
}

/** Build both representations. */
export function buildSupportBundle (opts = {}) {
  const data = collect(opts)
  return { data, markdown: toMarkdown(data) }
}

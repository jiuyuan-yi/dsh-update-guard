/**
 * Ghost host: is the running process still executing an older build than the
 * one on disk?
 *
 * An in-place upgrade replaces `app.asar` while the desktop host keeps running
 * from what it already loaded. Afterwards the version on disk, the directory
 * listing, and any `package.json` all report the NEW version, while the process
 * that would actually mount a plugin is still the OLD code. Any compatibility
 * conclusion drawn in that window is attributed to the wrong side of the upgrade
 * — usually inverted.
 *
 * The signal is timestamps, not versions: if the archive was written after the
 * host process started, whatever that process loaded predates the archive.
 *
 * Windows only, because it needs the process start time. Everywhere else this
 * reports `unknown` rather than guessing — a wrong "no ghost" is worse than an
 * honest "cannot tell", since it is the case where a stale reading gets trusted.
 */
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'

const HOST_NAMES = ['DeepSeek Harness', 'DeepSeek Harness Desktop', 'dsh-desktop-host']

/** Read start times for any running host processes. Returns [] when unavailable. */
function hostProcesses () {
  if (process.platform !== 'win32') return []
  const script = `
    $names = @(${HOST_NAMES.map(n => `'${n}'`).join(',')})
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $names -contains $_.ProcessName } |
      Select-Object Id, ProcessName, @{n='Start';e={$_.StartTime.ToUniversalTime().ToString('o')}} |
      ConvertTo-Json -Compress
  `
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true
    }).trim()
    if (!out) return []
    const parsed = JSON.parse(out)
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    // PowerShell key casing is not stable across -Command forms; normalise once
    // here so callers never index into `Id` vs `id`.
    return rows.map(r => ({
      id: r.Id ?? r.id ?? null,
      name: r.ProcessName ?? r.name ?? null,
      start: r.Start ?? r.start ?? null
    }))
  } catch {
    return []
  }
}

/**
 * @param {string} asarPath path to the installed app.asar
 * @returns {{
 *   status: 'ghost'|'clean'|'unknown',
 *   asarMtime: string|null,
 *   processes: {id: number, name: string, start: string}[],
 *   reason: string
 * }}
 */
export function detectGhost (asarPath) {
  let asarMtime
  try {
    asarMtime = statSync(asarPath).mtime
  } catch (error) {
    return { status: 'unknown', asarMtime: null, processes: [], reason: `cannot stat ${asarPath}: ${error?.message ?? error}` }
  }

  const procs = hostProcesses()
  if (procs.length === 0) {
    return {
      status: 'unknown',
      asarMtime: asarMtime.toISOString(),
      processes: [],
      reason: 'no running host process found (closed, or not visible to this account)'
    }
  }

  const stale = []
  for (const p of procs) {
    if (!p.start) continue
    const started = new Date(p.start)
    if (Number.isNaN(started.getTime())) continue
    if (started < asarMtime) stale.push(p)
  }

  if (stale.length === 0) {
    return {
      status: 'clean',
      asarMtime: asarMtime.toISOString(),
      processes: procs,
      reason: 'every running host started after the archive was written'
    }
  }

  return {
    status: 'ghost',
    asarMtime: asarMtime.toISOString(),
    processes: procs,
    reason: `${stale.length} host process(es) started before the archive was written; they are still running the previous build`
  }
}

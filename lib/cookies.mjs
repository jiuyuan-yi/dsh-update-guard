/**
 * Cookie-jar maintenance for the desktop host.
 *
 * Why this exists: the desktop app binds a fresh random loopback port on every
 * launch, and `dsh-client-connection` names the auth cookie after `host:port`
 * (`COOKIE_PREFIX + base64url(sha256(authority))`). RFC 6265 keys cookies by
 * (domain, path, name), so each port adds a cookie that no other launch ever
 * evicts. Around 70 of them the request header crosses Node's 16 KB
 * `maxHeaderSize` and every request dies during header parsing with
 * "Web authentication failed" — before the app's own 401 path can run.
 *
 * The upstream fix (make the name port-independent) needs a host change. While
 * the host ships as a packed `app.asar` that means repacking a ~209 MB archive,
 * which is a bigger risk than the problem. Pruning instead keeps the jar
 * bounded: one leftover plus the current session's cookie, never growing.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Electron userData for the desktop build; the cookie jar lives under Network/. */
export function cookieDbPath () {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return join(appData, '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')
}

function helperPath (pkgDir) {
  return join(pkgDir, 'lib', 'prune-cookies.py')
}

function findPython () {
  for (const candidate of ['python', 'python3', 'py']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 5000 })
      return candidate
    } catch { /* try next */ }
  }
  return undefined
}

/**
 * Run the helper against the jar.
 * Returns { available, python, db, output, lines } — never throws.
 */
export function runCookieHelper (pkgDir, { list = false } = {}) {
  const db = cookieDbPath()
  const base = { available: false, python: undefined, db, output: '', lines: [] }

  if (!existsSync(db)) return { ...base, reason: 'no-db' }

  const python = findPython()
  if (python === undefined) return { ...base, reason: 'no-python' }

  const helper = helperPath(pkgDir)
  if (!existsSync(helper)) return { ...base, reason: 'no-helper', python }

  const args = [helper, db]
  if (list) args.push('--list')

  try {
    const output = execFileSync(python, args, { encoding: 'utf8', timeout: 30000 })
    return {
      available: true,
      python,
      db,
      output: output.trim(),
      lines: output.trim().split(/\r?\n/).filter(Boolean),
    }
  } catch (error) {
    return { ...base, python, reason: 'run-failed', message: String(error?.message ?? error) }
  }
}

/** Parse `LIST total=N` + `  name | host` lines. */
export function parseList (result) {
  if (!result.available) return { ok: false, reason: result.reason, names: [] }
  const total = /LIST total=(\d+)/.exec(result.output)
  if (total === null) {
    // The helper reports PRUNE error=... when the jar is locked by a running app.
    return { ok: false, reason: 'locked-or-empty', names: [] }
  }
  const names = result.lines
    .filter(line => line.startsWith('  ') && line.includes('|'))
    .map(line => line.trim().split('|')[0].trim())
  return { ok: true, total: Number(total[1]), names }
}

/** Parse `PRUNE kept=N removed=M`. */
export function parsePrune (result) {
  if (!result.available) return { ok: false, reason: result.reason }
  const m = /PRUNE kept=(\d+) removed=(\d+)/.exec(result.output)
  if (m === null) return { ok: false, reason: 'locked-or-empty', raw: result.output }
  return { ok: true, kept: Number(m[1]), removed: Number(m[2]) }
}

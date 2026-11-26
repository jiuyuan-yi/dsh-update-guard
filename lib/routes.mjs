/**
 * HTTP surface for the settings panel.
 *
 * The panel is a browser plugin, so it cannot touch the profile directly. It
 * talks to these three routes, which are the only places the guard's config is
 * read or written at runtime.
 *
 * Handlers are plain `(req, res)` functions and are exported separately from
 * registration so they can be tested without a web server.
 */
import { readConfig, writeConfig, lockFromAnalysis } from './run.mjs'
import { join } from 'node:path'

export const ROUTE_PREFIX = '/dsh-update-guard'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

/** Switches the panel may change. Anything else is rejected. */
const WRITEABLE = new Set(['autoLock', 'autoRestore', 'preflightOnStartup', 'maxAutoLock', 'installLauncher'])

function send (res, status, payload) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(payload))
}

function readBody (req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Only this machine may change state.
 *
 * A page on the internet can POST to 127.0.0.1 — the server is local, not the
 * caller. Browsers always attach `Origin` to a cross-origin write, so a missing
 * header means a same-origin or non-browser caller, which is fine. A present
 * header must name loopback.
 */
function originAllowed (req) {
  const origin = (req.headers ?? {}).origin
  if (origin === undefined || origin === '') return true
  try {
    const u = new URL(String(origin))
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

/**
 * A body-bearing write must declare JSON.
 *
 * `text/plain` and `application/x-www-form-urlencoded` are CORS "simple
 * requests": the browser sends them cross-origin without a preflight, so a
 * hostile page can deliver a JSON body while calling it text. Requiring the
 * JSON content type forces a preflight, which the origin check then rejects.
 */
function isJsonRequest (req) {
  const ct = String((req.headers ?? {})['content-type'] ?? '').toLowerCase()
  return ct.startsWith('application/json')
}

/**
 * Build the handlers for one profile.
 * @param {string} profileDir
 * @param {() => object|undefined} lastReport - returns the newest cached analysis
 * @param {(refresh: boolean) => {payload: object, cached: boolean, ageMs: number}} [panelProvider]
 */
export function createHandlers (profileDir, lastReport, panelProvider) {
  return {
    async getConfig (req, res) {
      try {
        send(res, 200, { ok: true, config: readConfig(profileDir) })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },

    async putConfig (req, res) {
      if (req.method !== 'PUT' && req.method !== 'POST') {
        send(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!originAllowed(req)) {
        send(res, 403, { ok: false, error: 'cross-origin write rejected' })
        return
      }
      if (!isJsonRequest(req)) {
        send(res, 415, { ok: false, error: 'content-type must be application/json' })
        return
      }
      let parsed
      try {
        parsed = JSON.parse(await readBody(req))
      } catch (error) {
        send(res, 400, { ok: false, error: 'invalid json: ' + String(error?.message ?? error) })
        return
      }
      if (parsed === null || typeof parsed !== 'object') {
        send(res, 400, { ok: false, error: 'body must be an object' })
        return
      }

      // Partial update: only known keys, only well-typed values. A typo must
      // never silently reset a setting the panel did not intend to touch.
      const next = readConfig(profileDir)
      const applied = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (!WRITEABLE.has(key)) continue
        if (key === 'maxAutoLock') {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) continue
          next.maxAutoLock = Math.min(50, Math.floor(value))
          applied.maxAutoLock = next.maxAutoLock
          continue
        }
        if (typeof value !== 'boolean') continue
        next[key] = value
        applied[key] = value
      }
      try {
        writeConfig(profileDir, next)
        send(res, 200, { ok: true, applied, config: next })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },

    async getReport (req, res) {
      try {
        const report = lastReport?.()
        send(res, 200, { ok: true, report: report ?? null })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },

    // Touchpoints + ghost, cached by lib/panel.mjs. `?refresh=1` is the only way
    // to force a rescan, and it is what the panel's refresh button sends.
    async getPanel (req, res) {
      if (panelProvider === undefined) {
        send(res, 200, { ok: false, error: 'panel unavailable' })
        return
      }
      let refresh = false
      try {
        const url = new URL(String(req.url ?? '/'), 'http://localhost')
        refresh = url.searchParams.get('refresh') === '1'
      } catch { /* malformed url: serve the cache */ }
      try {
        const { payload, cached, ageMs } = panelProvider(refresh)
        send(res, 200, { ok: true, cached, ageMs, panel: payload })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },

    /**
     * Lock exactly the plugins the newest analysis proved broken.
     *
     * Refusals are the point here:
     *   - no analysed report: nothing to act on,
     *   - report from another profile: locking the wrong tree is unrecoverable
     *     for that user,
     *   - only `broken` entries with a real client/host evidence note are
     *     passed on; `service-absent` stays advisory (see lockFromAnalysis).
     *
     * The write itself is the same function the CLI calls, so the panel cannot
     * drift from `guard.mjs lock`.
     */
    async postLock (req, res) {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      // No body, so no JSON requirement — but a hostile page must not be able to
      // make the host rewrite the profile's patch file. It carries an Origin.
      if (!originAllowed(req)) {
        send(res, 403, { ok: false, error: 'cross-origin write rejected' })
        return
      }
      let report
      try { report = lastReport?.() } catch { report = undefined }
      if (!report || report.stage !== 'analysed') {
        send(res, 409, { ok: false, error: 'no analysed report to lock from' })
        return
      }
      if (typeof report.profileDir === 'string' && report.profileDir !== profileDir) {
        send(res, 409, { ok: false, error: 'report belongs to a different profile' })
        return
      }
      try {
        const analysis = { ...report, profileDir: report.profileDir ?? profileDir }
        const result = lockFromAnalysis(analysis)
        send(res, 200, { ok: true, ...result })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }
}

/**
 * Register the routes on a web server service.
 * @param {{register: Function}} webServer
 * @param {string} profileDir
 * @param {() => object|undefined} lastReport
 * @param {(refresh: boolean) => {payload: object, cached: boolean, ageMs: number}} [panelProvider]
 */
export function registerRoutes (webServer, profileDir, lastReport, panelProvider) {
  const h = createHandlers(profileDir, lastReport, panelProvider)
  const disposers = []
  const add = (path, handler) => {
    const dispose = webServer.register({ kind: 'exact', path, handler })
    if (typeof dispose === 'function') disposers.push(dispose)
  }
  add(`${ROUTE_PREFIX}/config.json`, (req, res) => {
    if (req.method === 'GET') return h.getConfig(req, res)
    return h.putConfig(req, res)
  })
  add(`${ROUTE_PREFIX}/report.json`, (req, res) => h.getReport(req, res))
  add(`${ROUTE_PREFIX}/panel.json`, (req, res) => h.getPanel(req, res))
  add(`${ROUTE_PREFIX}/lock.json`, (req, res) => {
    if (req.method === 'POST') return h.postLock(req, res)
    send(res, 405, { ok: false, error: 'method not allowed' })
  })
  return () => { for (const d of disposers) { try { d() } catch { /* ignore */ } } }
}

/** Where the panel's report comes from. */
export function reportPath (pkgDir) {
  return join(pkgDir, '.cache', 'last-report.json')
}

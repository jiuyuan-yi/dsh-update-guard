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
import { readConfig, writeConfig } from './run.mjs'
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
 * Build the three handlers for one profile.
 * @param {string} profileDir
 * @param {() => object|undefined} lastReport - returns the newest cached analysis
 */
export function createHandlers (profileDir, lastReport) {
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
  }
}

/**
 * Register the routes on a web server service.
 * @param {{register: Function}} webServer
 * @param {string} profileDir
 * @param {() => object|undefined} lastReport
 */
export function registerRoutes (webServer, profileDir, lastReport) {
  const h = createHandlers(profileDir, lastReport)
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
  return () => { for (const d of disposers) { try { d() } catch { /* ignore */ } } }
}

/** Where the panel's report comes from. */
export function reportPath (pkgDir) {
  return join(pkgDir, '.cache', 'last-report.json')
}

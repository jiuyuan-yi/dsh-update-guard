/**
 * The update feed, read the way the shipped updater reads it.
 *
 * `check` normally needs a downloaded installer before it can compare anything,
 * which leaves a narrow window: the app prompts for restart the moment the
 * download finishes, and a restart kills any comparison still running. But two
 * things are available before the download even starts — the target version,
 * and the plugins' own declared ranges. That is enough to answer "should I take
 * this update at all", which is the question people actually ask first.
 *
 * `app-update.yml` ships inside the install root and names the feed; the feed
 * itself publishes one YAML per channel with the current version.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import https from 'node:https'

/**
 * Read `resources/app-update.yml`.
 * @param {string} installRoot e.g. D:\deep
 * @returns {{url: string, channel: string, provider: string}|null}
 */
export function readFeedConfig (installRoot) {
  if (!installRoot) return null
  const file = join(installRoot, 'resources', 'app-update.yml')
  if (!existsSync(file)) return null
  let text
  try { text = readFileSync(file, 'utf8') } catch { return null }

  const pick = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm').exec(text)
    if (!m) return ''
    return m[1].replace(/^["']|["']$/g, '').trim()
  }
  const url = pick('url')
  if (!url) return null
  return { url, channel: pick('channel') || 'latest', provider: pick('provider') || 'generic' }
}

/**
 * Parse the fields we need out of a feed YAML.
 *
 * Deliberately not a YAML parser: the file is machine-generated with a fixed
 * shape, and pulling in a dependency for four scalar keys would cost more than
 * it buys. Multi-line `>-` blocks are folded by taking the first line, which is
 * all a URL or a hash needs.
 */
export function parseFeedYaml (text) {
  const version = (/^version:\s*(.+)$/m.exec(text) ?? [])[1]
  const fileUrl = (/^\s*-\s*url:\s*(?:>-?\s*)?(.+)$/m.exec(text) ?? [])[1]
  const size = (/^\s*size:\s*(\d+)/m.exec(text) ?? [])[1]
  const sha512 = (/^\s*sha512:\s*(?:>-?\s*)?(.+)$/m.exec(text) ?? [])[1]
  const releaseDate = (/^releaseDate:\s*(.+)$/m.exec(text) ?? [])[1]
  const clean = (v) => (v === undefined ? undefined : String(v).trim().replace(/^["']|["']$/g, ''))
  return {
    version: clean(version),
    fileUrl: clean(fileUrl),
    size: size === undefined ? undefined : Number(size),
    sha512: clean(sha512),
    releaseDate: clean(releaseDate)
  }
}

/**
 * Fetch the feed document for one channel.
 *
 * Uses `node:https` rather than fetch so this works on older runtimes the app
 * still supports, and so a redirect or a 404 is visible rather than swallowed.
 * @returns {Promise<{ok: true, version: string, fileUrl?: string, size?: number, releaseDate?: string, feedUrl: string} | {ok: false, error: string, feedUrl: string}>}
 */
export function fetchFeed (config, options = {}) {
  const timeout = options.timeoutMs ?? 20000
  const feedUrl = new URL(`${config.channel}.yml`, config.url.replace(/\/?$/, '/')).toString()

  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let req
    try {
      if (!/^https:/i.test(feedUrl)) throw new Error(`unsupported feed scheme: ${feedUrl}`)
      req = https.get(feedUrl, { headers: { 'user-agent': 'dsh-update-guard' }, timeout }, (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          done({ ok: false, error: `HTTP ${res.statusCode}`, feedUrl })
          return
        }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', c => { body += c })
        res.on('end', () => {
          const parsed = parseFeedYaml(body)
          if (!parsed.version) {
            done({ ok: false, error: 'feed has no version field', feedUrl })
            return
          }
          done({ ok: true, feedUrl, ...parsed })
        })
      })
      req.on('timeout', () => { req.destroy(new Error(`timed out after ${timeout}ms`)) })
      req.on('error', (error) => done({ ok: false, error: String(error?.message ?? error), feedUrl }))
    } catch (error) {
      done({ ok: false, error: String(error?.message ?? error), feedUrl })
    }
  })
}

/**
 * How far apart are two versions?
 *
 * Reported as a shape rather than a verdict: crossing a major/minor boundary is
 * a different risk class from moving one patch or one prerelease number within
 * the same line, and the caller decides what to do with that.
 */
export function versionDistance (from, to) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v ?? ''))
    if (!m) return null
    return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? '' }
  }
  const a = parse(from)
  const b = parse(to)
  if (!a || !b) return { kind: 'unknown', label: 'unparseable version' }

  if (a.major !== b.major) return { kind: 'major', label: `${a.major} → ${b.major}` }
  if (a.minor !== b.minor) return { kind: 'minor', label: `${a.major}.${a.minor} → ${b.major}.${b.minor}` }
  if (a.patch !== b.patch) return { kind: 'patch', label: `${a.patch} → ${b.patch}` }
  if (a.pre !== b.pre) return { kind: 'prerelease', label: `${a.pre || '(none)'} → ${b.pre || '(none)'}` }
  return { kind: 'same', label: 'same version' }
}

/**
 * Atomic replace for text files we are not allowed to half-write.
 *
 * These are exactly the files the tool exists to protect: the profile
 * `package.json`, `cordis.patch.yml` and the guard config. A crash between the
 * open and the close leaves a truncated file, and a truncated `package.json` is
 * the failure this plugin repairs — it must not be the one causing it.
 *
 * `rename` is atomic on both NTFS and POSIX, but on Windows it fails with EPERM
 * when something briefly holds the destination (antivirus, indexer, an editor).
 * That is transient, so retry a few times with a short backoff instead of
 * surfacing a scary error for something that would succeed 60 ms later.
 */
import { writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST'])

/** Real sleep without burning CPU; Atomics.wait is available in workers too. */
function sleepSync (ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) { /* last resort */ }
  }
}

/**
 * Write `content` to `path` so that readers see either the old bytes or the new
 * bytes, never a partial file.
 *
 * @param {string} path
 * @param {string} content
 * @param {{retries?: number, delayMs?: number}} [opts]
 * @returns {string} the path
 */
export function atomicWriteFile (path, content, opts = {}) {
  const retries = Number.isInteger(opts.retries) ? opts.retries : 3
  const baseDelay = Number.isInteger(opts.delayMs) ? opts.delayMs : 60
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(5).toString('hex')}`

  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' })
      renameSync(tmp, path)
      return path
    } catch (error) {
      lastError = error
      if (!TRANSIENT.has(error?.code) || attempt === retries) break
      sleepSync(baseDelay * (attempt + 1))
    }
  }
  try { unlinkSync(tmp) } catch { /* never created, or already renamed */ }
  throw lastError
}

/** Same guarantees for a JSON document. */
export function atomicWriteJson (path, value, opts = {}) {
  return atomicWriteFile(path, JSON.stringify(value, null, 2), opts)
}

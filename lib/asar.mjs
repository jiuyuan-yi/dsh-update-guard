/**
 * Minimal ASAR reader (read-only, no Electron dependency).
 *
 * Layout: [uint32 pickle size][uint32 header payload size][uint32 json length]
 * followed by the JSON directory and then file payload bytes. ASAR offsets are
 * relative to the beginning of the file-data section.
 */
import { readFileSync } from 'node:fs'

/** Parse and validate an archive directory before exposing entry lookup. */
export function openAsar (path) {
  const buf = readFileSync(path)
  if (buf.length < 16) throw new Error('invalid ASAR: header is truncated')

  const headerPayloadSize = buf.readUInt32LE(4)
  const jsonLen = buf.readUInt32LE(12)
  const dataStart = 8 + headerPayloadSize
  const jsonStart = 16
  const jsonEnd = jsonStart + jsonLen

  if (!Number.isSafeInteger(dataStart) || dataStart < jsonStart || dataStart > buf.length) {
    throw new Error('invalid ASAR: header payload size is out of bounds')
  }
  if (!Number.isSafeInteger(jsonEnd) || jsonEnd > dataStart) {
    throw new Error('invalid ASAR: directory JSON is out of bounds')
  }

  let dir
  try {
    dir = JSON.parse(buf.subarray(jsonStart, jsonEnd).toString('utf8'))
  } catch (error) {
    throw new Error(`invalid ASAR: directory JSON cannot be parsed (${error?.message ?? error})`)
  }
  if (dir === null || typeof dir !== 'object' || Array.isArray(dir)) {
    throw new Error('invalid ASAR: directory root is not an object')
  }

  /**
   * Find the first regular file whose full path matches `pattern`.
   * Bounds are checked before creating the Buffer view: Buffer.subarray silently
   * truncates out-of-range offsets, which could otherwise look like valid text.
   */
  function visit (pattern, onHit) {
    if (!(pattern instanceof RegExp)) throw new TypeError('ASAR find expects a RegExp')
    let stop = false
    ;(function walk (node, parts) {
      if (stop || !node || typeof node !== 'object') return
      if (node.files && typeof node.files === 'object') {
        for (const [name, child] of Object.entries(node.files)) walk(child, [...parts, name])
        return
      }
      if (node.size === undefined) return

      // Payload lives in app.asar.unpacked/, not inside the archive: there is
      // nothing here to slice and no offset to validate. 1583 of the 22102
      // entries in the real archive are like this.
      if (node.unpacked === true) return

      // Validate every remaining entry, not just the one we return: a corrupt
      // directory should be diagnosable wherever it is, and the negative-size
      // case is exactly what asar-safety checks for.
      const size = Number(node.size)
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error(`invalid ASAR: invalid size for ${parts.join('/')}`)
      }
      // A zero-length entry may legitimately carry no offset.
      let offset = 0
      if (size > 0) {
        offset = typeof node.offset === 'string' && /^\d+$/.test(node.offset)
          ? Number(node.offset)
          : Number.NaN
        if (!Number.isSafeInteger(offset) || offset < 0) {
          throw new Error(`invalid ASAR: invalid offset for ${parts.join('/')}`)
        }
      }
      const start = dataStart + offset
      const end = start + size
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < dataStart || end > buf.length) {
        throw new Error(`invalid ASAR: entry is out of bounds: ${parts.join('/')}`)
      }

      const full = parts.join('/')
      pattern.lastIndex = 0
      if (!pattern.test(full)) return
      if (onHit({ path: full, size, buffer: buf.subarray(start, end) }) === true) stop = true
    })(dir, [])
  }

  function find (pattern) {
    let hit
    visit(pattern, entry => { hit = entry; return true })
    return hit
  }

  /** Every matching entry, in directory order. Used where one hit is not enough. */
  function findAll (pattern) {
    const out = []
    visit(pattern, entry => { out.push(entry) })
    return out
  }

  return { find, findAll, directory: dir, byteLength: buf.length }
}

/** Convenience: read a matching entry as UTF-8 text. */
export function asarText (asarPath, pattern) {
  const asar = openAsar(asarPath)
  const hit = asar.find(pattern)
  if (!hit) return undefined
  return { path: hit.path, text: hit.buffer.toString('utf8') }
}

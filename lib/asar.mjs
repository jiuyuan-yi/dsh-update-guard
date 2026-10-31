/**
 * Minimal ASAR reader (read-only, no Electron dependency).
 *
 * Layout: [uint32 4][uint32 headerSize][uint32 payloadSize][uint32 jsonLen] ...
 * Concretely: bytes 4..8 = pickle header size, 8..12 = payload size,
 * 12..16 = JSON length; the JSON directory starts at 16, and file data starts
 * at 8 + payloadSize.
 */
import { readFileSync } from 'node:fs'

/** Parse the archive directory and expose entry lookup by regex. */
export function openAsar (path) {
  const buf = readFileSync(path)
  const jsonLen = buf.readUInt32LE(12)
  const dir = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'))
  const dataStart = 8 + buf.readUInt32LE(4)

  /**
   * Find the first regular file whose full path matches `pattern`.
   * @returns {{path: string, size: number, buffer: Buffer} | undefined}
   */
  function find (pattern) {
    let hit
    ;(function walk (node, parts) {
      if (hit || !node) return
      if (node.files) {
        for (const [name, child] of Object.entries(node.files)) walk(child, [...parts, name])
        return
      }
      if (node.size === undefined) return
      const full = parts.join('/')
      if (!pattern.test(full)) return
      const start = dataStart + Number(node.offset)
      hit = { path: full, size: Number(node.size), buffer: buf.subarray(start, start + Number(node.size)) }
    })(dir, [])
    return hit
  }

  return { find, directory: dir, byteLength: buf.length }
}

/** Convenience: read a matching entry as UTF-8 text. */
export function asarText (asarPath, pattern) {
  const asar = openAsar(asarPath)
  const hit = asar.find(pattern)
  if (!hit) return undefined
  return { path: hit.path, text: hit.buffer.toString('utf8') }
}

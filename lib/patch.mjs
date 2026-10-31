/**
 * Edit the profile's cordis patch layer: disable exactly the entry ids that
 * belong to one plugin, and be able to undo that precisely.
 *
 * Two facts drive this module:
 *
 * 1. A patch entry's `id` is NOT the package name. Each bundle declares its own
 *    ids in its `cordis.patch.yml` (`@xsj/dsh-rewind` -> `rewind`,
 *    `dsh-workbuddy-connect` -> `llm-workbuddy`).
 * 2. One package can declare MANY ids (`dsh-purge-community` declares 11).
 *    Disabling one of them leaves the plugin running.
 *
 * So locking is per-id over the union the package declares, and every change is
 * recorded in a state file so `unlock` can restore the user's original values
 * instead of guessing.
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export const STATE_FILE = '.dsh-update-guard-state.json'
const MARKER = '# [dsh-update-guard] auto-disabled for an incoming update'

/** All `- id:` values a bundle declares in its own patch file. */
export function entryIdsOf (pluginDir) {
  const p = join(pluginDir, 'cordis.patch.yml')
  if (!existsSync(p)) return []
  let text
  try { text = readFileSync(p, 'utf8') } catch { return [] }
  const ids = []
  const re = /^\s*-\s*id:\s*([A-Za-z0-9_.@/-]+)\s*$/gm
  let m
  while ((m = re.exec(text)) !== null) {
    if (!ids.includes(m[1])) ids.push(m[1])
  }
  return ids
}

function readText (p) {
  return readFileSync(p, 'utf8')
}

function detectEol (text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * Split the patch into top-level blocks. A block starts at a column-0 `-` and
 * runs until the next one (or EOF). `id` may sit at any indent inside it.
 */
function splitBlocks (lines) {
  const blocks = []
  let current = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^-(\s|$)/.test(line)) {
      if (current) blocks.push(current)
      current = { start: i, end: i, id: undefined }
    }
    if (current) {
      current.end = i
      if (current.id === undefined) {
        const m = /^\s*-\s*id:\s*([A-Za-z0-9_.@/-]+)\s*$/.exec(line) ?? /^\s*id:\s*([A-Za-z0-9_.@/-]+)\s*$/.exec(line)
        if (m) current.id = m[1]
      }
    }
  }
  if (current) blocks.push(current)
  return blocks
}

/**
 * A `disabled:` value this tool is willing to rewrite.
 *
 * Bundle patches legitimately use the Loader's `!!js` dialect for conditional
 * entries (`disabled: !!js/ctx.env.X`). Rewriting one of those to a literal
 * destroys the condition — the same defect reported against another plugin
 * manager (dsh-market#1043), where writing every line to `disabled: false`
 * clobbered `!!js` conditions and rolled back installs. So `!!`-prefixed
 * values are refused, not rewritten.
 */
function rewriteableDisabled (line) {
  const m = /^(\s*)disabled:\s*(\S+)\s*$/.exec(line)
  if (!m) return undefined
  if (m[2].startsWith('!!')) return undefined
  if (m[2] !== 'true' && m[2] !== 'false') return undefined
  return { indent: m[1], value: m[2] }
}

/**
 * Disable one id, recording what changed.
 * @returns {{id: string, action: 'modified'|'added'|'refused', reason?: string, prior?: string}}
 */
function disableId (lines, id) {
  const blocks = splitBlocks(lines)
  const hit = blocks.find(b => b.id === id)
  if (hit) {
    // look for an existing disabled: line inside the block
    for (let i = hit.start; i <= hit.end; i++) {
      if (!/^\s*disabled:/.test(lines[i])) continue
      const rw = rewriteableDisabled(lines[i])
      if (rw === undefined) {
        return { id, action: 'refused', reason: '该条目用的是条件表达式（!!js），不覆盖' }
      }
      const prior = lines[i]
      lines[i] = `${rw.indent}disabled: true`
      return { id, action: 'modified', prior }
    }
    // no disabled line: insert right after the id line
    let at = hit.start
    for (let i = hit.start; i <= hit.end; i++) {
      if (/^\s*-\s*id:/.test(lines[i]) || /^\s*id:/.test(lines[i])) { at = i; break }
    }
    const indent = (/^(\s*)/.exec(lines[at])?.[1] ?? '') + '  '
    lines.splice(at + 1, 0, `${indent}disabled: true`)
    return { id, action: 'modified', prior: undefined }
  }
  // append a new top-level block
  lines.push(MARKER)
  lines.push(`- id: ${id}`)
  lines.push('  disabled: true')
  return { id, action: 'added' }
}

/**
 * Lock a set of ids.
 * @param {string} profileDir
 * @param {string[]} ids
 * @param {{expectedVersion?: string}} meta
 * @returns {{changed: string[], already: string[], refused: {id: string, reason: string}[]}}
 */
export function lockIds (profileDir, ids, meta = {}) {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const statePath = join(profileDir, STATE_FILE)
  if (!existsSync(patchPath)) throw new Error('cordis.patch.yml not found in profile')

  const original = readText(patchPath)
  const eol = detectEol(original)
  const lines = original.split(/\r?\n/)

  let state = { version: 1, target: meta.expectedVersion ?? null, entries: [] }
  if (existsSync(statePath)) {
    try { state = JSON.parse(readText(statePath)) } catch { /* start fresh */ }
  }

  const changed = []
  const already = []
  const refused = []
  for (const id of ids) {
    const prior = state.entries.find(e => e.id === id)
    if (prior) { already.push(id); continue }
    const record = disableId(lines, id)
    if (record.action === 'refused') {
      refused.push({ id, reason: record.reason ?? 'refused' })
      continue
    }
    state.entries.push({ id: record.id, action: record.action, prior: record.prior ?? null })
    changed.push(id)
  }

  if (changed.length > 0) {
    // atomic-ish: write temp then rename
    const next = lines.join(eol)
    const tmp = `${patchPath}.tmp-${process.pid}`
    writeFileSync(tmp, next, { encoding: 'utf8' })
    renameSync(tmp, patchPath)
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
  }
  return { changed, already, refused }
}

/**
 * Undo every change this tool recorded, restoring the user's original values.
 * Each branch locates the target by BLOCK (top-level item containing that id),
 * never by "first matching line", so a user's unrelated `disabled:` line is
 * never touched.
 * @returns {{restored: string[], missing: string[]}}
 */
export function unlockAll (profileDir) {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const statePath = join(profileDir, STATE_FILE)
  if (!existsSync(statePath)) return { restored: [], missing: [] }

  const state = JSON.parse(readText(statePath))
  const original = readText(patchPath)
  const eol = detectEol(original)
  let lines = original.split(/\r?\n/)

  const restored = []
  const missing = []

  for (const entry of [...state.entries].reverse()) {
    if (entry.action === 'added') {
      // Remove the three-line block we appended: marker, `- id: X`, `disabled: true`.
      const at = lines.findIndex((l, i) =>
        l === MARKER &&
        /^\s*-\s*id:\s*([A-Za-z0-9_.@/-]+)\s*$/.test(lines[i + 1] ?? '') &&
        RegExp(`^\\s*-\\s*id:\\s*${entry.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(lines[i + 1] ?? ''))
      if (at === -1) { missing.push(entry.id); continue }
      let end = at + 1
      // consume the id line and its indented body
      end++
      while (end < lines.length && /^\s+/.test(lines[end]) && lines[end].trim() !== '') end++
      lines.splice(at, end - at)
      restored.push(entry.id)
      continue
    }

    // action === 'modified': the block exists in the user's own patch
    const blocks = splitBlocks(lines)
    const hit = blocks.find(b => b.id === entry.id)
    if (!hit) { missing.push(entry.id); continue }

    if (typeof entry.prior === 'string') {
      // Put the original `disabled:` line back, at its recorded indent.
      let done = false
      for (let i = hit.start; i <= hit.end; i++) {
        if (/^(\s*)disabled:\s*(true|false)\s*$/.test(lines[i])) {
          lines[i] = entry.prior
          done = true
          break
        }
      }
      if (!done) missing.push(entry.id)
      else restored.push(entry.id)
    } else {
      // We inserted a `disabled: true` that had no precedent: drop that one line.
      let done = false
      for (let i = hit.start; i <= hit.end; i++) {
        if (/^\s*disabled:\s*true\s*$/.test(lines[i])) {
          lines.splice(i, 1)
          done = true
          break
        }
      }
      if (!done) missing.push(entry.id)
      else restored.push(entry.id)
    }
  }

  const tmp = `${patchPath}.tmp-${process.pid}`
  writeFileSync(tmp, lines.join(eol), { encoding: 'utf8' })
  renameSync(tmp, patchPath)
  writeFileSync(statePath, JSON.stringify({ version: 1, target: null, entries: [] }, null, 2), 'utf8')
  return { restored, missing }
}

/** Guarded entry ids currently recorded. */
export function guardedIds (profileDir) {
  const statePath = join(profileDir, STATE_FILE)
  if (!existsSync(statePath)) return []
  try { return JSON.parse(readText(statePath)).entries.map(e => e.id) } catch { return [] }
}

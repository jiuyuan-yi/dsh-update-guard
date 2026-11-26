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
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWriteFile } from './atomic.mjs'

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

/** Replace one file atomically using a unique sibling temp file. */
function atomicWrite (path, content) {
  // Shared with restore/config: temp file + rename, with a short retry when
  // Windows briefly refuses the rename (EPERM from AV or an indexer).
  return atomicWriteFile(path, content)
}

function readState (statePath) {
  if (!existsSync(statePath)) return { version: 1, target: null, entries: [] }
  let state
  try { state = JSON.parse(readText(statePath)) } catch (error) {
    throw new Error(`锁定状态文件损坏，拒绝覆盖以免丢失撤销记录: ${error?.message ?? error}`)
  }
  if (state?.version !== 1 || !Array.isArray(state.entries) ||
      !state.entries.every(e => e && typeof e.id === 'string' &&
        ['added', 'modified'].includes(e.action) &&
        (e.prior === null || typeof e.prior === 'string'))) {
    throw new Error('锁定状态文件格式无效，拒绝继续以免丢失撤销记录')
  }
  return state
}

/**
 * Split the patch into top-level blocks. A block starts at a column-0 `-` and
 * runs until the next one (or EOF). `id` may sit at any indent inside it.
 */
/**
 * One id per block, tolerating the shapes a hand-edited YAML file actually has:
 * quoted values and trailing comments. The old pattern required the id to be the
 * last thing on the line, so `- id: "alpha"` or `- id: alpha  # why` parsed as
 * "no id" — and the locker then appended a SECOND block for the same id, leaving
 * the original entry enabled while the state file claimed it was disabled.
 */
const ID_LINE = /^\s*(?:-\s*)?id:\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.@/-]+))\s*(?:#.*)?$/

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
        const m = ID_LINE.exec(line)
        if (m) current.id = m[1] ?? m[2] ?? m[3]
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
  // Trailing comments are common in hand-edited files and must survive the
  // rewrite. `!!js` expressions contain spaces and quotes, so the value cannot be
  // matched as a single token.
  const m = /^(\s*)disabled:\s*(.+?)(\s+#.*)?\s*$/.exec(line)
  if (!m) return { refuse: 'disabled 行无法识别，拒绝改写' }
  const value = m[2].trim()
  if (value.startsWith('!!')) {
    return { refuse: 'disabled 行是条件表达式（!!js），覆盖会破坏它' }
  }
  if (value !== 'true' && value !== 'false') {
    return { refuse: `disabled 行的值是 ${value}，不是 true/false，拒绝改写` }
  }
  return { indent: m[1], value, comment: m[3] ?? '' }
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
      if (rw.refuse !== undefined) {
        return { id, action: 'refused', reason: rw.refuse }
      }
      const prior = lines[i]
      lines[i] = `${rw.indent}disabled: true${rw.comment}`
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
  // Append a new top-level block — but only after proving the file does not
  // already mention this id in a form we failed to parse. Appending a duplicate
  // would leave the real entry enabled while the state file claims a lock; that
  // is worse than refusing.
  const alreadyPresent = lines.some(l => /^\s*(?:-\s*)?id:/.test(l) && l.includes(id))
  if (alreadyPresent) {
    return {
      id,
      action: 'refused',
      reason: '文件里已出现该 id 的条目，但格式无法安全解析；拒绝追加重复块',
    }
  }
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

  // A malformed state file may contain the only record of an earlier edit.
  // Never silently replace it with an empty state: that would make those edits
  // impossible to undo accurately.
  const state = readState(statePath)
  if (meta.expectedVersion !== undefined) state.target = meta.expectedVersion

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
    // Re-read before committing. The settings panel and the CLI can both write
    // this file; a blind overwrite would silently discard whichever edit landed
    // in between. Refusing costs a retry, and nothing has been changed yet.
    const current = readText(patchPath)
    if (current !== original) {
      throw new Error('cordis.patch.yml 在本次读取之后被其他程序修改，已中止以避免覆盖；请重试')
    }
    // Commit the undo journal first. If the process dies between the two
    // renames, unlock can still safely replay the recorded operation (and is
    // idempotent when the patch write had not happened yet).
    const hadState = existsSync(statePath)
    const previousState = hadState ? readText(statePath) : undefined
    atomicWrite(statePath, JSON.stringify(state, null, 2))
    try {
      atomicWrite(patchPath, lines.join(eol))
    } catch (error) {
      // Roll back the journal if the patch replacement itself failed.
      try {
        if (hadState) atomicWrite(statePath, previousState)
        else unlinkSync(statePath)
      } catch (rollbackError) {
        throw new Error(`写入补丁失败，且撤销记录回滚失败；请保留 ${statePath} 以便恢复。原错误: ${error?.message ?? error}；回滚错误: ${rollbackError?.message ?? rollbackError}`)
      }
      throw error
    }
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

  const state = readState(statePath)
  const original = readText(patchPath)
  const eol = detectEol(original)
  let lines = original.split(/\r?\n/)

  const restored = []
  const missing = []
  const unresolved = []

  for (const entry of [...state.entries].reverse()) {
    if (entry.action === 'added') {
      // Remove the three-line block we appended: marker, `- id: X`, `disabled: true`.
      const at = lines.findIndex((l, i) =>
        l === MARKER &&
        /^\s*-\s*id:\s*([A-Za-z0-9_.@/-]+)\s*$/.test(lines[i + 1] ?? '') &&
        RegExp(`^\\s*-\\s*id:\\s*${entry.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(lines[i + 1] ?? ''))
      if (at === -1) { missing.push(entry.id); unresolved.push(entry); continue }
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
    if (!hit) { missing.push(entry.id); unresolved.push(entry); continue }

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
      if (!done) { missing.push(entry.id); unresolved.push(entry) }
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
      if (!done) { missing.push(entry.id); unresolved.push(entry) }
      else restored.push(entry.id)
    }
  }

  if (restored.length > 0) atomicWrite(patchPath, lines.join(eol))
  // Preserve entries that could not be located. Clearing them would discard
  // the only recovery information while telling the caller they were missing.
  atomicWrite(statePath, JSON.stringify({ version: 1, target: unresolved.length ? state.target : null, entries: unresolved }, null, 2))
  return { restored, missing, remaining: unresolved.length }
}

/** Guarded entry ids currently recorded. */
export function guardedIds (profileDir) {
  const statePath = join(profileDir, STATE_FILE)
  if (!existsSync(statePath)) return []
  try { return JSON.parse(readText(statePath)).entries.map(e => e.id) } catch { return [] }
}

/**
 * The version this lock set was aimed at, or `null` when nothing was recorded.
 *
 * A lock has no built-in expiry: once the update lands, the disabled ids stay
 * disabled forever. The target is what lets `status` say "the version you locked
 * against is the one now installed — you can unlock".
 */
export function lockTarget (profileDir) {
  const statePath = join(profileDir, STATE_FILE)
  if (!existsSync(statePath)) return null
  try {
    const state = JSON.parse(readText(statePath))
    return typeof state?.target === 'string' ? state.target : null
  } catch { return null }
}

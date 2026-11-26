/**
 * Extract the shared client-module surface from a built shell bundle.
 *
 * Client plugins do not get globals: they `require()` names out of a table the
 * shell bundle builds. That table is the real API boundary between the runtime
 * and every third-party plugin. If a name or a member disappears, the plugin
 * still loads and then throws at render time.
 *
 * The bundle is minified, so identifiers differ per build. We therefore locate
 * modules by their TABLE KEY, never by variable name.
 */

/** Modules this guard tracks. React/zod/cordis are vendored and not version-coupled. */
export const TRACKED = [
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-dockkit',
  '@deepseek-ai/dsh-client-store',
]

/**
 * Members that must be present for a module's parse to be believable.
 *
 * The minified table is read by identifier pattern, not by a JS parser. If that
 * pattern latches onto the wrong symbol, the module's member list comes back as
 * unrelated identifiers — and then every real member the plugins use looks
 * "missing", which is a mass false positive.
 *
 * At least ONE name per module must be found. Requiring all of them would turn
 * a single rename into a false alarm, which is the failure mode being avoided.
 */
export const CANARY = {
  '@deepseek-ai/dsh-client-ui-primitives': ['Button', 'Checkbox'],
  '@deepseek-ai/dsh-client-ui-slots': ['SlotCore', 'resolveSlotLabel'],
  '@deepseek-ai/dsh-client-ui-dockkit': ['DockController', 'DockLayout'],
  '@deepseek-ai/dsh-client-store': ['defineStore', 'createSnapshotStore'],
}

/**
 * Modules whose member list does not contain any canary name.
 *
 * An empty or absent member list is not reported: that is "the scanner found
 * nothing", which `uncertainModulesOf` already covers. This answers a different
 * question — "the scanner found things, but are they the right things".
 *
 * @param {{modules?: Record<string, {members?: string[]}>}|undefined} surface
 * @returns {string[]}
 */
export function canarySuspicious (surface) {
  const out = []
  const modules = surface?.modules
  if (modules === null || typeof modules !== 'object') return out
  for (const [name, names] of Object.entries(CANARY)) {
    const members = modules[name]?.members
    if (!Array.isArray(members) || members.length === 0) continue
    if (!names.some(n => members.includes(n))) out.push(name)
  }
  return out
}

function esc (s) {
  return s.replace(/[.*+?^${}()|[\]\\@/]/g, m => '\\' + m)
}

/**
 * Parse the module table into name -> local identifier.
 * The table is emitted as a returned object literal; entries look like
 *   "react":aC,"@deepseek-ai/cordis":Ub,...
 */
export function readModuleTable (text) {
  const table = new Map()
  const re = /"([^"\\]+)"\s*:\s*([A-Za-z_$][\w$]*)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const name = m[1]
    if (!name.startsWith('@deepseek-ai/') && name !== 'react' && name !== 'zod') continue
    if (!table.has(name)) table.set(name, m[2])
  }
  return table
}

/**
 * Parse an export object bound to `ident`.
 * Handles the frozen form the build emits and a plain object literal fallback.
 * @returns {{members: string[], confidence: 'frozen'|'literal'|'none'}}
 */
export function exportsOf (text, ident) {
  const frozen = new RegExp(
    `\\b${esc(ident)}\\s*=\\s*Object\\.freeze\\(\\s*Object\\.defineProperty\\(\\s*\\{\\s*__proto__\\s*:\\s*null\\s*,`)
  const fm = frozen.exec(text)
  if (fm) {
    return { members: parseObjectKeys(text, fm.index + fm[0].length), confidence: 'frozen' }
  }
  const plain = new RegExp(`\\b${esc(ident)}\\s*=\\s*\\{`)
  const pm = plain.exec(text)
  if (pm) {
    return { members: parseObjectKeys(text, pm.index + pm[0].length), confidence: 'literal' }
  }
  return { members: [], confidence: 'none' }
}

/** Collect top-level `name:` keys until the matching close brace. */
function parseObjectKeys (text, start) {
  const members = []
  let depth = 0
  let i = start
  let segStart = start

  const flush = (end) => {
    const seg = text.slice(segStart, end)
    const km = /^\s*(?:([A-Za-z_$][\w$]*)|"([^"]+)")\s*:/.exec(seg)
    if (km) members.push(km[1] ?? km[2])
    segStart = end + 1
  }

  while (i < text.length) {
    const ch = text[i]
    if (ch === '{' || ch === '[' || ch === '(') { depth++; i++; continue }
    if (ch === '}' || ch === ']' || ch === ')') {
      if (depth === 0 && ch === '}') { flush(i); break }
      depth--; i++; continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch
      i++
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue }
        if (text[i] === q) { i++; break }
        i++
      }
      continue
    }
    if (ch === ',' && depth === 0) { flush(i); i++; continue }
    i++
  }
  return members
}

/**
 * Full surface for one shell bundle.
 * @returns {{modules: Record<string, {members: string[], confidence: string}>, tracked: Record<string, string[]>}}
 */
export function surfaceOf (text) {
  const table = readModuleTable(text)
  const modules = {}
  function add (name) {
    const ident = table.get(name)
    if (ident === undefined) return
    const { members, confidence } = exportsOf(text, ident)
    modules[name] = { members, confidence }
  }
  for (const name of TRACKED) add(name)
  // Always include primitives even if the table parse missed it.
  if (modules['@deepseek-ai/dsh-client-ui-primitives'] === undefined) {
    for (const [name, ident] of table) {
      if (name.endsWith('ui-primitives')) {
        const { members, confidence } = exportsOf(text, ident)
        modules[name] = { members, confidence }
      }
    }
  }
  const tracked = {}
  for (const [name, info] of Object.entries(modules)) tracked[name] = info.members
  return { modules, tracked, tableSize: table.size }
}

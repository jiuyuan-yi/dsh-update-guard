/**
 * Minimal semver parsing and range matching.
 *
 * The guard has to answer one question without any archive tool: does this
 * plugin's declared `engines.dsh` / `peerDependencies["@deepseek-ai/dsh"]`
 * accept the version we are about to install? That is exactly what the loader
 * itself checks, so matching its behaviour matters more than covering every
 * range form ever written.
 *
 * Supported: `*`, exact, `>=`, `>`, `<=`, `<`, `=`, `^`, `~`, `||`, and
 * space-separated intersections. Anything else returns `undefined` (unknown),
 * never a guess.
 */

/**
 * @returns {{major: number, minor: number, patch: number, pre: string[]}|undefined}
 */
export function parseVersion (input) {
  if (typeof input !== 'string') return undefined
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(input.trim())
  if (!m) return undefined
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
  }
}

/** Compare two parsed versions: -1, 0, 1. Prerelease sorts before release. */
export function compare (a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const len = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < len; i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d < 0 ? -1 : 1
      continue
    }
    if (nx !== ny) return nx ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** A simple comparator: {op, version}. */
function parseComparator (token) {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token)
  if (!m) return undefined
  const op = m[1] ?? '='
  const version = parseVersion(m[2])
  if (version === undefined) return undefined
  return { op, version }
}

/** Does `version` satisfy one comparator? */
function satisfiedBy (version, { op, version: bound }) {
  const c = compare(version, bound)
  switch (op) {
    case '=': return c === 0
    case '>': return c > 0
    case '>=': return c >= 0
    case '<': return c < 0
    case '<=': return c <= 0
    case '^': {
      if (c < 0) return false
      // ^1.2.3 -> <2.0.0 ; ^0.2.3 -> <0.3.0 ; ^0.0.3 -> <0.0.4
      const upper = bound.major > 0
        ? { major: bound.major + 1, minor: 0, patch: 0, pre: [] }
        : bound.minor > 0
          ? { major: 0, minor: bound.minor + 1, patch: 0, pre: [] }
          : { major: 0, minor: 0, patch: bound.patch + 1, pre: [] }
      return compare(version, upper) < 0
    }
    case '~': {
      if (c < 0) return false
      const upper = { major: bound.major, minor: bound.minor + 1, patch: 0, pre: [] }
      return compare(version, upper) < 0
    }
    default: return false
  }
}

/**
 * Does `input` satisfy `range`?
 * @returns {boolean|undefined} undefined when the range is not understood
 */
export function satisfies (input, range) {
  const version = typeof input === 'string' ? parseVersion(input) : input
  if (version === undefined) return undefined
  if (typeof range !== 'string') return undefined
  const text = range.trim()
  if (text === '' || text === '*' || text === 'x') return true

  // `||` is a union; each side is an intersection of comparators.
  const alternatives = text.split('||').map(s => s.trim()).filter(Boolean)
  if (alternatives.length === 0) return undefined

  for (const alt of alternatives) {
    const tokens = alt.split(/\s+/).filter(Boolean)
    const comparators = []
    let understood = true
    for (const token of tokens) {
      const c = parseComparator(token)
      if (c === undefined) { understood = false; break }
      comparators.push(c)
    }
    if (!understood) return undefined
    if (comparators.every(c => satisfiedBy(version, c))) return true
  }
  return false
}

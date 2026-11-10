/**
 * Tier-0: static touchpoint scan.
 *
 * The cheapest check in the chain, and the only one that needs nothing but the
 * plugin as it sits on disk — no target version, no download, no archive tool.
 * It answers a different question from Tier-1 (declared range) and Tier-2 (client
 * surface): not "will this break", but "how much of the host's unstable innards
 * does this plugin reach into".
 *
 * The classes below follow the touchpoint taxonomy used by the DSH community
 * migration guide, plus subprocess/stdout parsing, which that guide leaves out
 * and which breaks as often as the rest. A plugin that patches host source, or
 * subscribes to internal session events, or parses a CLI's stdout, is exposed to
 * changes that never appear in any semver range — the loader still mounts it and
 * then it misbehaves at runtime.
 *
 * What this is NOT: proof of anything. Zero hits means "not detected by these
 * patterns", not "compatible". Patterns are heuristics over source text; a plugin
 * can reach the same internal surface through a wrapper this does not recognise.
 * Report it as a risk ranking, never as a verdict.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, extname, basename } from 'node:path'

/**
 * Seven classes of host coupling, ordered by how badly a breakage tends to end.
 * `weight` feeds the score: patch-style coupling fails silently and takes the
 * whole update down with it, while stdout parsing merely returns nonsense.
 */
export const TOUCHPOINTS = [
  {
    id: 1,
    slug: 'source-patch',
    name: 'patches host source',
    weight: 5,
    detail: 'Rewrites files inside the installed host. Survives no upgrade: the patch target moves and the plugin either no-ops or corrupts the tree.',
    // Deliberately narrow. `cordis.patch.yml` and the phrase "monkey patch" both
    // appear in ordinary bundle declarations and in comments, so matching them
    // ranked almost everything as high and the score stopped separating anything.
    // What is left is code that actually rewrites an installed tree.
    patterns: [
      /patchedDependencies/,
      /writeFileSync\(\s*[^)]*app\.asar/i,
      /copyFileSync\(\s*[^)]*app\.asar/i,
      /unpack[A-Za-z]*Asar\(/,
      /createPatchEngine\(/
    ]
  },
  {
    id: 2,
    slug: 'internal-events',
    name: 'subscribes to internal events',
    weight: 4,
    detail: 'Event names and payload shapes are internal. Renames are silent: the handler simply stops firing.',
    patterns: [
      /\bSessionEvent\b/,
      /['"]session\/[a-z-]+['"]/,
      /ctx\.on\(\s*['"][a-z]+\/[a-z-]+['"]/,
      /['"]tool\/code-dispatch['"]/,
      /['"]connection\/reset['"]/
    ]
  },
  {
    id: 3,
    slug: 'internal-services',
    name: 'reaches internal services',
    weight: 4,
    detail: 'Private service names and RPC shapes. A removed member throws at call time, not at load time.',
    // `ctx.get('tools')` is published API, not an internal probe — including it
    // made every plugin that registers a tool look like it reaches inside.
    patterns: [
      /\bAPIProxy\b/,
      /\bapiProxy\b/,
      /ctx\.remote\b/,
      /@Remote\b/,
      /@deepseek-ai\/dsh-api-[a-z-]+\/client/
    ]
  },
  {
    id: 4,
    slug: 'host-filesystem',
    name: 'reads or writes host directories',
    weight: 3,
    detail: 'Layout under DSH_HOME and profiles/ changes between releases. A moved directory reads as an empty result, not an error.',
    // `.dsh` and `profiles/` appear in strings that merely mention a path. Only a
    // computed home directory implies this code actually walks the host layout.
    patterns: [
      /\bDSH_HOME\b/,
      /homedir\(\s*\)[^;\n]*\.dsh/,
      /path\.join\(\s*[^)]*['"]profiles['"]/
    ]
  },
  {
    id: 5,
    slug: 'internal-ui',
    name: 'registers into internal UI or command tables',
    weight: 3,
    detail: 'Client slots, command registries and the module loader are not a published API. Keys move between builds.',
    patterns: [
      /registerCommand\(/,
      /registerView\(/,
      /\bcontributes\b/,
      /ctx\.tools\b/,
      /commands\.execute\(/,
      /__ModuleLoader__/,
      /ctx\.slots\b/,
      /useSession\(|useChat\(/
    ]
  },
  {
    id: 6,
    slug: 'custom-channel',
    name: 'opens its own transport or reaches into the DOM',
    weight: 3,
    detail: 'A private server, WebSocket or injected CSS rule assumes a page structure the host does not promise.',
    patterns: [
      /createServer\(/,
      /\bWebSocket\b/,
      /MutationObserver/,
      /insertRule\(/,
      /contenteditable/,
      /setSelectionRange\(/
    ]
  },
  {
    id: 7,
    slug: 'subprocess-output',
    name: 'parses subprocess output',
    weight: 2,
    detail: 'CLI wording and stderr formatting change freely; a parser keyed on prose returns wrong values rather than failing.',
    patterns: [
      /node:child_process/,
      /\bspawn\(/,
      /\bexecSync\(/,
      /execFileSync\(/,
      /\bexeca\b/,
      /Bun\.spawn/
    ]
  }
]

/** Directories that hold no plugin source of its own. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'test', 'tests', '__tests__', 'dist', 'build', '.cache', 'coverage'])

/** Extensions worth scanning. A plugin ships .js/.mjs/.cjs; anything else is data. */
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'])

/** Cap per file so a vendored bundle cannot dominate the scan. */
const MAX_FILE_BYTES = 2 * 1024 * 1024
/** Cap per plugin so a pathological tree cannot stall the console. */
const MAX_FILES = 4000

function collectFiles (root, budget) {
  const out = []
  const stack = [root]
  while (stack.length && out.length < budget) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= budget) break
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      if (!SCAN_EXT.has(extname(entry.name))) continue
      out.push(full)
    }
  }
  return out
}

/**
 * Drop comments before matching.
 *
 * A plugin's own comments explain what it does *not* do ("this never writes into
 * app.asar") and its docs quote API names it merely mentions. Matching raw text
 * let a single explanatory comment rank a clean plugin as a host patcher, which
 * is exactly the false positive that makes a risk report useless.
 *
 * Line-oriented and deliberately simple: block comments are tracked by state, and
 * a line that begins as comment is dropped whole. Inline trailing comments are
 * stripped up to `//` when it is not inside a string. That misses pathological
 * cases (a `//` inside a regex literal) and errs toward dropping text, which is
 * the safe direction here: it can hide a real touchpoint, never invent one.
 */
function stripComments (text) {
  const out = []
  let inBlock = false
  for (const raw of text.split('\n')) {
    let line = raw
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end === -1) continue
      line = line.slice(end + 2)
      inBlock = false
    }
    const start = line.indexOf('/*')
    if (start !== -1 && line.indexOf('*/', start + 2) === -1) {
      inBlock = true
      line = line.slice(0, start)
    }
    const trimmed = line.trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
    const slashes = line.indexOf('//')
    if (slashes !== -1) {
      const before = line.slice(0, slashes)
      const quotes = (before.match(/['"`]/g) || []).length
      if (quotes % 2 === 0) line = before
    }
    out.push(line)
  }
  return out.join('\n')
}

/** Count non-overlapping occurrences, capped so one pathological file cannot dominate. */
function countMatches (text, re) {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g'
  const global = new RegExp(re.source, flags)
  let n = 0
  let m
  while ((m = global.exec(text)) !== null && n < MAX_HITS_PER_FILE) {
    n += 1
    if (m.index === global.lastIndex) global.lastIndex += 1
  }
  return n
}

/** Per-file cap on how much one class may contribute to the hit count. */
const MAX_HITS_PER_FILE = 5

/**
 * Scan one installed plugin directory.
 *
 * @param {string} pluginDir absolute path to the installed package
 * @param {{maxFiles?: number}} [options]
 * @returns {{slug: string, name: string, weight: number, hits: number, files: string[], detail: string}[]}
 */
export function scanPlugin (pluginDir, options = {}) {
  const budget = options.maxFiles ?? MAX_FILES
  if (!existsSync(pluginDir)) return []

  const files = collectFiles(pluginDir, budget)
  const found = new Map()

  for (const file of files) {
    let text
    try {
      const st = statSync(file)
      if (st.size > MAX_FILE_BYTES) continue
      text = stripComments(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    for (const cls of TOUCHPOINTS) {
      let n = 0
      for (const re of cls.patterns) n += countMatches(text, re)
      if (n === 0) continue
      const entry = found.get(cls.slug) ?? { cls, hits: 0, files: [] }
      entry.hits += n
      if (entry.files.length < 5) entry.files.push(basename(file))
      found.set(cls.slug, entry)
    }
  }

  return [...found.values()]
    .map(({ cls, hits, files }) => ({
      slug: cls.slug,
      name: cls.name,
      weight: cls.weight,
      detail: cls.detail,
      hits,
      files
    }))
    .sort((a, b) => b.weight * b.hits - a.weight * a.hits)
}

/**
 * Turn raw hits into a risk band.
 *
 * Deliberately coarse. The point is to separate "this plugin only talks to
 * published services" from "this plugin rewrites the host", not to produce a
 * number anyone should trust to two decimals.
 */
export function riskOf (classes) {
  // A single hit can be one string in one file — a mention, not a dependency.
  // Requiring two hits before a class counts as "reached into" keeps a plugin
  // that merely names an API from ranking alongside one that uses it throughout.
  const reached = classes.filter(c => c.hits >= 2)
  const heavy = reached.filter(c => c.weight >= 4)
  const score = classes.reduce((sum, c) => sum + c.weight * Math.min(c.hits, 3), 0)

  if (classes.some(c => c.slug === 'source-patch' && c.hits >= 2)) {
    return { band: 'high', score, reason: 'writes into the installed host' }
  }
  if (heavy.length >= 3) {
    return { band: 'high', score, reason: 'reaches three or more unstable surfaces' }
  }
  if (heavy.length >= 1) {
    return { band: 'medium', score, reason: 'couples to an unstable surface' }
  }
  if (reached.length >= 2 || classes.length >= 3) {
    return { band: 'medium', score, reason: 'couples to several weak surfaces' }
  }
  if (classes.length > 0) {
    return { band: 'low', score, reason: 'named only, not visibly used' }
  }
  return { band: 'none', score: 0, reason: 'no configured pattern matched' }
}

/**
 * Scan a set of resolved plugin directories.
 *
 * @param {{name: string, version?: string, dir: string}[]} plugins
 */
export function scanAll (plugins, options = {}) {
  const rows = []
  for (const plugin of plugins) {
    const classes = scanPlugin(plugin.dir, options)
    const risk = riskOf(classes)
    rows.push({
      name: plugin.name,
      version: plugin.version ?? '?',
      risk,
      classes
    })
  }
  const order = { high: 0, medium: 1, low: 2, none: 3 }
  rows.sort((a, b) => (order[a.risk.band] - order[b.risk.band]) || a.name.localeCompare(b.name))
  return rows
}

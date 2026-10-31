/**
 * Discover installed plugins and what they take from the shared client modules.
 *
 * A plugin reaches these modules through `require(...)`, and the LOCAL NAME is
 * whatever the plugin's bundler chose (rewind used `UiPrimitives`, another
 * plugin may use `P` or destructure). Matching only a literal `UiPrimitives.`
 * would miss most real plugins, so we resolve the binding first and read the
 * members off that name.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const SHARED_PREFIXES = ['@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-dockkit',
  '@deepseek-ai/dsh-client-store']

function isTracked (moduleName) {
  return SHARED_PREFIXES.includes(moduleName)
}

/**
 * Directories that never ship as runtime behaviour. A plugin's own test fixtures
 * mention member names as data (`'projectUserText'`), and scanning them makes a
 * healthy plugin look broken — including this guard, which would then report
 * *itself* as incompatible and, with auto-lock on, disable itself.
 */
const NON_RUNTIME_DIRS = new Set([
  'node_modules', 'test', 'tests', '__tests__', 'spec', 'specs',
  'fixtures', '__fixtures__', 'examples', 'docs', 'doc', 'coverage',
])

/** File names that are test/tooling rather than runtime. */
const NON_RUNTIME_FILE = /(?:\.(?:test|spec|fixture|stories)\.(?:js|mjs|cjs)$)|(?:^|[/\\])(?:jest|vitest|karma|playwright)\.config\./

/** Recursive .js walk that never descends into nested node_modules or tests. */
function* walkJs (dir, depth = 0) {
  if (depth > 6) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    let dirFlag = false
    try { dirFlag = statSync(p).isDirectory() } catch { continue }
    if (dirFlag) {
      if (NON_RUNTIME_DIRS.has(e.name.toLowerCase())) continue
      yield* walkJs(p, depth + 1)
      continue
    }
    if (!/\.(?:js|mjs|cjs)$/.test(e.name)) continue
    if (NON_RUNTIME_FILE.test(p)) continue
    yield p
  }
}

/**
 * References by module, for one plugin directory.
 * @returns {Map<string, Set<string>>} module -> member names used
 */
export function referencesOf (dir) {
  const refs = new Map()
  const note = (moduleName, member) => {
    if (!refs.has(moduleName)) refs.set(moduleName, new Set())
    refs.get(moduleName).add(member)
  }

  for (const file of walkJs(dir)) {
    let text
    try {
      if (statSync(file).size > 8_000_000) continue
      text = readFileSync(file, 'utf8')
    } catch { continue }
    if (!text.includes('require')) continue

    // form 1: const NS = require('<tracked>')
    const nsRe = /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    let m
    const namespaces = []
    while ((m = nsRe.exec(text)) !== null) {
      if (!isTracked(m[2])) continue
      namespaces.push({ moduleName: m[2], local: m[1] })
    }
    for (const { moduleName, local } of namespaces) {
      const use = new RegExp(`\\b${local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g')
      let u
      while ((u = use.exec(text)) !== null) note(moduleName, u[1])
      // bare use of the namespace itself (e.g. spread) is not a member access
    }

    // form 2: const { A, B: c } = require('<tracked>')
    const dtRe = /(?:var|let|const)\s*\{([^}]{1,2000})\}\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    while ((m = dtRe.exec(text)) !== null) {
      if (!isTracked(m[2])) continue
      for (const part of m[1].split(',')) {
        const name = part.split(':')[0].trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) note(m[2], name)
      }
    }
  }
  return refs
}

/**
 * Installed plugin directories.
 * Junction/symlink aware: `withFileTypes().isDirectory()` is false for links,
 * which silently skipped every link-installed plugin in an earlier attempt.
 */
export function listInstalled (roots) {
  const out = []
  const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }

  for (const root of roots) {
    if (!existsSync(root)) continue
    let entries
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const p = join(root, e.name)
      if (!isDir(p)) continue
      if (e.name.startsWith('@')) {
        let subs = []
        try { subs = readdirSync(p, { withFileTypes: true }) } catch { continue }
        for (const s of subs) {
          const sp = join(p, s.name)
          if (isDir(sp)) out.push({ name: `${e.name}/${s.name}`, dir: sp })
        }
      } else {
        out.push({ name: e.name, dir: p })
      }
    }
  }
  // de-duplicate by name, first root wins
  const seen = new Map()
  for (const item of out) if (!seen.has(item.name)) seen.set(item.name, item)
  return [...seen.values()]
}

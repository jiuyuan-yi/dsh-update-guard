/**
 * Host-side service surface.
 *
 * The client-API check only sees plugins that ship a browser half. Most plugins
 * do not: they are host plugins that declare `inject: ['webServer', ...]` and
 * `ctx.get('slots')`. If a version stops providing one of those services, the
 * plugin fails to activate and — because a required plugin that never activates
 * aborts boot — the app does not start at all.
 *
 * That failure mode is invisible to a client-API diff, so it gets its own scan.
 *
 * Two sources of service names, because the framework does not use one form:
 *   super(ctx, "name")     service classes
 *   ctx.provide("name")    provided at runtime
 *   ctx.set("name", ...)   assigned onto the context
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openAsar } from './asar.mjs'

const PATTERNS = [
  /super\(\s*\w+\s*,\s*["'`]([A-Za-z][\w.]*)["'`]/g,
  /\.provide\(\s*["'`]([A-Za-z][\w.]*)["'`]/g,
  /\.set\(\s*["'`]([A-Za-z][\w.]*)["'`]/g,
  /\bregisterService\(\s*["'`]([A-Za-z][\w.]*)["'`]/g,
  /\bdefineService\(\s*["'`]([A-Za-z][\w.]*)["'`]/g,
  /\bserviceName\s*[:=]\s*["'`]([A-Za-z][\w.]*)["'`]/g,
  /\bstatic\s+service\s*=\s*["'`]([A-Za-z][\w.]*)["'`]/g,
]

/** Framework built-ins that never appear as a `super(ctx, ...)` name. */
const FRAMEWORK = ['loader', 'cordis', 'logger', 'reflect', 'registry', 'system', 'events']

function collect (text, into) {
  for (const re of PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) into.add(m[1])
  }
}

/**
 * Every identifier-shaped string literal in the runtime.
 *
 * Used as a second, deliberately loose signal: a service can be provided by a
 * form this scanner does not model (a variable name, a computed key, a table of
 * implementations). If a requested name appears anywhere in the shipped runtime
 * as a literal, it is not reported as missing. Missing a genuine removal costs
 * a warning; a false "this will break" costs trust, and these findings are
 * advisory anyway.
 */
function collectMentioned (text, into) {
  const re = /["'`]([A-Za-z][A-Za-z0-9_.]{1,40})["'`]/g
  let m
  while ((m = re.exec(text)) !== null) into.add(m[1])
}

/**
 * Every host service name an app.asar provides.
 * Only files under `dsh/node_modules/@deepseek-ai/` are scanned: third-party
 * code is not the runtime's contract.
 * @returns {{declared: string[], mentioned: string[]}}
 */
export function servicesFromAsar (asarPath) {
  const declared = new Set(FRAMEWORK)
  const mentioned = new Set()
  let asar
  try { asar = openAsar(asarPath) } catch { return { declared: [...declared].sort(), mentioned: [] } }

  const paths = []
  ;(function walk (node, parts) {
    if (!node) return
    if (node.files) {
      for (const [name, child] of Object.entries(node.files)) walk(child, [...parts, name])
      return
    }
    if (node.size === undefined) return
    paths.push(parts.join('/'))
  })(asar.directory, [])

  const re = /^dsh\/node_modules\/@deepseek-ai\/[^/]+\/lib\/.*\.js$/
  for (const p of paths) {
    if (!re.test(p)) continue
    const hit = asar.find(new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'))
    if (hit === undefined || hit.size > 3_000_000) continue
    const text = hit.buffer.toString('utf8')
    collect(text, declared)
    collectMentioned(text, mentioned)
  }
  return { declared: [...declared].sort(), mentioned: [...mentioned].sort() }
}

/**
 * Same list, from a plugin directory tree (used to learn what third-party
 * plugins provide, so their own services are not reported as unknown).
 */
export function servicesFromDir (dir) {
  return collectFromDir(dir).names
}

/** Concatenated source of a plugin's runtime files. */
export function readPluginText (dir) {
  return collectFromDir(dir).text
}

/** Directories that never contain host runtime code. */
const NON_RUNTIME = [
  'node_modules', 'test', 'tests', '__tests__', 'docs', 'doc',
  '.cache', 'scripts', 'tools', 'examples', 'fixtures', 'bench',
]

function collectFromDir (dir) {
  const names = new Set()
  const files = []
  ;(function walk (d, depth) {
    if (depth > 4) return
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (NON_RUNTIME.includes(e.name)) continue
      const p = join(d, e.name)
      if (e.isDirectory()) { walk(p, depth + 1); continue }
      if (!/\.(js|mjs|cjs)$/.test(e.name)) continue
      // The browser half declares client-side services, not host ones: scanning
      // it here reports names the host never provides, which is a pure false
      // positive. (A plugin's client half is what `referencesOf` handles.)
      if (/^client\.[cm]?js$/i.test(e.name)) continue
      files.push(p)
    }
  })(dir, 0)
  let text = ''
  for (const f of files) {
    try {
      const t = readFileSync(f, 'utf8')
      text += t + '\n'
      collect(t, names)
    } catch { /* unreadable */ }
  }
  return { names, text }
}

/**
 * What a plugin requires vs probes.
 *
 * `hard` is `inject: [...]` / `ctx.inject([...])`: activation blocks until those
 * services exist, and a required plugin that never activates aborts boot.
 * `soft` is `ctx.get('x')`: usually guarded, so absence is only a warning.
 */
export function serviceUsageOf (text) {
  const hard = new Set()
  const soft = new Set()

  // Two spellings, and the ESM one is the common case in current plugins:
  //   export const inject = ['webServer']      (declaration)
  //   ctx.inject(['webServer'], cb)            (call)
  //   { inject: ['webServer'] }                (object literal)
  const arrayForms = [
    /\binject\s*=\s*\[([^\]]{0,400})\]/g,
    /\binject\s*:\s*\[([^\]]{0,400})\]/g,
    /ctx\.inject\(\s*\[([^\]]{0,400})\]/g,
  ]
  for (const re of arrayForms) {
    for (const m of text.matchAll(re)) {
      for (const s of m[1].matchAll(/["'`]([A-Za-z][\w.]*)["'`]/g)) hard.add(s[1])
    }
  }
  for (const m of text.matchAll(/ctx\.get\(\s*["'`]([A-Za-z][\w.]*)["'`]/g)) soft.add(m[1])

  for (const h of hard) soft.delete(h)
  return { hard: [...hard], soft: [...soft] }
}

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

/**
 * Forms that unambiguously declare a service.
 *
 * `.set("x", ...)` and `serviceName: "x"` are deliberately excluded here even
 * though the name inventory keeps them: on a real archive they match ordinary
 * `Map.set('active', ...)` data keys, and attributing every method in that file
 * to a pseudo-service named `active` (823 entries in one measurement) is noise
 * that makes the method tier meaningless.
 */
const STRONG_PATTERNS = [
  /super\(\s*\w+\s*,\s*["'`]([A-Za-z][\w.]*)["'`]/g,
  /\.provide\(\s*["'`]([A-Za-z][\w.]*)["'`]/g,
  /\bregisterService\(\s*["'`]([A-Za-z][\w.]*)["'`]/g,
  /\bdefineService\(\s*["'`]([A-Za-z][\w.]*)["'`]/g,
  /\bstatic\s+service\s*=\s*["'`]([A-Za-z][\w.]*)["'`]/g,
]

function collect (text, into) {
  for (const re of PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) into.add(m[1])
  }
}

function collectStrong (text, into) {
  for (const re of STRONG_PATTERNS) {
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
 * @returns {{declared: string[], mentioned: string[], methods: Record<string, string[]>, filesScanned: number}}
 */
export function servicesFromAsar (asarPath) {
  const declared = new Set(FRAMEWORK)
  const mentioned = new Set()
  const methods = new Map()
  let filesScanned = 0
  let asar
  try { asar = openAsar(asarPath) } catch { return { declared: [...declared].sort(), mentioned: [], methods: {}, filesScanned: 0 } }

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
    filesScanned += 1
    collect(text, declared)
    collectMentioned(text, mentioned)
    // Methods are recorded per file and attributed to the services that file
    // declares. That co-occurrence is what keeps `ctx.webServer.register` from
    // matching an unrelated `register` in another package.
    const local = serviceMethodsInText(text)
    for (const svc of local.services) {
      const bucket = methods.get(svc) ?? new Set()
      for (const m of local.methods) bucket.add(m)
      methods.set(svc, bucket)
    }
  }

  const methodMap = {}
  for (const [svc, set] of [...methods.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    methodMap[svc] = [...set].sort()
  }
  return { declared: [...declared].sort(), mentioned: [...mentioned].sort(), methods: methodMap, filesScanned }
}

/**
 * Method-shaped names declared in one source file, plus the services that file
 * declares.
 *
 * Deliberately shallow: class methods, object-literal methods, static methods,
 * async/get/set forms and function-valued properties. It does not build a class
 * graph, resolve inheritance or follow mixins — a method that comes from a base
 * class will be missing from this set. That is why a miss is reported as
 * advisory evidence, never as "this will break".
 */
export function serviceMethodsInText (text) {
  const services = new Set()
  collectStrong(text, services)

  const methods = new Set()
  const RESERVED = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with',
    'do', 'else', 'new', 'typeof', 'delete', 'void', 'yield', 'await',
    'constructor',
  ])

  // Method definitions: `name(args) {`, with an optional static/async/get/set
  // prefix and a bounded indentation so a nested callback in the middle of a
  // function body does not register as a member.
  const defRe = /^[ \t]{1,12}(?:static\s+)?(?:async\s+)?(?:(get|set)\s+)?([A-Za-z_$][\w$]*)\s*\([^)]{0,200}\)\s*\{/gm
  for (const m of text.matchAll(defRe)) {
    const name = m[2]
    if (RESERVED.has(name)) continue
    if (name.startsWith('#')) continue
    methods.add(name)
  }

  // Function-valued properties: `name = (args) =>`, `name: async function`.
  const propRe = /^[ \t]{1,12}(?:static\s+)?([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:\([^)]{0,200}\)\s*=>|function\b|\([^)]{0,200}\)\s*\{)/gm
  for (const m of text.matchAll(propRe)) {
    const name = m[1]
    if (RESERVED.has(name) || name.startsWith('#')) continue
    methods.add(name)
  }

  return { services: [...services].sort(), methods: [...methods].sort() }
}

/**
 * Service methods a plugin actually calls.
 *
 * Only calls on a service the profile knows about are returned; `ctx.logger.warn`
 * and friends are framework built-ins whose shape this scanner does not model.
 * Three call forms are recognised:
 *
 *   ctx.webServer.register(...)              direct
 *   ctx.get('slots').register(...)           looked up
 *   const s = ctx.get('slots'); s.register() aliased lookup
 *
 * A **property read is not a call**: `ctx.workingDirectory.defaultDirectory` can
 * be a getter or a plain field, and "not in the method set" says nothing about
 * whether that still works. Requiring the call parenthesis is what keeps this
 * tier from flagging every field access as a removed method.
 *
 * @param {string} text
 * @param {Iterable<string>} knownServices
 * @returns {{service: string, method: string, via: string}[]}
 */
export function serviceMethodUsageOf (text, knownServices = []) {
  const known = new Set(knownServices)
  const out = new Map()
  const note = (service, method, via) => {
    if (!known.has(service)) return
    if (!/^[A-Za-z_$][\w$]*$/.test(method)) return
    const key = service + '.' + method
    if (!out.has(key)) out.set(key, { service, method, via })
  }

  // Direct: ctx.svc.method(...) or ctx.svc?.method(...)
  for (const m of text.matchAll(/\bctx\s*\.\s*([A-Za-z_$][\w$]*)\s*\??\.\s*([A-Za-z_$][\w$]*)\s*(?:\?\.)?\s*\(/g)) {
    note(m[1], m[2], 'direct')
  }
  // Looked up: ctx.get('svc').method(...)
  for (const m of text.matchAll(/\bctx\s*\.\s*get\(\s*["'`]([A-Za-z][\w.]*)["'`]\s*\)\s*\??\.\s*([A-Za-z_$][\w$]*)\s*(?:\?\.)?\s*\(/g)) {
    note(m[1], m[2], 'get')
  }

  // Aliased lookup: `const slots = ctx.get('slots')` then `slots.register(...)`.
  // Bounded to the same file, and only for a name bound exactly once — a name
  // reassigned elsewhere in the file would make this a guess.
  const bindRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*ctx\s*\.\s*get\(\s*["'`]([A-Za-z][\w.]*)["'`]\s*\)/g
  for (const m of text.matchAll(bindRe)) {
    const local = m[1]
    const service = m[2]
    if (!known.has(service)) continue
    const reAssign = new RegExp(`\\b${escape(local)}\\s*=(?!=)`, 'g')
    if ([...text.matchAll(reAssign)].length > 1) continue
    const use = new RegExp(`\\b${escape(local)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*(?:\\?\\.)?\\s*\\(`, 'g')
    for (const u of text.matchAll(use)) note(service, u[1], 'alias')
  }

  return [...out.values()]
}

function escape (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Service method calls that the target runtime has no evidence for.
 *
 * Kept as a separate pure function so the rule is testable without building an
 * archive: `run.mjs` decides *whether* to report, this decides *what* is
 * unsupported.
 *
 * A method is only "unknown" when its service has a non-empty extracted method
 * set. An empty set means extraction found nothing, and reporting against it
 * would flag every service whose shape the scanner cannot read.
 *
 * @param {{service: string, method: string, via?: string}[]} uses
 * @param {Record<string, string[]>} serviceMethods
 * @param {string[]} mentioned - literals seen anywhere in the runtime
 * @param {number} limit
 */
export function unknownServiceMethods (uses, serviceMethods, mentioned = [], limit = 20) {
  const fallback = new Set(mentioned)
  const out = []
  for (const u of uses) {
    const list = serviceMethods?.[u.service]
    if (!Array.isArray(list) || list.length === 0) continue
    if (list.includes(u.method)) continue
    if (fallback.has(u.method)) continue
    if (out.length >= limit) break
    out.push(u)
  }
  return out
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
 *
 * A name in BOTH stays hard. The inject gates activation, so if the service is
 * absent the `ctx.get` line is never reached — the guarded read only proves the
 * author handles a *late* provider, not a missing one. Treating it as soft would
 * under-report a plugin that genuinely cannot activate.
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

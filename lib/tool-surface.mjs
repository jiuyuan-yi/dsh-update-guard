/**
 * Tier-2b: the model-visible tool surface.
 *
 * Tool names, descriptions and parameter schemas are a published contract in
 * exactly one sense: every plugin and every saved prompt that names a tool or
 * passes an argument depends on them. Renaming a tool, or making a formerly
 * optional parameter required, breaks those callers without touching a single
 * line of the tool's own implementation.
 *
 * The host ships these definitions as ordinary readable source
 * (`ctx.tools.register(defineTool({ name: "read", ... }))`), not minified, so a
 * text pass is enough. We record the name, the parameter names, and which of
 * them are optional — three things a caller can actually break on.
 */
import { openAsar } from './asar.mjs'

/** Matches every built-in tool module inside the archive. */
const TOOL_MODULE_RE = /^dsh\/node_modules\/@deepseek-ai\/dsh-tool-[^/]+\/lib\/index\.js$/

/**
 * Pull every `defineTool({ ... })` object out of one module's source.
 * Returns raw { name, params } where params is whatever `parseParams` finds.
 */
export function toolsInModule (text) {
  const out = []
  const marker = 'defineTool('
  let from = 0
  while (true) {
    const at = text.indexOf(marker, from)
    if (at === -1) break
    from = at + marker.length

    // Take a bounded window; a tool definition is never longer than this in the
    // shipped sources, and an unbounded scan would let two adjacent tools merge.
    const window = text.slice(at, at + 4000)
    // The object literal starts at the first `{` after the call paren.
    const brace = window.indexOf('{')
    if (brace === -1) continue

    const name = firstString(window, /\bname:\s*["'`]([^"'`]+)["'`]/)
    if (!name) continue

    const params = parseParams(window)
    const description = firstString(window, /\bdescription:\s*["'`]([^"'`]{0,120})/)
    out.push({ name, description: description ?? '', params })
  }
  return out
}

function firstString (text, re) {
  const m = re.exec(text)
  return m ? m[1] : undefined
}

/** Slice the balanced `{...}` starting at `start`, or a bounded fallback. */
function objectAt (text, start) {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return text.slice(start, Math.min(text.length, start + 240))
}

/**
 * Parameter names and optionality from a tool's `parameters` block.
 *
 * The shipped sources express schemas several ways (a zod schema, a plain
 * descriptor object, a builder call). Rather than model every form, take the
 * set of `key:` names that appear inside the parameters region and the
 * `optional` markers next to them. That is enough to detect the two breakages
 * that matter: a parameter that disappeared, and one that lost `optional`.
 */
export function parseParams (window) {
  const start = window.indexOf('parameters')
  if (start === -1) return { names: [], optional: [] }
  // The parameters block ends where the definition moves on to `output` — the
  // return shape lives right after it and its field names are not parameters.
  const outAt = window.indexOf('output', start)
  const end = outAt === -1 ? start + 1800 : Math.min(outAt, start + 1800)
  const region = window.slice(start, end)

  // Structural keys, not parameters: `type`/`description` describe a field, and
  // `parameters` is the block's own name.
  const structural = new Set(['type', 'description', 'items', 'properties', 'required', 'parameters', 'schema'])

  const names = []
  const optional = []
  const entryRe = /["']?([A-Za-z_$][\w$]*)["']?\s*:\s*\{/g
  let m
  while ((m = entryRe.exec(region)) !== null) {
    const key = m[1]
    if (structural.has(key)) continue
    if (!names.includes(key)) names.push(key)
    // Only this parameter's own object may decide its optionality. A fixed
    // character window used to reach the next sibling's `optional: true` and
    // mark the previous, genuinely required parameter as optional.
    const braceAt = region.indexOf('{', m.index)
    const own = braceAt === -1 ? '' : objectAt(region, braceAt)
    if (/\boptional\b|\?\s*:/.test(own) && !optional.includes(key)) {
      optional.push(key)
    }
  }
  return { names, optional }
}

/**
 * Read the whole tool surface out of an archive.
 *
 * @param {string} asarPath
 * @returns {{name: string, description: string, params: {names: string[], optional: string[]}, module: string}[]}
 */
export function readToolSurface (asarPath) {
  const asar = openAsar(asarPath)
  const entries = asar.findAll(TOOL_MODULE_RE)
  const tools = []
  for (const entry of entries) {
    const text = entry.buffer.toString('utf8')
    const module = entry.path.split('/')[3] ?? 'unknown'
    for (const tool of toolsInModule(text)) {
      tools.push({ ...tool, module })
    }
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Compare two tool surfaces.
 *
 * Reported in the order a caller would care: a tool that vanished is fatal, a
 * parameter that vanished is fatal for that call, a parameter that stopped
 * being optional is fatal only when the caller omits it.
 */
export function diffToolSurface (before, after) {
  const beforeByName = new Map(before.map(t => [t.name, t]))
  const afterByName = new Map(after.map(t => [t.name, t]))

  const removed = []
  const added = []
  const changed = []

  for (const [name, t] of beforeByName) {
    const next = afterByName.get(name)
    if (!next) { removed.push(name); continue }
    const lostParams = t.params.names.filter(p => !next.params.names.includes(p))
    const newlyRequired = t.params.optional.filter(p => next.params.names.includes(p) && !next.params.optional.includes(p))
    const descriptionChanged = t.description !== next.description
    if (lostParams.length || newlyRequired.length || descriptionChanged) {
      changed.push({ name, lostParams, newlyRequired, descriptionChanged, from: t.description, to: next.description })
    }
  }
  for (const name of afterByName.keys()) {
    if (!beforeByName.has(name)) added.push(name)
  }

  const breaking = removed.length > 0 || changed.some(c => c.lostParams.length || c.newlyRequired.length)
  return { removed, added, changed, breaking }
}

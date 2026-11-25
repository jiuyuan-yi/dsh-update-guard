/**
 * Interface-surface snapshots.
 *
 * The regression suite needs two versions of DSH to answer "did this change
 * break a plugin". Keeping every old `app.asar` on disk costs ~200 MB per
 * version and rots: the archives get deleted, the tests go quiet, and the next
 * real upgrade is again a one-sample experiment.
 *
 * A snapshot is the part that actually got compared — module members, service
 * names and methods, tool signatures — as a few tens of kilobytes of JSON. It
 * is enough to reproduce a comparison without the archive, and small enough to
 * commit.
 *
 * What it is not: the runtime. A snapshot cannot answer behavioural questions,
 * and a diff against it is only as good as the extractor that produced it.
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

import { openAsar } from './asar.mjs'
import { surfaceOf } from './surface.mjs'
import { servicesFromAsar } from './services.mjs'
import { readToolSurface, diffToolSurface } from './tool-surface.mjs'

export const SNAPSHOT_SCHEMA = 1

const SHELL_BUNDLE = /dsh-web-frontend\/dist\/assets\/index-[^/]+\.js$/
const RUNTIME_MANIFEST = /^dsh\/package\.json$/

/** Version + identity from the archive itself. Never guessed from a path. */
function runtimeIdentity (asarPath) {
  const asar = openAsar(asarPath)
  const hit = asar.find(RUNTIME_MANIFEST)
  if (hit === undefined) return { name: null, version: null }
  try {
    const j = JSON.parse(hit.buffer.toString('utf8'))
    return { name: typeof j.name === 'string' ? j.name : null, version: typeof j.version === 'string' ? j.version : null }
  } catch {
    return { name: null, version: null }
  }
}

/**
 * Build one snapshot from an archive.
 *
 * @param {string} asarPath
 * @param {{version?: string, guardVersion?: string}} [opts]
 */
export function buildSnapshot (asarPath, opts = {}) {
  const asar = openAsar(asarPath)
  const id = runtimeIdentity(asarPath)

  const shell = asar.find(SHELL_BUNDLE)
  if (shell === undefined) throw new Error('shell bundle not found inside the archive')

  const text = shell.buffer.toString('utf8')
  const surface = surfaceOf(text)
  const services = servicesFromAsar(asarPath)
  const tools = readToolSurface(asarPath)

  const modules = {}
  for (const [name, info] of Object.entries(surface.modules)) {
    modules[name] = { members: [...info.members].sort(), confidence: info.confidence }
  }

  return {
    schemaVersion: SNAPSHOT_SCHEMA,
    guardVersion: opts.guardVersion ?? null,
    createdAt: new Date().toISOString(),
    dsh: {
      name: id.name,
      version: opts.version ?? id.version ?? 'unknown',
      asarSha256: createHash('sha256').update(readFileSync(asarPath)).digest('hex'),
      asarBytes: asar.byteLength,
      shellEntry: shell.path,
      shellSha256: createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'),
    },
    surface: { modules, tableSize: surface.tableSize ?? null },
    services: {
      declared: services.declared,
      // The literal inventory is ~34k entries and only serves as a bail-out
      // during a live check. A snapshot is for diffing, where it is never read,
      // so storing it would triple the file size for nothing.
      mentionedCount: Array.isArray(services.mentioned) ? services.mentioned.length : 0,
      methods: services.methods ?? {},
    },
    tools,
    counts: {
      modules: Object.keys(modules).length,
      members: Object.values(modules).reduce((n, m) => n + m.members.length, 0),
      services: services.declared.length,
      servicesWithMethods: Object.keys(services.methods ?? {}).length,
      methods: Object.values(services.methods ?? {}).reduce((n, l) => n + l.length, 0),
      tools: tools.length,
    },
  }
}

/** `dsh-<version>.json`, with characters a filename cannot carry replaced. */
export function snapshotFileName (snapshot) {
  const version = String(snapshot?.dsh?.version ?? 'unknown').replace(/[^\w.+-]/g, '_')
  return `dsh-${version}.json`
}

/**
 * What the newer snapshot no longer offers.
 *
 * `breaking` is deliberately narrow: a member a client plugin can no longer
 * import, a service that vanished, or a tool/parameter the model can no longer
 * call. Additions and pure description edits never set it.
 */
export function diffSnapshots (before, after) {
  const modules = []
  const moduleNames = new Set([
    ...Object.keys(before?.surface?.modules ?? {}),
    ...Object.keys(after?.surface?.modules ?? {}),
  ])
  for (const name of [...moduleNames].sort()) {
    const b = new Set(before?.surface?.modules?.[name]?.members ?? [])
    const a = new Set(after?.surface?.modules?.[name]?.members ?? [])
    const removed = [...b].filter(x => !a.has(x))
    const added = [...a].filter(x => !b.has(x))
    if (removed.length > 0 || added.length > 0) modules.push({ module: name, removed, added })
  }

  const beforeSvc = new Set(before?.services?.declared ?? [])
  const afterSvc = new Set(after?.services?.declared ?? [])
  const services = {
    removed: [...beforeSvc].filter(s => !afterSvc.has(s)),
    added: [...afterSvc].filter(s => !beforeSvc.has(s)),
    methods: [],
  }
  const beforeMethods = before?.services?.methods ?? {}
  const afterMethods = after?.services?.methods ?? {}
  for (const svc of [...new Set([...Object.keys(beforeMethods), ...Object.keys(afterMethods)])].sort()) {
    const b = new Set(beforeMethods[svc] ?? [])
    const a = new Set(afterMethods[svc] ?? [])
    const removed = [...b].filter(x => !a.has(x))
    const added = [...a].filter(x => !b.has(x))
    if (removed.length > 0 || added.length > 0) services.methods.push({ service: svc, removed, added })
  }

  const tools = diffToolSurface(before?.tools ?? [], after?.tools ?? [])

  const breaking = modules.some(m => m.removed.length > 0) ||
    services.removed.length > 0 ||
    services.methods.some(m => m.removed.length > 0) ||
    tools.breaking

  return { modules, services, tools, breaking }
}

/** A snapshot loaded from disk, with the version taken from either file name or body. */
export function readSnapshot (path) {
  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  const snap = JSON.parse(raw)
  if (snap?.schemaVersion !== SNAPSHOT_SCHEMA) {
    throw new Error(`unsupported snapshot schema: ${snap?.schemaVersion ?? 'none'}`)
  }
  return snap
}

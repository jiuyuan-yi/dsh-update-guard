/**
 * Tier-1 compatibility: the version ranges a plugin declares.
 *
 * This is the same test the loader performs before it mounts a bundle
 * (`engines.dsh`, else `peerDependencies["@deepseek-ai/dsh"]`), so it is
 * authoritative for "will the loader even try", and it needs no archive tool.
 *
 * Tier-2 (comparing the client API surface) catches what a declared range
 * cannot: a plugin whose range still matches but which calls a member the new
 * version removed. Tier-1 is the cheap half that always works.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { satisfies } from './version.mjs'

const DSH_PEER = '@deepseek-ai/dsh'

/** Read `engines.dsh` or the peer range a manifest declares. */
export function declaredRange (manifest) {
  const engines = manifest?.engines
  if (engines && typeof engines === 'object' && typeof engines.dsh === 'string') {
    return { field: 'engines.dsh', range: engines.dsh }
  }
  const peer = manifest?.peerDependencies
  if (peer && typeof peer === 'object' && typeof peer[DSH_PEER] === 'string') {
    return { field: 'peerDependencies', range: peer[DSH_PEER] }
  }
  return undefined
}

/**
 * Check every installed plugin's declared range against a target version.
 * @param {string} profileDir
 * @param {string} targetVersion
 * @returns {{checked: number, findings: object[], undeclared: string[]}}
 */
export function checkDeclaredRanges (profileDir, targetVersion) {
  const pkgPath = join(profileDir, 'package.json')
  let bundles = []
  try {
    const m = JSON.parse(readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''))
    bundles = Array.isArray(m?.dsh?.profile?.bundles) ? m.dsh.profile.bundles : []
  } catch { /* no profile: nothing to check */ }

  const findings = []
  const undeclared = []
  let checked = 0

  for (const name of bundles) {
    if (name.startsWith('@deepseek-ai/')) continue
    const dir = join(profileDir, 'node_modules', ...name.split('/'))
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    let manifest
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')) } catch { continue }

    const declared = declaredRange(manifest)
    if (declared === undefined) {
      undeclared.push(name)
      continue
    }
    checked++
    const ok = satisfies(targetVersion, declared.range)
    if (ok === undefined) {
      // Range form we do not model. Report as unknown rather than pass/fail.
      findings.push({
        plugin: name,
        kind: 'unknown-range',
        field: declared.field,
        range: declared.range,
        detail: '版本范围写法未识别',
      })
      continue
    }
    if (ok === false) {
      findings.push({
        plugin: name,
        kind: 'range-mismatch',
        field: declared.field,
        range: declared.range,
        detail: `声明支持 ${declared.range}，实际要装 ${targetVersion}`,
      })
    }
  }

  return { checked, findings, undeclared }
}

/** Installed plugin directories, for callers that need the list too. */
export function thirdPartyBundles (profileDir) {
  let bundles = []
  try {
    const m = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
    bundles = Array.isArray(m?.dsh?.profile?.bundles) ? m.dsh.profile.bundles : []
  } catch { return [] }
  return bundles.filter(n => !n.startsWith('@deepseek-ai/'))
}

/** Whether a directory looks like a mounted plugin. */
export function isMounted (dir) {
  try { return statSync(dir).isDirectory() } catch { return false }
}

/** Safe resolution of npm package names and package-relative files inside a profile. */
import { isAbsolute, resolve, sep, win32 } from 'node:path'

const SEGMENT = /^[a-z0-9][a-z0-9._~-]*$/i

/**
 * Resolve a package name beneath `<profile>/node_modules`.
 * Only normal npm package shapes are accepted: `name` or `@scope/name`.
 * This prevents malformed profile entries from escaping the package root.
 */
export function resolvePackageDir (profileDir, packageName) {
  if (typeof packageName !== 'string' || packageName.length === 0) return undefined
  if (packageName.includes('\\') || packageName.includes('\0')) return undefined

  const parts = packageName.split('/')
  if (parts.length === 1) {
    if (!SEGMENT.test(parts[0]) || parts[0] === '.' || parts[0] === '..') return undefined
  } else if (parts.length === 2) {
    if (!/^@[a-z0-9][a-z0-9._~-]*$/i.test(parts[0]) ||
        !SEGMENT.test(parts[1]) || parts[1] === '.' || parts[1] === '..') return undefined
  } else {
    return undefined
  }

  const root = resolve(profileDir, 'node_modules')
  const target = resolve(root, ...parts)
  if (!target.startsWith(root + sep)) return undefined
  return target
}

/**
 * Resolve a relative file declared by a package without permitting traversal,
 * absolute paths, drive-relative paths, or UNC paths.
 */
export function resolvePackageFile (packageDir, relativeFile) {
  if (typeof relativeFile !== 'string' || relativeFile.length === 0) return undefined
  if (relativeFile.includes('\0') || isAbsolute(relativeFile) || win32.isAbsolute(relativeFile)) return undefined

  const normalized = relativeFile.replace(/[\\/]+/g, sep)
  const parts = normalized.split(sep)
  if (parts.some(part => part === '..')) return undefined

  const root = resolve(packageDir)
  const target = resolve(root, normalized)
  if (target !== root && !target.startsWith(root + sep)) return undefined
  return target
}

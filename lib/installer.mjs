/**
 * Read the surface of a DOWNLOADED (not yet installed) DSH update.
 *
 * electron-updater keeps the prepared installer in a cache directory whose name
 * comes from `app-update.yml` (`updaterCacheDirName`). While the app is still
 * running and the user has not clicked "install and restart", that installer is
 * the only place the next version's code exists. We open it read-only.
 *
 * Installer layout (NSIS): the payload is `$PLUGINSDIR\app-64.7z`, and the
 * shell bundle lives inside at
 *   dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-<hash>.js
 *
 * Nothing here executes installer code.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { asarText } from './asar.mjs'
import { servicesFromAsar } from './services.mjs'

/**
 * Find an archive tool that can read the NSIS payload.
 *
 * NSIS is the one layer Windows cannot open by itself: the bundled `tar.exe`
 * (libarchive) reads the inner `app-*.7z` happily but reports "Unrecognized
 * archive format" on the installer. So this probe decides whether the deep
 * (surface) check is possible at all; when it fails the guard falls back to the
 * declared-range check instead of failing the whole run.
 *
 * @returns {{path: string, source: string}|undefined}
 */
export function detectExtractor () {
  // Kill switch: forces the declared-range tier, for testing and for users who
  // would rather not have the guard open archives at all.
  if (process.env.DSH_UPDATE_GUARD_NO_EXTRACTOR === '1') return undefined

  const tryPath = (candidate, source) => {
    if (!candidate) return undefined
    try { if (statSync(candidate).isFile()) return { path: candidate, source } } catch { /* ignore */ }
    return undefined
  }

  // 1. Explicit override wins: it is the escape hatch for unusual installs.
  for (const envName of ['DSH_7Z', 'DSH_7ZA']) {
    const hit = tryPath(process.env[envName], 'env:' + envName)
    if (hit) return hit
  }

  // 2. Packaged copy, if this package ever ships one.
  const bundled = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', '7z.exe')
  const bundledHit = tryPath(bundled, 'bundled')
  if (bundledHit) return bundledHit

  // 3. PATH.
  for (const exe of ['7z', '7za', '7zz']) {
    try {
      const out = execFileSync('where', [exe], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      const first = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0]
      const hit = tryPath(first, 'path:' + exe)
      if (hit) return hit
    } catch { /* not on PATH */ }
  }

  // 4. Registry, which is where the real 7-Zip installer records its location.
  for (const key of ['HKLM\\SOFTWARE\\7-Zip', 'HKLM\\SOFTWARE\\WOW6432Node\\7-Zip']) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      const m = /Path\s+REG_\w+\s+(.+)$/m.exec(out)
      if (m) {
        const dir = m[1].trim()
        for (const exe of ['7z.exe', '7za.exe']) {
          const hit = tryPath(join(dir, exe), 'registry:' + key)
          if (hit) return hit
        }
      }
    } catch { /* key absent */ }
  }

  // 5. Common install locations, including forks that ship a compatible binary.
  const roots = [
    process.env.ProgramFiles ?? 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs') : undefined,
    'D:\\7-Zip',
    'C:\\7-Zip',
  ].filter(Boolean)
  const rels = [
    '7-Zip\\7z.exe',
    '7-Zip\\7za.exe',
    'NanaZip\\NanaZip.exe',
    'NanaZip\\7z.exe',
  ]
  for (const root of roots) {
    for (const rel of rels) {
      const hit = tryPath(join(root, rel), 'common')
      if (hit) return hit
    }
  }

  return undefined
}

/** Back-compat shim: the path only. */
export function find7z () {
  return detectExtractor()?.path
}

/**
 * Ask Windows where the app was installed.
 *
 * The installer writes an uninstall entry with `InstallLocation`, which is the
 * only authoritative answer — and it works for custom install directories,
 * which a hardcoded path list never can.
 * @returns {string|undefined}
 */
export function findInstallRootFromRegistry () {
  const script = "Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.DisplayName -like '*DeepSeek Harness*' -and $_.InstallLocation } | " +
    "Select-Object -First 1 -ExpandProperty InstallLocation"
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    }).trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0]
    if (out && existsSync(join(out, 'resources', 'app-update.yml'))) return out
  } catch { /* no registry entry, or powershell unavailable */ }
  return undefined
}

/** Resolve the desktop install root from the running/shipped app. */
export function findInstallRoot () {
  const env = process.env.DSH_DESKTOP_ROOT
  if (env && existsSync(join(env, 'resources', 'app-update.yml'))) return env

  // Best source: the executable that is running right now. Independent of where
  // the user installed, and of any configuration.
  for (const candidate of [process.execPath, process.env.PORTABLE_EXECUTABLE_FILE]) {
    if (!candidate) continue
    try {
      const dir = dirname(candidate)
      if (existsSync(join(dir, 'resources', 'app-update.yml'))) return dir
    } catch { /* ignore */ }
  }

  // The CLI does not run inside the app, so ask the OS where it lives.
  const fromRegistry = findInstallRootFromRegistry()
  if (fromRegistry !== undefined) return fromRegistry

  // Last resort: the conventional per-machine and per-user locations.
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const candidates = [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'DeepSeek Harness'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'DeepSeek Harness'),
    join(localAppData, 'Programs', 'DeepSeek Harness'),
  ]
  for (const c of candidates) {
    if (c && existsSync(join(c, 'resources', 'app-update.yml'))) return c
  }
  return undefined
}

/** Read `updaterCacheDirName` so we do not hardcode one vendor's folder. */
export function updaterCacheDir (installRoot) {
  const yml = join(installRoot, 'resources', 'app-update.yml')
  if (!existsSync(yml)) return undefined
  const text = readFileSync(yml, 'utf8')
  const m = /^updaterCacheDirName:\s*(.+)$/m.exec(text)
  if (!m) return undefined
  return m[1].trim().replace(/^['"]|['"]$/g, '')
}

/**
 * Locate a downloaded-but-not-installed update.
 * @returns {{installer: string, version: string, cacheDir: string} | undefined}
 */
export function findPendingUpdate (installRoot) {
  const cacheName = updaterCacheDir(installRoot)
  if (!cacheName) return undefined
  const cacheDir = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), cacheName)
  const pending = join(cacheDir, 'pending')
  if (!existsSync(pending)) return undefined

  let version
  const info = join(pending, 'update-info.json')
  if (existsSync(info)) {
    try { version = JSON.parse(readFileSync(info, 'utf8')).version } catch { /* ignore */ }
  }

  const exes = readdirSync(pending).filter(f => f.toLowerCase().endsWith('.exe'))
  if (exes.length === 0) return undefined
  exes.sort((a, b) => statSync(join(pending, b)).mtimeMs - statSync(join(pending, a)).mtimeMs)
  const installer = join(pending, exes[0])
  if (version === undefined) version = versionFromFileName(exes[0])
  return { installer, version, cacheDir }
}

/**
 * Pull a semver out of an installer file name.
 * `deepseek-harness-0.2.1-rc.5-win-x64.exe` -> `0.2.1-rc.5`
 * update-info.json carries no version field, so the name is the only source.
 */
export function versionFromFileName (fileName) {
  const parts = String(fileName).replace(/\.exe$/i, '').split('-')
  const at = parts.findIndex(p => /^\d+\.\d+\.\d+$/.test(p))
  if (at === -1) return 'unknown'
  const out = [parts[at]]
  for (let i = at + 1; i < parts.length; i++) {
    if (/^(?:rc|alpha|beta|dev|pre)\.\d+$/i.test(parts[i])) out.push(parts[i])
    else break
  }
  return out.join('-')
}

function run7z (sevenZip, args, timeoutMs = 180000) {
  return execFileSync(sevenZip, args, {
    encoding: 'buffer',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
}

/** List entry names inside an archive. */
function listEntries (sevenZip, archive) {
  const out = run7z(sevenZip, ['l', '-ba', archive]).toString('utf8')
  return out.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
}

/**
 * Extract the shell bundle text from an installer.
 *
 * Two archive layers, then a plain read:
 *   installer.exe            (NSIS)
 *     $PLUGINSDIR\app-*.7z   (payload)
 *       resources\app.asar   (the Electron archive)
 *         dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js
 *
 * @returns {{text: string, entry: string, sha256: string}}
 */
export function readShellBundleFromInstaller (installer, opts = {}) {
  const sevenZip = opts.sevenZip ?? find7z()
  if (!sevenZip) throw new Error('7-Zip not found (set DSH_7Z to 7z.exe)')

  const work = opts.workDir ?? join(opts.cacheRoot, `extract-${process.pid}`)
  mkdirSync(work, { recursive: true })

  try {
    // Layer 1: the NSIS payload archive.
    const outer = listEntries(sevenZip, installer)
    const payloadLine = outer.find(l => /app-\d+\.7z$/i.test(l))
    if (!payloadLine) throw new Error('installer does not contain app-*.7z (unexpected layout)')
    const payloadName = payloadLine.split(/\s+/).pop()
    run7z(sevenZip, ['e', installer, payloadName, `-o${work}`, '-y'])

    const payloadPath = join(work, payloadName.split(/[\\/]/).pop())
    if (!existsSync(payloadPath)) throw new Error('payload extraction produced no file')

    // Layer 2: pull app.asar out of the payload.
    const inner = listEntries(sevenZip, payloadPath)
    const asarLine = inner.find(l => /resources[\\/]app\.asar$/i.test(l))
    if (!asarLine) throw new Error('app.asar not found inside payload')
    const asarEntry = asarLine.split(/\s+/).pop()
    run7z(sevenZip, ['e', payloadPath, asarEntry, `-o${work}`, '-y'])

    const asarPath = join(work, asarEntry.split(/[\\/]/).pop())
    if (!existsSync(asarPath)) throw new Error('app.asar extraction produced no file')

    // Layer 3: read the shell bundle straight out of the asar directory.
    const hit = asarText(asarPath, /dsh-web-frontend\/dist\/assets\/index-[^/]+\.js$/)
    if (hit === undefined) throw new Error('shell bundle not found inside app.asar')

    // Layer 4: the host service names live in the same asar, so this costs one
    // more pass over a file we already have on disk.
    let services = { declared: [], mentioned: [] }
    try { services = servicesFromAsar(asarPath) } catch { /* keep the surface usable */ }

    const buf = Buffer.from(hit.text, 'utf8')
    return {
      text: hit.text,
      entry: hit.path,
      sha256: createHash('sha256').update(buf).digest('hex'),
      services,
    }
  } finally {
    if (opts.keepTemp !== true) {
      try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
}

/** Cache key from installer identity without hashing 276 MB. */
export function cacheKeyOf (installer) {
  const st = statSync(installer)
  return createHash('sha256')
    .update(`${installer}|${st.size}|${st.mtimeMs}`)
    .digest('hex')
    .slice(0, 16)
}

/**
 * Surface for a pending update, from cache when the installer is unchanged.
 * @param {object} pending - result of findPendingUpdate
 * @param {{cacheRoot: string, sevenZip?: string, keepTemp?: boolean, force?: boolean}} opts
 * @param {(text: string) => object} buildSurface - parser for shell bundle text
 */
export function loadOrExtractSurface (pending, opts, buildSurface) {
  const cacheRoot = opts.cacheRoot
  mkdirSync(cacheRoot, { recursive: true })
  const key = cacheKeyOf(pending.installer)
  // Bump the suffix whenever extraction gains a dimension: an old cache has no
  // `services`, and silently reusing it would report every host service as gone.
  const cacheFile = join(cacheRoot, `surface-v2-${key}.json`)

  if (opts.force !== true && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8'))
      // `services` is an object ({declared, mentioned}) since the host-service
      // scan landed; an older array form is still accepted. Checking only
      // Array.isArray made every cache entry miss and re-extract the installer.
      const svc = cached?.services
      const servicesOk = Array.isArray(svc) || Array.isArray(svc?.declared)
      if (cached?.surface && servicesOk) return { ...cached, cached: true }
    } catch { /* rebuild below */ }
  }

  const shell = readShellBundleFromInstaller(pending.installer, {
    sevenZip: opts.sevenZip,
    cacheRoot,
    keepTemp: opts.keepTemp,
  })
  const surface = buildSurface(shell.text)
  const record = {
    key,
    version: pending.version,
    installer: pending.installer,
    shellEntry: shell.entry,
    shellSha256: shell.sha256,
    surface,
    // Host services come from the same asar the shell bundle came from.
    services: shell.services ?? [],
  }
  writeFileSync(cacheFile, JSON.stringify(record, null, 2))
  return { ...record, cached: false }
}


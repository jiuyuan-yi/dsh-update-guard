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
import { asarText, openAsar } from './asar.mjs'
import { servicesFromAsar } from './services.mjs'

/** Single shared extraction directory inside the cache root. */
const WORK_DIR_NAME = 'extract-work'

/**
 * The lock lives in its own directory, not inside WORK_DIR_NAME.
 *
 * `sweepStaleWorkDirs` treats an `extract-work` without a live marker as debris,
 * so a work directory that exists but is not yet marked (the gap between
 * creating it and writing the marker) can be deleted by a concurrent run.
 * A separate lock directory removes that gap entirely: the lock is acquired
 * before work is created, so "work exists" implies "somebody owns it".
 */
const LOCK_DIR_NAME = '.extract.lock'

/**
 * Is a pid still running?
 *
 * `process.kill(pid, 0)` is the portable probe, but on Windows it throws EPERM
 * for a live process owned by another user, so EPERM must count as alive.
 */
function processIsAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Take the extraction lock.
 *
 * The lock is a DIRECTORY: `mkdir` is atomic on every platform this runs on,
 * while "check then write" never is. `writeFileSync(..., {flag:'wx'})` was
 * atomic only for the very first creation — reclaiming a stale lock fell back to
 * a plain overwrite, so two processes that both saw a dead pid could both
 * overwrite and both proceed.
 *
 * Rules, all of which the previous version got wrong somewhere:
 *   - creation is mkdir, so exactly one racer succeeds (EEXIST = lost)
 *   - a stale lock is removed and then RE-RACED via mkdir; losing that race is
 *     busy, not "carry on"
 *   - any other failure to create throws; we never extract unlocked
 *
 * @param {string} lockDir
 * @param {string} pidPath
 */
function acquireLock (lockDir, pidPath) {
  const claim = () => {
    mkdirSync(lockDir) // throws EEXIST if someone else won
    try { writeFileSync(pidPath, String(process.pid), 'utf8') } catch { /* pid is advisory */ }
  }

  try {
    claim()
    return
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      // EACCES, ENOENT, ENOSPC... do NOT proceed into the shared directory.
      throw new Error(`cannot create extraction lock at ${lockDir}: ${error?.message ?? error}`)
    }
  }

  const holder = readLockHolder(pidPath)
  if (holder !== undefined && processIsAlive(holder)) {
    throw new Error(`another extraction is in progress (pid ${holder}); ${WORK_DIR_NAME} is busy`)
  }

  // Stale: drop it and race again. Two processes may both get here; only one
  // mkdir can succeed, and the loser is told to wait instead of extracting.
  try { rmSync(lockDir, { recursive: true, force: true }) } catch { /* best effort */ }
  try {
    claim()
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`another extraction is in progress; ${WORK_DIR_NAME} is busy (race)`)
    }
    throw new Error(`cannot create extraction lock at ${lockDir}: ${error?.message ?? error}`)
  }
}

/**
 * Wait briefly for a lock held by someone else.
 *
 * The background startup check and a manual `guard.mjs check` can overlap. They
 * are doing the same work, so making the second wait a moment is better than
 * degrading it to the declared-range tier for a transient conflict.
 */
function acquireLockWithRetry (lockDir, pidPath, attempts = 5, waitMs = 400) {
  let last
  for (let i = 0; i < attempts; i++) {
    try {
      acquireLock(lockDir, pidPath)
      return
    } catch (error) {
      last = error
      if (!/busy/.test(String(error?.message ?? ''))) throw error
      if (i === attempts - 1) break
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs) } catch { /* spin */ }
    }
  }
  throw last
}

/** Release the lock: remove the pid file first, then the directory. */
function releaseLock (lockDir) {
  try { rmSync(lockDir, { recursive: true, force: true }) } catch { /* sweeper will reclaim */ }
}

/** @returns {number|undefined} recorded holder pid, if readable */
function readLockHolder (pidPath) {
  try {
    const n = Number(readFileSync(pidPath, 'utf8').trim())
    return Number.isFinite(n) && n > 0 ? n : undefined
  } catch {
    return undefined
  }
}

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

  // One fixed work directory, not `extract-<pid>`: a per-PID name guaranteed a
  // fresh 175 MB copy per launch, and Windows holds app.asar open so the old one
  // could not be reclaimed until that process died.
  const shared = opts.workDir === undefined
  const work = opts.workDir ?? join(opts.cacheRoot, WORK_DIR_NAME)
  const lockDir = shared ? join(opts.cacheRoot, LOCK_DIR_NAME) : undefined
  const lockPid = lockDir === undefined ? undefined : join(lockDir, 'pid')

  const cachedAsar = join(work, 'app.asar')
  const sourceStamp = join(work, '.source')
  const mySourceKey = cacheKeyOf(installer)

  const readSurface = (path) => {
    // Layer 3: the shell bundle.
    const hit = asarText(path, /dsh-web-frontend\/dist\/assets\/index-[^/]+\.js$/)
    if (hit === undefined) throw new Error('shell bundle not found inside app.asar')

    // Layer 4: host service names, from the asar we already have on disk.
    let services = { declared: [], mentioned: [] }
    try { services = servicesFromAsar(path) } catch { /* keep the surface usable */ }

    const buf = Buffer.from(hit.text, 'utf8')
    return {
      text: hit.text,
      entry: hit.path,
      sha256: createHash('sha256').update(buf).digest('hex'),
      services,
    }
  }

  const extract = () => {
    const outer = listEntries(sevenZip, installer)
    const payloadLine = outer.find(l => /app-\d+\.7z$/i.test(l))
    if (!payloadLine) throw new Error('installer does not contain app-*.7z (unexpected layout)')
    const payloadName = payloadLine.split(/\s+/).pop()
    run7z(sevenZip, ['e', installer, payloadName, `-o${work}`, '-y'])

    const payloadPath = join(work, payloadName.split(/[\\/]/).pop())
    if (!existsSync(payloadPath)) throw new Error('payload extraction produced no file')

    const inner = listEntries(sevenZip, payloadPath)
    const asarLine = inner.find(l => /resources[\\/]app\.asar$/i.test(l))
    if (!asarLine) throw new Error('app.asar not found inside payload')
    const asarEntry = asarLine.split(/\s+/).pop()
    run7z(sevenZip, ['e', payloadPath, asarEntry, `-o${work}`, '-y'])

    const path = join(work, asarEntry.split(/[\\/]/).pop())
    if (!existsSync(path)) throw new Error('app.asar extraction produced no file')

    // Stamp last: a stamp without a complete asar would be a lie the next run
    // could act on.
    try { writeFileSync(sourceStamp, mySourceKey, 'utf8') } catch { /* best effort */ }
    return path
  }

  // Everything below runs under the lock — including the reuse branch.
  //
  // Reading a "cached" asar without the lock races with another process that is
  // mid-extraction into the same file. The lock costs one mkdir, so take it.
  if (lockDir !== undefined) acquireLockWithRetry(lockDir, lockPid)
  try {
    let asarPath

    // Reuse only a file THIS installer produced. `extract-work` is shared, so
    // "present and big enough" says nothing about which package it came from: a
    // leftover RC1 asar would otherwise be analysed as RC2 and filed under RC2's
    // cache key. The stamp is the identity.
    if (shared && existsSync(cachedAsar)) {
      try {
        const stamp = readFileSync(sourceStamp, 'utf8').trim()
        if (stamp === mySourceKey && statSync(cachedAsar).size > 1024 * 1024) asarPath = cachedAsar
      } catch { /* no stamp or partial write: extract fresh */ }
    }

    let extracted = false
    if (asarPath === undefined) {
      // The lock is already held, so creating work here cannot be seen as an
      // unowned leftover by a concurrent sweep.
      mkdirSync(work, { recursive: true })
      try {
        asarPath = extract()
        extracted = true
      } catch (error) {
        // A half-written asar must not survive as a reusable cache.
        if (opts.keepTemp !== true) removeWorkDir(work)
        throw error
      }
    }

    // Read BEFORE cleanup. An earlier version put removeWorkDir in the
    // extraction's own finally, so a successful delete removed app.asar and the
    // next line threw ENOENT.
    try {
      return readSurface(asarPath)
    } finally {
      if (extracted && opts.keepTemp !== true) removeWorkDir(work)
    }
  } finally {
    if (lockDir !== undefined) releaseLock(lockDir)
  }
}

/**
 * Best-effort removal of one extraction directory.
 *
 * Retries because the usual blocker on Windows is a transient antivirus or
 * indexer handle, not a real leak. Returns a short description of what survived
 * so the caller can surface it; `undefined` means the directory is gone.
 *
 * @returns {string|undefined}
 */
export function removeWorkDir (dir) {
  if (!existsSync(dir)) return undefined
  const delays = [0, 120, 400, 900]
  for (const ms of delays) {
    if (ms > 0) {
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* fall through */ }
    }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch { /* retry */ }
    if (!existsSync(dir)) return undefined
  }
  // Still here: name the biggest survivor so a report can say what is stuck.
  let worst
  try {
    for (const name of readdirSync(dir)) {
      const fp = join(dir, name)
      try {
        const size = statSync(fp).size
        if (worst === undefined || size > worst.size) worst = { name, size }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return worst === undefined
    ? `临时目录未能删除: ${dir}`
    : `临时目录未能删除（最大残留 ${worst.name} ${Math.round(worst.size / 1048576)} MB）: ${dir}`
}

/**
 * Sweep extraction directories left behind by earlier processes.
 *
 * A successful run removes its own `extract-<pid>` directory, but on Windows the
 * host's renderer process can still hold `app.asar` open when that happens, so
 * the cleanup legitimately fails *for the life of that process*. The next launch
 * is the first moment those handles are gone — which makes this sweep the only
 * place the leak can actually be reclaimed. Only directories whose PID is not
 * the current process are touched.
 *
 * @returns {{removed: string[], blocked: string[]}}
 */
export function sweepStaleWorkDirs (cacheRoot) {
  const out = { removed: [], blocked: [] }
  let names
  try { names = readdirSync(cacheRoot) } catch { return out }
  const self = `extract-${process.pid}`

  // Whether the shared directory is in use is decided by the LOCK, not by a
  // marker inside the directory. That is what lets creation and ownership be
  // observed atomically: the lock exists before work does.
  const lockDir = join(cacheRoot, LOCK_DIR_NAME)
  const lockHolder = readLockHolder(join(lockDir, 'pid'))
  const lockLive = lockHolder !== undefined && processIsAlive(lockHolder)

  for (const name of names) {
    // Three shapes are collected: the legacy per-PID `extract-<pid>`
    // directories older versions left behind, the modern shared `extract-work`,
    // and the lock directory itself.
    let sweepable = false
    if (/^extract-\d+$/.test(name)) {
      sweepable = name !== self
    } else if (name === LOCK_DIR_NAME) {
      // A lock whose holder is gone is debris; one whose holder lives is not.
      sweepable = !lockLive
    } else if (name === WORK_DIR_NAME) {
      sweepable = !lockLive
    }
    if (!sweepable) continue
    const dir = join(cacheRoot, name)
    const stuck = removeWorkDir(dir)
    if (stuck === undefined) out.removed.push(name)
    else out.blocked.push(name)
  }
  return out
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
  // Reclaim extraction directories a previous launch could not delete. This
  // runs before the cache check on purpose: the sweep is cheap when there is
  // nothing stale, and it is the only moment those file handles are released.
  try { sweepStaleWorkDirs(cacheRoot) } catch { /* never block the check */ }
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

/**
 * The version actually installed, read from the running app's asar.
 *
 * Without this the guard compares the pending installer against nothing and
 * happily announces that plugins "will break in this update" when the update is
 * the build already running. Reported as four broken plugins on a machine where
 * all four were working fine.
 *
 * @param {string} installRoot
 * @returns {string|undefined}
 */
export function installedVersion (installRoot) {
  try {
    const asar = openAsar(join(installRoot, 'resources', 'app.asar'))
    const hit = asar.find(/^package\.json$/)
    if (hit === undefined) return undefined
    const pkg = JSON.parse(hit.buffer.toString('utf8'))
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

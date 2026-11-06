/**
 * Regression test for the extraction work directory.
 *
 * The bug this pins down: every launch used `extract-<pid>`, and on Windows the
 * host's renderer keeps `app.asar` open, so the in-flight `rmSync` could not
 * delete it. One orphaned 175 MB directory accumulated per launch, silently,
 * because the failure went to `catch {}`.
 *
 * The fix has three parts, each checked here:
 *   1. work happens in ONE shared directory, not one per PID;
 *   2. stale directories (legacy `extract-<pid>` and an unlocked `extract-work`)
 *      are reclaimed by a sweep;
 *   3. a live holder is never trampled, and the live-holder check uses a marker
 *      rather than guessing from the directory name.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { sweepStaleWorkDirs, removeWorkDir } from '../lib/installer.mjs'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

function makeCache () {
  const root = mkdtempSync(join(tmpdir(), 'ug-sweep-'))
  return root
}

// ① The shared work directory name is a constant, so two launches cannot each
//    mint their own copy of the asar.
{
  const src = readFileSync(join(PKG, 'lib', 'installer.mjs'), 'utf8')
  check('工作目录是固定名', /WORK_DIR_NAME\s*=\s*'extract-work'/.test(src))
  check('不再用 extract-<pid> 作为工作目录', !/opts\.workDir \?\? join\(opts\.cacheRoot, `extract-\$\{process\.pid\}`\)/.test(src))
}

// ② A legacy per-PID directory whose process is gone is removed.
{
  const root = makeCache()
  const stale = join(root, 'extract-999999') // no such process
  mkdirSync(stale, { recursive: true })
  writeFileSync(join(stale, 'app.asar'), 'x'.repeat(1024))
  const r = sweepStaleWorkDirs(root)
  check('清掉死进程的旧目录', r.removed.includes('extract-999999'), JSON.stringify(r.removed))
  check('目录确实消失', !existsSync(stale))
  rmSync(root, { recursive: true, force: true })
}

// ③ A directory held by a LIVE process is left alone.
{
  const root = makeCache()
  const live = join(root, `extract-${process.pid}`)
  mkdirSync(live, { recursive: true })
  writeFileSync(join(live, 'app.asar'), 'x')
  const r = sweepStaleWorkDirs(root)
  check('不碰当前进程自己的目录', !r.removed.includes(`extract-${process.pid}`))
  check('目录仍在', existsSync(live))
  rmSync(root, { recursive: true, force: true })
}

// ④ The shared directory follows the LOCK, not a marker inside it.
//
// Ownership has to live outside `extract-work`: otherwise the instant between
// "created the directory" and "wrote the marker" looks like debris, and a
// concurrent sweep can delete a directory someone is actively using.
{
  const root = makeCache()
  const shared = join(root, 'extract-work')
  const lockDir = join(root, '.extract.lock')
  mkdirSync(shared, { recursive: true })
  writeFileSync(join(shared, 'app.asar'), 'x'.repeat(512))

  // A live lock holds the directory even though the directory itself has no marker.
  mkdirSync(lockDir, { recursive: true })
  writeFileSync(join(lockDir, 'pid'), String(process.pid))
  let r = sweepStaleWorkDirs(root)
  check('活锁时保留共享目录', existsSync(shared) && !r.removed.includes('extract-work'))
  check('活锁时保留锁目录', existsSync(lockDir))

  // A dead lock means nobody owns it: both the lock and the work dir are debris.
  writeFileSync(join(lockDir, 'pid'), '999999')
  r = sweepStaleWorkDirs(root)
  check('死锁时清掉共享目录', !existsSync(shared), JSON.stringify(r.removed))
  check('死锁时清掉锁目录', !existsSync(lockDir))
  rmSync(root, { recursive: true, force: true })
}

// ⑤ A shared directory with no lock at all is treated as free (crash recovery).
{
  const root = makeCache()
  const shared = join(root, 'extract-work')
  mkdirSync(shared, { recursive: true })
  writeFileSync(join(shared, 'app.asar'), 'x')
  const r = sweepStaleWorkDirs(root)
  check('无锁的共享目录视为可清', !existsSync(shared), JSON.stringify(r.removed))
  rmSync(root, { recursive: true, force: true })
}

// ⑥ removeWorkDir reports survivors instead of swallowing the failure.
{
  const root = makeCache()
  const gone = join(root, 'nope')
  check('不存在的目录返回 undefined', removeWorkDir(gone) === undefined)

  const kept = join(root, 'kept')
  mkdirSync(kept, { recursive: true })
  writeFileSync(join(kept, 'app.asar'), 'x'.repeat(2048))
  const msg = removeWorkDir(kept)
  check('能删掉的目录返回 undefined', msg === undefined && !existsSync(kept))
  rmSync(root, { recursive: true, force: true })
}

// ⑦ Unrelated cache entries are never touched.
{
  const root = makeCache()
  const keepFile = join(root, 'surface-v2-abc.json')
  const keepDir = join(root, 'something-else')
  writeFileSync(keepFile, '{}')
  mkdirSync(keepDir, { recursive: true })
  sweepStaleWorkDirs(root)
  check('不动 surface 缓存文件', existsSync(keepFile))
  check('不动无关目录', existsSync(keepDir))
  rmSync(root, { recursive: true, force: true })
}

// ⑧ A leftover app.asar is a cache to reuse, not a lock to honour.
//
// The bug: after a successful extraction, Windows often cannot delete app.asar
// (the host read it and still holds the handle), so the cleanup left the marker
// behind pointing at a process that was merely alive. The next run read
// "holder alive" as "another extraction is in progress" and degraded to
// declared-only — surface never came from the installer, so e2e detected
// nothing and failed 7 assertions.
{
  const src = readFileSync(join(PKG, 'lib', 'installer.mjs'), 'utf8')

  // Anchor on the REUSE STATEMENT, not on the `cachedAsar` declaration: the
  // declaration sits above the lock, the decision has to be below it.
  const reuseAt = src.indexOf('if (shared && existsSync(cachedAsar))')
  const lockCallAt = src.indexOf('acquireLockWithRetry(lockDir, lockPid)')
  const mkdirWorkAt = src.indexOf('mkdirSync(work, { recursive: true })')
  const guardAt = src.indexOf('if (asarPath === undefined)')

  check('有 cachedAsar 复用逻辑', reuseAt > 0)
  check('复用判断也在锁内', lockCallAt > 0 && reuseAt > lockCallAt,
    `lock=${lockCallAt} reuse=${reuseAt}`)
  check('先加锁、后创建 work 目录',
    lockCallAt > 0 && mkdirWorkAt > 0 && lockCallAt < mkdirWorkAt,
    `lock=${lockCallAt} mkdir=${mkdirWorkAt}`)
  check('解包仍在 asarPath === undefined 分支里', guardAt > 0 && guardAt < mkdirWorkAt,
    `guard=${guardAt} mkdir=${mkdirWorkAt}`)

  // The lock is a directory created with mkdir (atomic everywhere), not a file
  // written with flag 'wx' (atomic only for the first creation). Scope the
  // negative check to the function body so the explanatory comment above it,
  // which quotes the old code, does not trip it.
  const lockFnStart = src.indexOf('function acquireLock (')
  const lockFnEnd = src.indexOf('function acquireLockWithRetry')
  const lockBody = lockFnStart > 0 && lockFnEnd > lockFnStart
    ? src.slice(lockFnStart, lockFnEnd)
    : ''
  check('锁用 mkdir 原子创建', /mkdirSync\(lockDir\)/.test(lockBody))
  check('acquireLock 内部不再用 wx 写文件当锁', lockBody.length > 0 && !/flag:\s*'wx'/.test(lockBody))
  check('锁目录独立于 work 目录', /LOCK_DIR_NAME\s*=\s*'\.extract\.lock'/.test(src))

  // Stale reclaim must re-race; a plain overwrite let two processes both win.
  check('过期锁是删掉后重新 mkdir 竞争',
    /rmSync\(lockDir[\s\S]{0,200}claim\(\)/.test(src))
  check('非 EEXIST 的创建失败会抛错（不无锁运行）',
    /cannot create extraction lock/.test(src) && !/if \(error\?\.code !== 'EEXIST'\) return/.test(src))

  // Sweep decides ownership from the lock directory, not from a marker inside work.
  check('sweep 用锁目录判断占用', /const lockLive = lockHolder !== undefined && processIsAlive\(lockHolder\)/.test(src))
  check('sweep 会回收死掉的锁目录', /name === LOCK_DIR_NAME/.test(src))

  check('复用前比对来源标记', /stamp === mySourceKey/.test(src))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

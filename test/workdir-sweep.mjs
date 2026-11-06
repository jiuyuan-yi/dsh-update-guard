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

// ④ The shared directory is swept only when its marker's process is gone.
{
  const root = makeCache()
  const shared = join(root, 'extract-work')
  mkdirSync(shared, { recursive: true })
  writeFileSync(join(shared, 'app.asar'), 'x'.repeat(512))

  // live marker -> keep
  writeFileSync(join(shared, '.in-use'), String(process.pid))
  let r = sweepStaleWorkDirs(root)
  check('活锁时保留共享目录', existsSync(shared) && !r.removed.includes('extract-work'))

  // dead marker -> remove
  writeFileSync(join(shared, '.in-use'), '999999')
  r = sweepStaleWorkDirs(root)
  check('死锁时清掉共享目录', !existsSync(shared), JSON.stringify(r.removed))
  rmSync(root, { recursive: true, force: true })
}

// ⑤ A shared directory with no marker is treated as free (crash recovery).
{
  const root = makeCache()
  const shared = join(root, 'extract-work')
  mkdirSync(shared, { recursive: true })
  writeFileSync(join(shared, 'app.asar'), 'x')
  const r = sweepStaleWorkDirs(root)
  check('无标记的共享目录视为可清', !existsSync(shared), JSON.stringify(r.removed))
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

  const cacheCheckAt = src.indexOf('cachedAsar')
  // Anchor on the CALL inside readShellBundleFromInstaller, not on the message
  // string: that text now also lives in the standalone acquireLock helper near
  // the top of the file, which would make an index comparison meaningless.
  const lockCallAt = src.indexOf('acquireLock(lockFile)')
  const guardAt = src.indexOf('if (asarPath === undefined)')

  check('有 cachedAsar 复用逻辑', cacheCheckAt > 0)
  check('复用判断在加锁之前', cacheCheckAt > 0 && lockCallAt > 0 && cacheCheckAt < lockCallAt,
    `cache=${cacheCheckAt} lock=${lockCallAt}`)
  check('解包与加锁都包在 asarPath === undefined 里', guardAt > 0 && guardAt < lockCallAt,
    `guard=${guardAt} lock=${lockCallAt}`)
  check('锁是原子创建（wx）', /flag:\s*'wx'/.test(src))
  check('不再把标记写回去冒充忙碌', !/writeFileSync\(lockFile, String\(process\.pid\)[\s\S]{0,200}removeWorkDir/.test(src))

  // The reuse path must not read the marker at all — it compares the source stamp.
  const reuseBlock = src.slice(cacheCheckAt, guardAt > 0 ? guardAt : cacheCheckAt + 900)
  check('复用路径不读锁标记', !/readFileSync\(lockFile/.test(reuseBlock))
  check('复用前比对来源标记', /stamp === mySourceKey/.test(reuseBlock))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

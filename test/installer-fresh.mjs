/**
 * 全新缓存下的真实解包。
 *
 * 这个测试存在的唯一理由：0.3.3 把清理放在解包的 `finally` 里、读取放在后面，
 * 于是一次成功的删除会让 `app.asar` 在读取之前消失。之前所有的测试都跑在
 * 已经有残留缓存的机器上，走的是「复用」分支，根本不进那段 finally ——
 * 缺陷因此在 23/23 的绿灯下隐形。
 *
 * 这里强制用一个空的临时缓存目录，走真正的解包路径，并且检查：
 *   1. 解出来之后确实读到了内容（不是 ENOENT）
 *   2. 解包失败时不留半成品（否则下次会被当成可复用的缓存）
 *   3. 缓存的来源标记与安装包身份绑定（换包必须重新解包）
 */
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import {
  readShellBundleFromInstaller,
  findPendingUpdate,
  findInstallRoot,
  find7z,
  cacheKeyOf,
} from '../lib/installer.mjs'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

const root = findInstallRoot()
const pending = root === undefined ? undefined : findPendingUpdate(root)
const seven = find7z()

if (pending === undefined || seven === undefined) {
  console.log('SKIP: 没有待安装的更新包，或找不到 7-Zip；这条测试需要真实安装包')
  console.log('ALL PASS (skipped)')
  process.exit(0)
}

console.log(`  安装包: ${pending.installer}`)

// 每次用独立目录，绝不碰真实 .cache，也绝不依赖上一次运行留下的东西。
const cacheRoot = join(tmpdir(), `fresh-${process.pid}`)
rmSync(cacheRoot, { recursive: true, force: true })
mkdirSync(cacheRoot, { recursive: true })

try {
  console.log('\n[1] 全新缓存：解包后必须能读到内容')
  {
    let result
    let error
    const t0 = Date.now()
    try {
      result = readShellBundleFromInstaller(pending.installer, { cacheRoot })
    } catch (e) {
      error = e
    }
    const ms = Date.now() - t0

    check('没有抛错', error === undefined,
      error === undefined ? `${ms}ms` : String(error?.message ?? error))
    check('拿到了 text', typeof result?.text === 'string' && result.text.length > 1000,
      result?.text ? `${result.text.length} chars` : '(no text)')
    check('拿到了 entry', typeof result?.entry === 'string' && result.entry.length > 0)
    check('拿到了 sha256', /^[0-9a-f]{64}$/.test(String(result?.sha256 ?? '')))
    check('services 是对象',
      result?.services !== null && typeof result?.services === 'object')

    // 清理过之后，目录要么整个不在了，要么只剩可复用的缓存。
    // 关键的失败模式是「目录在、asar 没了、却以为成功」——上面已经排除了。
    const work = join(cacheRoot, 'extract-work')
    const asarStill = existsSync(join(work, 'app.asar'))
    const stampStill = existsSync(join(work, '.source'))
    console.log(`  残留: work=${existsSync(work)} asar=${asarStill} stamp=${stampStill}`)
    check('缓存标记与 asar 同存同灭',
      asarStill === stampStill, `asar=${asarStill} stamp=${stampStill}`)
  }

  console.log('\n[2] 第二次调用仍然成功（清理彻底时会重新解，有残留时走复用）')
  {
    const t0 = Date.now()
    let second
    let error
    try {
      second = readShellBundleFromInstaller(pending.installer, { cacheRoot })
    } catch (e) { error = e }
    const ms = Date.now() - t0

    check('第二次没有抛错', error === undefined,
      error === undefined ? `${ms}ms` : String(error?.message ?? error))
    check('第二次仍然拿到内容',
      typeof second?.text === 'string' && second.text.length > 1000)
  }

  console.log('\n[3] 来源标记必须绑定安装包身份（用 keepTemp 造出可复用的缓存）')
  {
    // The previous version only exercised this when cleanup had already failed to
    // delete the asar, so on a clean machine it silently fell back to grepping
    // the source. `keepTemp: true` forces the "extracted and still on disk"
    // state that the reuse logic actually has to handle.
    const keepRoot = join(cacheRoot, 'keep-case')
    mkdirSync(keepRoot, { recursive: true })

    const first = readShellBundleFromInstaller(pending.installer, { cacheRoot: keepRoot, keepTemp: true })
    const work = join(keepRoot, 'extract-work')
    const stamp = join(work, '.source')
    const asar = join(work, 'app.asar')

    check('keepTemp 保留了 app.asar', existsSync(asar))
    check('keepTemp 保留了 .source', existsSync(stamp))
    check('标记等于当前安装包的 cacheKey',
      existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === cacheKeyOf(pending.installer))

    // A matching stamp must reuse the file rather than re-extract it. mtime is
    // the evidence: a re-extraction rewrites the file and moves it.
    const before = existsSync(asar) ? statSync(asar).mtimeMs : 0
    const second = readShellBundleFromInstaller(pending.installer, { cacheRoot: keepRoot, keepTemp: true })
    const after = existsSync(asar) ? statSync(asar).mtimeMs : 0
    check('同包第二次复用缓存（asar 未被重写）', before !== 0 && before === after,
      `${before} -> ${after}`)
    check('复用结果与首次一致', second.sha256 === first.sha256)

    // A stamp naming a different installer must force re-extraction.
    if (existsSync(stamp)) {
      writeFileSync(stamp, 'not-this-installer', 'utf8')
      const third = readShellBundleFromInstaller(pending.installer, { cacheRoot: keepRoot, keepTemp: true })
      check('身份不符时重新解包并成功',
        typeof third.text === 'string' && third.text.length > 1000)
      check('重新解包后标记被改回正确值',
        existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === cacheKeyOf(pending.installer))
    } else {
      check('身份不符时重新解包并成功', false, '缺少 .source，无法验证')
    }
  }

  console.log('\n[4] 解包失败不留半成品')
  {
    const failRoot = join(cacheRoot, 'fail-case')
    mkdirSync(failRoot, { recursive: true })
    const bogus = join(failRoot, 'not-an-installer.exe')
    writeFileSync(bogus, 'this is not a NSIS archive', 'utf8')

    let threw = false
    try {
      readShellBundleFromInstaller(bogus, { cacheRoot: failRoot })
    } catch { threw = true }

    check('非安装包会抛错', threw)

    const work = join(failRoot, 'extract-work')
    const asar = join(work, 'app.asar')
    const stamp = join(work, '.source')
    check('没有留下 app.asar', !existsSync(asar))
    check('没有留下来源标记', !existsSync(stamp))
  }
} finally {
  try { rmSync(cacheRoot, { recursive: true, force: true }) } catch { /* best effort */ }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

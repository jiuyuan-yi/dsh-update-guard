/**
 * Atomic replace.
 *
 * These files are the ones the tool repairs: profile `package.json`,
 * `cordis.patch.yml`, the guard config. A truncated write there is the exact
 * failure this plugin exists to undo, so the write path itself has to be safe.
 */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { atomicWriteFile, atomicWriteJson } from '../lib/atomic.mjs'

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

const work = mkdtempSync(join(tmpdir(), 'ug-atomic-'))
try {
  mkdirSync(join(work, 'profile'), { recursive: true })

  console.log('\n[1] 写入与覆盖')
  {
    const p = join(work, 'profile', 'a.json')
    atomicWriteFile(p, '{"n":1}')
    check('新文件写入', readFileSync(p, 'utf8') === '{"n":1}')
    atomicWriteFile(p, '{"n":2}')
    check('覆盖已有文件', readFileSync(p, 'utf8') === '{"n":2}')
  }

  console.log('\n[2] 不留临时文件')
  {
    const p = join(work, 'profile', 'b.json')
    atomicWriteFile(p, '{}')
    const leftovers = readdirSync(join(work, 'profile')).filter(f => f.includes('.tmp-'))
    check('目录里没有 .tmp- 残留', leftovers.length === 0, leftovers.join(','))
  }

  console.log('\n[3] JSON 写入格式稳定')
  {
    const p = join(work, 'profile', 'c.json')
    atomicWriteJson(p, { bundles: ['x'], n: 2 })
    const text = readFileSync(p, 'utf8')
    check('两空格缩进', text.includes('\n  "bundles"'))
    check('末尾无换行', !text.endsWith('\n'))
    check('能解析回来', JSON.parse(text).n === 2)
  }

  console.log('\n[4] 目录不存在时抛出，而不是静默丢弃')
  {
    let threw
    try { atomicWriteJson(join(work, 'missing-dir', 'x.json'), { a: 1 }) } catch (e) { threw = e }
    check('抛错', threw instanceof Error, threw ? String(threw.code ?? threw.message) : 'no throw')
    check('没有创建半个目录', !readdirSync(work).includes('missing-dir'))
  }

  console.log('\n[5] 重试参数只在瞬时错误上生效')
  {
    // retries: 0 must fail immediately without spinning; anything else would make
    // a genuinely broken path look slow rather than broken.
    const p = join(work, 'profile', 'd.json')
    writeFileSync(p, 'old')
    const started = Date.now()
    atomicWriteFile(p, 'new', { retries: 0 })
    check('retries:0 正常写入', readFileSync(p, 'utf8') === 'new')
    check('没有额外等待', Date.now() - started < 500, 'ms=' + (Date.now() - started))
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

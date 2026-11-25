/**
 * Report provenance.
 *
 * The report cache is one file shared by the CLI and the host plugin. `check`
 * may analyse any profile, so the file can describe a different tree than the
 * one the panel serves — and the panel offers to lock the entry ids inside it.
 * A report about a throwaway profile has ids that do not exist in the real one;
 * showing it is how a screenshot ends up listing `dsh-fixture-bad`.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { readCachedReport, saveReport } from '../lib/run.mjs'

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

const work = mkdtempSync(join(tmpdir(), 'ug-report-'))
try {
  const cacheRoot = join(work, 'cache')
  const mine = join(work, 'profiles', 'desktop')
  const other = join(work, 'tmp', 'guard-test-1', 'profile')

  console.log('\n[1] 同 profile 的报告可读')
  saveReport(cacheRoot, {
    stage: 'analysed',
    profileDir: mine,
    version: '9.9.9',
    findings: [{ plugin: 'alpha', ids: ['alpha'], broken: [] }],
  })
  const own = readCachedReport(cacheRoot, mine)
  check('读到了', own?.version === '9.9.9', String(own?.version))

  console.log('\n[2] 异源报告被拒绝')
  check('别的 profile 返回 undefined', readCachedReport(cacheRoot, other) === undefined)
  check('不传期望 profile 时照常返回', readCachedReport(cacheRoot, undefined)?.version === '9.9.9')

  console.log('\n[3] 覆盖为测试报告后，面板侧读不到')
  saveReport(cacheRoot, {
    stage: 'analysed',
    profileDir: other,
    version: '0.2.2-rc.5',
    findings: [{ plugin: 'dsh-fixture-bad', ids: ['bad'], broken: [{ moduleName: 'x', missing: ['projectUserText'] }] }],
  })
  check('面板 profile 读不到', readCachedReport(cacheRoot, mine) === undefined)
  check('测试 profile 能读到', readCachedReport(cacheRoot, other)?.findings?.[0]?.plugin === 'dsh-fixture-bad')

  console.log('\n[4] 坏数据不抛')
  writeFileSync(join(cacheRoot, 'last-report.json'), '{not json')
  check('坏 JSON → undefined', readCachedReport(cacheRoot, mine) === undefined)
  rmSync(join(cacheRoot, 'last-report.json'))
  check('缺文件 → undefined', readCachedReport(cacheRoot, mine) === undefined)
  check('缺目录 → undefined', readCachedReport(join(work, 'nope'), mine) === undefined)

  console.log('\n[5] --cache 让 CLI 不碰默认缓存')
  const isolated = join(work, 'isolated-cache')
  const p = saveReport(isolated, { stage: 'no-pending', profileDir: other })
  check('写到了指定目录', p !== undefined && p.startsWith(isolated), String(p))
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

/**
 * One command that runs everything and tells the truth about what it covered.
 *
 * The reviewer's complaint about `e2e` was fair: it exits 0 when it skips, so a
 * green run can hide an unverified area. This runner separates three outcomes:
 *
 *   PASS        the test ran and proved its claims
 *   UNVERIFIED  the test skipped (no install root, no PowerShell, ...)
 *   FAIL        the test failed
 *
 * Exit code: 0 only when nothing skipped and nothing failed; 3 when something
 * was not verified; 1 on failure.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(DIR).filter(f => f.endsWith('.mjs') && f !== 'all.mjs').sort()

const rows = []
for (const file of files) {
  const r = spawnSync(process.execPath, [join(DIR, file)], { encoding: 'utf8', timeout: 180000 })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  let status = 'FAIL'
  if (/ALL PASS/.test(out)) status = 'PASS'
  else if (/^SKIP:|SKIP:/m.test(out) && r.status === 0) status = 'UNVERIFIED'
  else if (r.status === 0 && /生成成功|"ok": true/.test(out)) status = 'PASS'
  rows.push({ file, status, code: r.status, out })
}

const pass = rows.filter(r => r.status === 'PASS')
const skip = rows.filter(r => r.status === 'UNVERIFIED')
const fail = rows.filter(r => r.status === 'FAIL')

console.log('\n=== 测试汇总 ===\n')
for (const r of rows) {
  const mark = r.status === 'PASS' ? '  ✓' : r.status === 'UNVERIFIED' ? '  ?' : '  ✗'
  console.log(mark + ' ' + r.file.padEnd(30) + r.status)
}

console.log('')
console.log('  已通过   : ' + pass.length)
if (skip.length > 0) console.log('  未验证   : ' + skip.length + '  (' + skip.map(r => r.file).join(', ') + ')')
if (fail.length > 0) console.log('  失败     : ' + fail.length)

for (const f of fail) {
  console.log('\n--- ' + f.file + ' 输出 ---')
  console.log(f.out.split(/\r?\n/).filter(l => /FAIL/.test(l)).join('\n'))
}

console.log('')
if (fail.length > 0) {
  console.log('结果: 有失败')
  process.exit(1)
}
if (skip.length > 0) {
  console.log('结果: 全部执行到的测试通过，但有 ' + skip.length + ' 项未验证')
  console.log('      未验证不等于通过。补齐环境后再看这一项。')
  process.exit(3)
}
console.log('结果: 全部通过，无跳过')
process.exit(0)

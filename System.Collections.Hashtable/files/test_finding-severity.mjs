/**
 * Regression test for how findings are narrated.
 *
 * The bug this pins down: `checkInBackground` treated "any finding" as "plugin
 * is incompatible". But a finding also covers cases that are not breakage —
 * a host service the new build may provide dynamically (`note: service-absent`),
 * or a plugin whose `broken` list is empty because the probe could not verify a
 * name either way. Reporting those as "N plugins will break" is what made a
 * working desktop plugin look incompatible to someone reading the log.
 *
 * The separation below is the contract: only a finding with a `broken` entry
 * that is NOT `service-absent` counts as confirmed breakage.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

// The classifier used by checkInBackground, kept here as the executable spec.
const isConfirmedBreakage = (f) =>
  Array.isArray(f.broken) && f.broken.length > 0 &&
  f.broken.some((b) => b.note !== 'service-absent')

console.log('\n[1] 只有真实缺失才算失效')
{
  check('模块缺失算失效', isConfirmedBreakage({ broken: [{ moduleName: 'x', missing: ['a'] }] }))
  check('成员缺失算失效', isConfirmedBreakage({ broken: [{ moduleName: 'y', missing: ['b'] }] }))
  check('服务缺失不算失效', !isConfirmedBreakage({
    broken: [{ moduleName: 'host services', missing: ['tuiPanels'], note: 'service-absent' }],
  }))
  check('空 broken 不算失效', !isConfirmedBreakage({ broken: [] }))
  check('缺 broken 字段不算失效', !isConfirmedBreakage({}))
}

console.log('\n[2] 混合情形：任一硬缺失即可确认')
{
  const mixed = {
    broken: [
      { moduleName: 'host services', missing: ['a'], note: 'service-absent' },
      { moduleName: 'y', missing: ['b'] },
    ],
  }
  check('服务缺失 + 成员缺失 = 失效', isConfirmedBreakage(mixed))
}

console.log('\n[3] 源码必须真的这么分类')
{
  const src = readFileSync(join(PKG, 'lib', 'index.js'), 'utf8')
  check('区分 hard 与 advisory', /const\s+hard\s*=/.test(src) && /const\s+advisory\s*=/.test(src))
  check('按 broken.some(note !== service-absent) 过滤', /b\.note\s*!==\s*'service-absent'/.test(src))
  check('没有 hard 时不再说不兼容',
    /hard\.length\s*===\s*0/.test(src) && /未发现不兼容/.test(src))
  check('告知哪些需人工确认', /需人工确认/.test(src))
  check('不再用 findings.length 直接断言失效', !/会让 \$\{findings\.length\} 个插件失效/.test(src))
}

console.log('\n[4] 自动锁定只作用于确认失效的条目')
{
  const src = readFileSync(join(PKG, 'lib', 'index.js'), 'utf8')
  check('锁定用的是 lockFromAnalysis', /lockFromAnalysis\(analysis/.test(src))
  const runSrc = readFileSync(join(PKG, 'lib', 'run.mjs'), 'utf8')
  check('lockFromAnalysis 排除 service-absent',
    /b\.note\s*!==\s*'service-absent'/.test(runSrc))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

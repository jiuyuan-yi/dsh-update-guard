/**
 * Tier-1 tests: version ranges and the declared-range check.
 *
 * These run without any archive tool, which is the whole point: on a machine
 * with no 7-Zip the guard must still be able to say something true.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseVersion, compare, satisfies } from '../lib/version.mjs'
import { checkDeclaredRanges, declaredRange } from '../lib/compat.mjs'

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

console.log('\n[1] 解析与比较')
{
  check('普通版本', JSON.stringify(parseVersion('0.2.1')) === JSON.stringify({ major: 0, minor: 2, patch: 1, pre: [] }))
  check('带预发布', parseVersion('0.2.1-rc.5')?.pre.join('.') === 'rc.5')
  check('非法版本返回 undefined', parseVersion('abc') === undefined)
  check('rc 低于正式版', compare(parseVersion('0.2.1-rc.5'), parseVersion('0.2.1')) === -1)
  check('rc.5 < rc.6', compare(parseVersion('0.2.1-rc.5'), parseVersion('0.2.1-rc.6')) === -1)
  check('0.2.1 > 0.2.0', compare(parseVersion('0.2.1'), parseVersion('0.2.0')) === 1)
}

console.log('\n[2] 范围匹配')
{
  check('* 全接受', satisfies('0.2.1-rc.5', '*') === true)
  check('精确匹配', satisfies('0.2.1', '0.2.1') === true)
  check('精确不匹配', satisfies('0.2.2', '0.2.1') === false)
  check('>= 且 <', satisfies('0.2.1-rc.5', '>=0.2.0-rc.1 <0.3.0-0') === true)
  check('超出上界', satisfies('0.3.0', '>=0.2.0-rc.1 <0.3.0-0') === false)
  check('低于下界', satisfies('0.1.9', '>=0.2.0-rc.1 <0.3.0-0') === false)
  check('^0.2.1 接受 0.2.9', satisfies('0.2.9', '^0.2.1') === true)
  check('^0.2.1 拒绝 0.3.0', satisfies('0.3.0', '^0.2.1') === false)
  check('~0.2.1 拒绝 0.3.0', satisfies('0.3.0', '~0.2.1') === false)
  check('~0.2.1 接受 0.2.5', satisfies('0.2.5', '~0.2.1') === true)
  check('|| 并集', satisfies('0.1.0', '<0.1.5 || >=0.2.0') === true)
  check('看不懂的范围返回 undefined', satisfies('0.2.1', 'banana') === undefined)
  check('^0.0.3 上限是 0.0.4', satisfies('0.0.4', '^0.0.3') === false)
}

console.log('\n[3] 声明字段优先级')
{
  check('engines.dsh 优先', declaredRange({ engines: { dsh: '>=0.2.0' }, peerDependencies: { '@deepseek-ai/dsh': '>=0.1.0' } })?.field === 'engines.dsh')
  check('退化到 peerDependencies', declaredRange({ peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' } })?.field === 'peerDependencies')
  check('都没有则 undefined', declaredRange({}) === undefined)
}

console.log('\n[4] 扫描 profile')
{
  const dir = join(tmpdir(), `guard-compat-${process.pid}`)
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  try {
    const mk = (name, manifest) => {
      const d = join(dir, 'node_modules', ...name.split('/'))
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'package.json'), JSON.stringify(manifest))
    }
    mk('fits', { name: 'fits', peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0-rc.1 <0.3.0-0' } })
    mk('too-new', { name: 'too-new', engines: { dsh: '>=0.3.0' } })
    mk('silent', { name: 'silent' })
    mk('weird', { name: 'weird', peerDependencies: { '@deepseek-ai/dsh': 'whatever' } })
    writeFileSync(join(dir, 'outside.json'), JSON.stringify({ name: 'outside', peerDependencies: { '@deepseek-ai/dsh': '<0.1.0' } }))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'fits', 'too-new', 'silent', 'weird', '../outside', 7] } },
    }))

    const r = checkDeclaredRanges(dir, '0.2.1-rc.5')
    check('检查了 3 个声明过的', r.checked === 3, String(r.checked))
    check('未声明被单列', r.undeclared.includes('silent'), r.undeclared.join(','))
    check('版本不匹配被抓', r.findings.some(f => f.plugin === 'too-new' && f.kind === 'range-mismatch'))
    check('匹配的不报', !r.findings.some(f => f.plugin === 'fits'))
    check('看不懂的范围单列', r.findings.some(f => f.plugin === 'weird' && f.kind === 'unknown-range'))
    check('路径穿越 bundle 被拒绝', r.findings.some(f => f.plugin === '../outside' && f.kind === 'invalid-package-name'))
    check('非字符串 bundle 被拒绝', r.findings.some(f => f.plugin === '7' && f.kind === 'invalid-package-name'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

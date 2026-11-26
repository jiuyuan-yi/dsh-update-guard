/**
 * Patch-layer safety tests.
 *
 * The one that matters most: a bundle patch may use the Loader's `!!js` dialect
 * for conditional entries. Rewriting such a line to a literal destroys the
 * condition — the exact defect reported against another plugin manager
 * (dsh-market#1043), where writing every line to `disabled: false` clobbered
 * `!!js` conditions and rolled back installs. We must refuse instead.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { lockIds, unlockAll, entryIdsOf, lockTarget } from '../lib/patch.mjs'

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

function makeProfile (patchText) {
  const dir = join(tmpdir(), `guard-patch-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.patch.yml'), patchText, 'utf8')
  return dir
}

console.log('\n[1] !!js 条件行必须拒绝改写')
{
  const before = [
    '- id: conditional',
    '  disabled: !!js/ctx.env.DISABLE_X',
    '',
  ].join('\n')
  const dir = makeProfile(before)
  try {
    const r = lockIds(dir, ['conditional'], {})
    const after = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    check('未改动文件', after === before)
    check('记为 refused', r.refused.length === 1 && r.refused[0].id === 'conditional')
    check('未计入 changed', r.changed.length === 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('\n[2] 普通布尔行可以改写，并可精确还原')
{
  const before = [
    '- id: plain',
    '  disabled: false',
    '',
  ].join('\n')
  const dir = makeProfile(before)
  try {
    const r = lockIds(dir, ['plain'], {})
    const after = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    check('改写为 true', /disabled: true/.test(after))
    check('计入 changed', r.changed.includes('plain'))
    unlockAll(dir)
    const restored = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    check('还原为 false', restored === before, restored === before ? '' : JSON.stringify(restored))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('\n[3] 无 disabled 行时插入，unlock 后删除')
{
  const before = ['- id: bare', '  name: bare', ''].join('\n')
  const dir = makeProfile(before)
  try {
    lockIds(dir, ['bare'], {})
    const after = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    check('插入了 disabled: true', /^\s*disabled: true$/m.test(after))
    unlockAll(dir)
    const restored = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    check('还原后与原始一致', restored === before, restored === before ? '' : JSON.stringify(restored))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('\n[4] bundle 声明的多个 id 全部取得')
{
  const dir = join(tmpdir(), `guard-ids-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(join(dir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: multi-a',
      "      name: pkg",
      '- insert:',
      '    - id: multi-b',
      "      name: pkg",
      '',
    ].join('\n'), 'utf8')
    const ids = entryIdsOf(dir)
    check('取到两个 id', ids.length === 2 && ids.includes('multi-a') && ids.includes('multi-b'), ids.join(','))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('\n[5] 手写 YAML 的常见形状不会导致重复块')
{
  const dir = join(tmpdir(), `guard-yaml-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  const patchPath = join(dir, 'cordis.patch.yml')
  const read = () => readFileSync(patchPath, 'utf8')
  try {
    // Quoted id: parseable now, so it must be modified in place, not appended.
    writeFileSync(patchPath, '- insert:\n    - id: "alpha"\n      name: alpha\n')
    const r1 = lockIds(dir, ['alpha'])
    check('引号 id 被就地改写', r1.changed.includes('alpha') && r1.refused.length === 0, JSON.stringify(r1))
    check('没有追加第二个 alpha 块', (read().match(/- id: "?alpha"?/g) ?? []).length === 1, read().replace(/\n/g, '⏎'))
    check('原条目被禁用', /disabled: true/.test(read()))

    // Trailing comment on the id line
    writeFileSync(patchPath, '- insert:\n    - id: beta  # 手动加的\n      name: beta\n')
    const r2 = lockIds(dir, ['beta'])
    check('带尾注释的 id 也能识别', r2.changed.includes('beta'), JSON.stringify(r2))
    check('没有追加 beta 块', (read().match(/- id: beta/g) ?? []).length === 1, read().replace(/\n/g, '⏎'))

    // disabled: with a trailing comment keeps the comment
    writeFileSync(patchPath, '- insert:\n    - id: gamma\n      disabled: false   # 之前手动关过\n')
    lockIds(dir, ['gamma'])
    check('尾注释保留', /disabled: true\s+# 之前手动关过/.test(read()), read().replace(/\n/g, '⏎'))

    // !!js refuses with a reason that names the actual cause
    writeFileSync(patchPath, '- insert:\n    - id: delta\n      disabled: !!js/function "() => false"\n')
    const r4 = lockIds(dir, ['delta'])
    check('!!js 被拒绝', r4.changed.length === 0 && r4.refused.length === 1, JSON.stringify(r4))
    check('原因说的是条件表达式', /条件表达式/.test(r4.refused[0]?.reason ?? ''), r4.refused[0]?.reason)

    // An id that exists but in a shape we cannot parse: refuse, never append.
    writeFileSync(patchPath, '- insert:\n    - id: [epsilon]\n      name: epsilon\n')
    const r5 = lockIds(dir, ['epsilon'])
    check('无法解析的既有条目被拒绝', r5.changed.length === 0 && r5.refused.length === 1, JSON.stringify(r5))
    check('拒绝理由说明是重复块风险', /重复块/.test(r5.refused[0]?.reason ?? ''), r5.refused[0]?.reason)
    check('文件没有被追加内容', !/- id: epsilon/.test(read()), read().replace(/\n/g, '⏎'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('\n[6] 锁记下目标版本，供 status 判断"可以解锁"')
{
  const dir = join(tmpdir(), `guard-target-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n    - id: zeta\n      name: zeta\n')
    check('没有状态文件时返回 null', lockTarget(dir) === null)
    lockIds(dir, ['zeta'], { expectedVersion: '0.2.2-rc.5' })
    check('锁定后记下目标版本', lockTarget(dir) === '0.2.2-rc.5', String(lockTarget(dir)))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

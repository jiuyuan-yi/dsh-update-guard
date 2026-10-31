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
import { lockIds, unlockAll, entryIdsOf } from '../lib/patch.mjs'

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

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

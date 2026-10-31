/**
 * Host-half smoke test: apply() must never throw, whatever the context does.
 * The guard is a convenience; a broken guard must leave DSH untouched.
 */
import { apply, name } from '../lib/index.js'
import { readConfig, writeConfig, CONFIG_NAME } from '../lib/run.mjs'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

function fakeCtx (overrides = {}) {
  const logs = []
  return {
    logs,
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
    },
    effect: (fn, label) => { logs.push(['effect', label]) },
    ...overrides,
  }
}

console.log('\n[1] 插件导出')
check('导出 name', name === 'update-guard')
check('导出 apply 且为函数', typeof apply === 'function')

console.log('\n[2] 正常上下文')
{
  const ctx = fakeCtx()
  let threw
  try { apply(ctx) } catch (e) { threw = e }
  check('apply 不抛', threw === undefined, threw ? String(threw.message) : '')
  check('注册了清理 effect', ctx.logs.some(([k]) => k === 'effect'))
  check('记录了加载日志', ctx.logs.some(([k, m]) => k === 'info' && String(m).includes('update-guard')))
}

console.log('\n[3] logger 抛异常')
{
  const ctx = fakeCtx({
    logger: { info: () => { throw new Error('logger dead') }, warn: () => { throw new Error('logger dead') } },
  })
  let threw
  try { apply(ctx) } catch (e) { threw = e }
  check('apply 仍不抛', threw === undefined, threw ? String(threw.message) : '')
}

console.log('\n[4] ctx.effect 抛异常')
{
  const ctx = fakeCtx({ effect: () => { throw new Error('effect dead') } })
  let threw
  try { apply(ctx) } catch (e) { threw = e }
  check('apply 仍不抛', threw === undefined, threw ? String(threw.message) : '')
}

console.log('\n[5] 空上下文（什么都没有）')
{
  let threw
  try { apply({}) } catch (e) { threw = e }
  check('apply 仍不抛', threw === undefined, threw ? String(threw.message) : '')
}

console.log('\n[6] 配置读写')
{
  const dir = join(tmpdir(), `guard-cfg-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  try {
    const d0 = readConfig(dir)
    check('默认 autoLock=关', d0.autoLock === false)
    check('默认启动自检=开', d0.preflightOnStartup === true)
    check('默认上限=3', d0.maxAutoLock === 3)
    const p = writeConfig(dir, { autoLock: true })
    check('写入配置文件', existsSync(p) && p.endsWith(CONFIG_NAME))
    const d1 = readConfig(dir)
    check('读回 autoLock=开', d1.autoLock === true)
    check('未写的项保持默认', d1.maxAutoLock === 3)
    // 损坏的配置不应让插件崩
    rmSync(p)
    writeFileSync(p, '{ not json', 'utf8')
    const d2 = readConfig(dir)
    check('损坏配置回退默认', d2.autoLock === false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

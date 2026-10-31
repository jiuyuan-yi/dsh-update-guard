/**
 * Host-service surface tests.
 *
 * The point of this dimension: most plugins ship no browser half at all, so a
 * client-API diff cannot see them. A service a *required* plugin injects but the
 * runtime no longer provides aborts boot — the failure this scan exists for.
 *
 * The precision rules matter as much as the detection:
 *   - dev scripts and the browser half are not host runtime code
 *   - a name the plugin provides itself is satisfied
 *   - a name that merely appears in the runtime is not reported as missing
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { serviceUsageOf, servicesFromDir, readPluginText } from '../lib/services.mjs'

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

console.log('\n[1] 硬依赖与软探测分离')
{
  const text = [
    "export const inject = ['webServer', 'slots']",
    "ctx.inject(['configForms'], (c) => {})",
    "const a = ctx.get('optionalThing')",
    "const b = ctx.get('slots')",
  ].join('\n')
  const u = serviceUsageOf(text)
  check('硬依赖 3 个', u.hard.length === 3, u.hard.join(','))
  check('含 webServer / slots / configForms',
    ['webServer', 'slots', 'configForms'].every(s => u.hard.includes(s)))
  check('软探测只留 optionalThing', u.soft.length === 1 && u.soft[0] === 'optionalThing', u.soft.join(','))
}

console.log('\n[2] 服务类注册形式都能识别')
{
  const dir = join(tmpdir(), `svc-${process.pid}-a`)
  mkdirSync(join(dir, 'lib'), { recursive: true })
  try {
    writeFileSync(join(dir, 'lib', 'a.js'), 'class X extends Service { constructor(ctx) { super(ctx, "alphaSvc") } }')
    writeFileSync(join(dir, 'lib', 'b.js'), 'ctx.provide("betaSvc")')
    writeFileSync(join(dir, 'lib', 'c.js'), 'ctx.set("gammaSvc", {})')
    writeFileSync(join(dir, 'lib', 'd.js'), 'registerService("deltaSvc", impl)')
    const names = servicesFromDir(dir)
    for (const n of ['alphaSvc', 'betaSvc', 'gammaSvc', 'deltaSvc']) {
      check(`识别 ${n}`, names.has(n))
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('\n[3] 开发脚本与浏览器半侧不算宿主代码')
{
  const dir = join(tmpdir(), `svc-${process.pid}-b`)
  mkdirSync(join(dir, 'lib'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  try {
    writeFileSync(join(dir, 'lib', 'host.js'), "export const inject = ['realSvc']")
    writeFileSync(join(dir, 'scripts', 'check.mjs'), "const x = { inject: ['scriptOnlySvc'] }")
    writeFileSync(join(dir, 'client.js'), "const c = { inject: ['clientOnlySvc'] }")
    const text = readPluginText(dir)
    const u = serviceUsageOf(text)
    check('保留宿主依赖', u.hard.includes('realSvc'), u.hard.join(','))
    check('排除 scripts/ 里的', !u.hard.includes('scriptOnlySvc'))
    check('排除 client.js 里的', !u.hard.includes('clientOnlySvc'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('\n[4] 无服务引用的插件不产生噪音')
{
  const dir = join(tmpdir(), `svc-${process.pid}-c`)
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(join(dir, 'index.js'), 'module.exports = { name: "plain", apply () {} }')
    const u = serviceUsageOf(readPluginText(dir))
    check('硬 0 软 0', u.hard.length === 0 && u.soft.length === 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

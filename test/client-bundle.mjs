/**
 * Client-bundle test without a browser.
 *
 * The bundle is an IIFE that calls `window.__ModuleLoader__.load({id, factory})`.
 * We provide a fake window and a fake `require`, then assert that:
 *   - it registers under the package id,
 *   - the factory returns name/inject/apply,
 *   - apply() registers the settings row on the slot it claims,
 *   - a throwing context does not propagate.
 *
 * This is the only way to check the browser half on a machine where the app is
 * already running (we cannot reload the page from here).
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const code = readFileSync(join(PKG, 'lib', 'client.js'), 'utf8')

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

/** Capture what the bundle registers. */
const registered = []
const fakeWindow = {
  __ModuleLoader__: {
    load (registration) { registered.push(registration) },
  },
}

const fakeDocument = {
  querySelector () { return null },
  createElement () { return { dataset: {}, set textContent (v) { this._t = v } } },
  head: { appendChild () { } },
}

const warnings = []
const fakeConsole = { warn: (...a) => warnings.push(a.join(' ')), log: () => { } }

console.log('\n[1] 加载并注册')
{
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', 'console', code)
  run(fakeWindow, fakeDocument, fakeConsole)
  check('调用了 __ModuleLoader__.load', registered.length === 1)
  check('id 是包名', registered[0]?.id === 'dsh-update-guard', String(registered[0]?.id))
  check('提供 factory', typeof registered[0]?.factory === 'function')
}

console.log('\n[2] factory 导出契约')
{
  const stubRequire = (name) => {
    if (name === 'react') {
      return {
        createElement: function () { return { type: arguments[0] } },
        useState: (v) => [v, () => { }],
        useEffect: () => { },
      }
    }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return { Switch: function Switch () { return null } }
    }
    throw new Error('unexpected require: ' + name)
  }

  const exports = registered[0].factory(stubRequire)
  check('有 name', typeof exports.name === 'string')
  check('inject 含 slots', Array.isArray(exports.inject) && exports.inject.includes('slots'))
  check('有 apply', typeof exports.apply === 'function')
}

console.log('\n[3] apply 注册设置项')
{
  const stubRequire = (name) => ({
    createElement: function () { return { type: arguments[0] } },
    useState: (v) => [v, () => { }],
    useEffect: () => { },
    Switch: function Switch () { return null },
  })
  const exports = registered[0].factory(stubRequire)

  const injected = []
  const registrations = []
  const ctx = {
    slots: {
      inject (slotName, fn) { injected.push(slotName); fn() },
      register (options, Component) { registrations.push({ options, Component }); return () => { } },
    },
    locale: { register () { return () => { } } },
    effect () { },
  }
  let threw
  try { exports.apply(ctx) } catch (e) { threw = e }
  check('apply 不抛', threw === undefined, threw ? String(threw.message) : '')
  check('注入的是 settings.general.item', injected.includes('settings.general.item'), injected.join(','))
  check('注册了一个设置项', registrations.length === 1)
  check('设置项 id 正确', registrations[0]?.options?.id === 'dsh-update-guard')
  check('挂了组件', typeof registrations[0]?.Component === 'function')
}

console.log('\n[4] 坏上下文不抛')
{
  const stubRequire = (name) => ({
    createElement: function () { return { type: arguments[0] } },
    useState: (v) => [v, () => { }],
    useEffect: () => { },
    Switch: function Switch () { return null },
  })
  const exports = registered[0].factory(stubRequire)
  let threw
  try { exports.apply({}) } catch (e) { threw = e }
  check('空 ctx 不抛', threw === undefined, threw ? String(threw.message) : '')
  try { exports.apply({ slots: { inject () { throw new Error('boom') } } }) } catch (e) { threw = e }
  check('inject 抛错也不冒出', threw === undefined, threw ? String(threw.message) : '')
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

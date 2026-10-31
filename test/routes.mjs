/**
 * Route tests: the panel's only write path.
 *
 * The property that matters is that a malformed or partial request cannot
 * silently reset a setting the panel did not mean to touch.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHandlers, registerRoutes, ROUTE_PREFIX } from '../lib/routes.mjs'
import { writeConfig, readConfig } from '../lib/run.mjs'

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

/** Minimal Node-ish request/response pair. */
function call (handler, { method = 'GET', body } = {}) {
  return new Promise((resolve) => {
    const listeners = {}
    const req = {
      method,
      on (ev, fn) { (listeners[ev] ??= []).push(fn); return req },
      destroy () { },
    }
    const chunks = []
    const res = {
      statusCode: 0,
      headers: undefined,
      writeHead (code, headers) { res.statusCode = code; res.headers = headers },
      end (payload) { chunks.push(payload ?? '') },
    }
    const done = () => resolve({
      status: res.statusCode,
      body: JSON.parse(chunks.join('') || '{}'),
    })
    const originalEnd = res.end
    res.end = (payload) => { originalEnd(payload); done() }
    handler(req, res)
    if (body !== undefined) {
      queueMicrotask(() => {
        for (const fn of listeners.data ?? []) fn(Buffer.from(body))
        for (const fn of listeners.end ?? []) fn()
      })
    }
  })
}

const dir = join(tmpdir(), `guard-routes-${process.pid}`)
mkdirSync(dir, { recursive: true })

try {
  writeConfig(dir, { autoLock: false, autoRestore: true, preflightOnStartup: true, maxAutoLock: 5 })
  const h = createHandlers(dir, () => ({ stage: 'no-pending' }))

  console.log('\n[1] 读配置')
  {
    const r = await call(h.getConfig)
    check('200', r.status === 200)
    check('带回当前值', r.body.config.autoRestore === true && r.body.config.maxAutoLock === 5)
  }

  console.log('\n[2] 局部更新不碰其它项')
  {
    const r = await call(h.putConfig, { method: 'PUT', body: JSON.stringify({ autoLock: true }) })
    check('200', r.status === 200)
    const after = readConfig(dir)
    check('autoLock 改了', after.autoLock === true)
    check('autoRestore 没被顺手改掉', after.autoRestore === true)
    check('maxAutoLock 没被顺手改掉', after.maxAutoLock === 5)
  }

  console.log('\n[3] 未知键与错误类型被拒绝且不落盘')
  {
    const before = readFileSync(join(dir, '.dsh-update-guard.json'), 'utf8')
    const r = await call(h.putConfig, { method: 'PUT', body: JSON.stringify({ nonsense: 1, autoLock: 'yes', maxAutoLock: 0 }) })
    check('200 但不应用', r.status === 200 && Object.keys(r.body.applied).length === 0, JSON.stringify(r.body.applied))
    check('文件未变', readFileSync(join(dir, '.dsh-update-guard.json'), 'utf8') === before)
  }

  console.log('\n[4] 坏 JSON 不崩')
  {
    const r = await call(h.putConfig, { method: 'PUT', body: '{ not json' })
    check('400', r.status === 400, String(r.status))
  }

  console.log('\n[5] 方法限制')
  {
    const r = await call(h.putConfig, { method: 'GET' })
    check('405', r.status === 405, String(r.status))
  }

  console.log('\n[6] 报告路由')
  {
    const r = await call(h.getReport)
    check('200 且带回报告', r.status === 200 && r.body.report?.stage === 'no-pending')
  }

  console.log('\n[7] 注册路由用正确的路径')
  {
    const registered = []
    const dispose = registerRoutes({ register (opts) { registered.push(opts.path); return () => { } } }, dir, () => null)
    check('config 路由', registered.includes(`${ROUTE_PREFIX}/config.json`), registered.join(','))
    check('report 路由', registered.includes(`${ROUTE_PREFIX}/report.json`))
    check('返回清理函数', typeof dispose === 'function')
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

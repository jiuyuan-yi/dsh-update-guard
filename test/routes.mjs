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
import { writeConfig, readConfig, guardedIds } from '../lib/run.mjs'

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

/** Minimal Node-ish request/response pair. */
function call (handler, { method = 'GET', body, url, headers } = {}) {
  return new Promise((resolve) => {
    const listeners = {}
    const req = {
      method,
      url: url ?? '/',
      // Writes carry JSON by default; a few cases override this to prove the
      // content-type requirement actually bites.
      headers: headers ?? { 'content-type': 'application/json' },
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
  // Locking rewrites this file; it must exist and contain the id being disabled.
  writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n    - id: alpha\n      name: alpha\n    - id: beta\n      name: beta\n')
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
    check('panel 路由', registered.includes(`${ROUTE_PREFIX}/panel.json`))
    check('返回清理函数', typeof dispose === 'function')
  }

  console.log('\n[8] 面板路由：缓存与刷新参数')
  {
    const calls = []
    const provider = (refresh) => {
      calls.push(refresh)
      return { payload: { ok: true, plugins: [], ghost: { status: 'clean' } }, cached: !refresh, ageMs: 12 }
    }
    const h2 = createHandlers(dir, () => null, provider)

    const plain = await call(h2.getPanel, { method: 'GET', url: `${ROUTE_PREFIX}/panel.json` })
    check('200', plain.status === 200)
    check('带回 panel', plain.body.panel?.ghost?.status === 'clean')
    check('标记来源于缓存', plain.body.cached === true)

    const fresh = await call(h2.getPanel, { method: 'GET', url: `${ROUTE_PREFIX}/panel.json?refresh=1` })
    check('refresh=1 传到 provider', calls[calls.length - 1] === true, JSON.stringify(calls))
    check('刷新后不再是缓存', fresh.body.cached === false)
  }

  console.log('\n[9] 没有 provider 时面板明确不可用，而不是 500')
  {
    const h3 = createHandlers(dir, () => null)
    const r = await call(h3.getPanel, { method: 'GET', url: `${ROUTE_PREFIX}/panel.json` })
    check('200 且 ok:false', r.status === 200 && r.body.ok === false, r.status + ' ' + JSON.stringify(r.body))
  }

  console.log('\n[10] 一键锁定：拒绝无依据的请求')
  {
    const none = createHandlers(dir, () => ({ stage: 'no-pending' }))
    const r1 = await call(none.postLock, { method: 'POST' })
    check('没有分析报告时 409', r1.status === 409 && r1.body.ok === false, String(r1.status))

    const other = createHandlers(dir, () => ({ stage: 'analysed', profileDir: join(dir, 'other'), findings: [] }))
    const r2 = await call(other.postLock, { method: 'POST' })
    check('别的 profile 的报告 409', r2.status === 409, String(r2.status))

    const empty = createHandlers(dir, () => ({ stage: 'analysed', profileDir: dir, findings: [] }))
    const r3 = await call(empty.postLock, { method: 'POST' })
    check('没有命中时 200 且不写', r3.status === 200 && r3.body.locked.length === 0, JSON.stringify(r3.body))
  }

  console.log('\n[11] 一键锁定：真的只锁命中的插件')
  {
    const patchPath = join(dir, 'cordis.patch.yml')
    const before = readFileSync(patchPath, 'utf8')
    const report = {
      stage: 'analysed',
      profileDir: dir,
      version: '9.9.9',
      findings: [
        {
          plugin: 'alpha',
          ids: ['alpha'],
          broken: [{ moduleName: '@deepseek-ai/dsh-client-ui-primitives', missing: ['Switch'] }],
        },
        {
          plugin: 'beta',
          ids: ['beta'],
          broken: [{ moduleName: 'host services', missing: ['session'], note: 'service-absent' }],
        },
      ],
    }
    const h4 = createHandlers(dir, () => report)
    const r = await call(h4.postLock, { method: 'POST' })
    check('200', r.status === 200, String(r.status))
    check('只锁 alpha', JSON.stringify(r.body.locked) === JSON.stringify(['alpha']), JSON.stringify(r.body.locked))
    check('service-absent 留在 advisory', (r.body.advisory || []).includes('beta'), JSON.stringify(r.body.advisory))
    check('撤销记录只含 alpha', JSON.stringify(guardedIds(dir)) === JSON.stringify(['alpha']), JSON.stringify(guardedIds(dir)))
    check('patch 文件确实改了', readFileSync(patchPath, 'utf8') !== before)
  }

  console.log('\n[12] 写操作只接受本机来源')
  {
    const evil = { origin: 'https://evil.example', 'content-type': 'application/json' }
    const r1 = await call(h.putConfig, { method: 'PUT', body: JSON.stringify({ autoLock: true }), headers: evil })
    check('外站 Origin 被拒', r1.status === 403, String(r1.status))

    const lockHandler = createHandlers(dir, () => ({ stage: 'no-pending' }))
    const r2 = await call(lockHandler.postLock, { method: 'POST', headers: { origin: 'https://evil.example' } })
    check('外站 Origin 不能触发锁定', r2.status === 403, String(r2.status))

    const r3 = await call(h.putConfig, {
      method: 'PUT',
      body: JSON.stringify({ autoLock: true }),
      headers: { 'content-type': 'text/plain' },
    })
    check('text/plain 被拒（CORS 简单请求可绕过预检）', r3.status === 415, String(r3.status))

    const r4 = await call(h.putConfig, {
      method: 'PUT',
      body: JSON.stringify({ autoLock: true }),
      headers: { origin: 'http://127.0.0.1:62448', 'content-type': 'application/json' },
    })
    check('本机 Origin 放行', r4.status === 200, String(r4.status))

    const r5 = await call(h.putConfig, { method: 'PUT', body: JSON.stringify({ autoLock: true }) })
    check('无 Origin 头（CLI/同源）放行', r5.status === 200, String(r5.status))
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

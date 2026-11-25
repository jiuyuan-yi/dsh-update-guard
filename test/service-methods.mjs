/**
 * Service-method tier.
 *
 * The service tier used to stop at the name: "webServer still exists" was
 * treated as "the plugin is fine". A renamed or removed method passes that test
 * and throws on the plugin's first call, so this tier records method shapes per
 * service and flags calls the target has no evidence for.
 *
 * Two rules keep it from becoming a false-alarm generator:
 *   - a method set must be non-empty to judge anything (empty = scanner got
 *     nothing, not "no methods"),
 *   - a method name mentioned anywhere in the runtime is not reported.
 */
import {
  serviceMethodsInText, serviceMethodUsageOf, unknownServiceMethods,
} from '../lib/services.mjs'

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

console.log('\n[1] 从宿主源码提取服务方法')
{
  const host = `
class WebServer extends Service {
  constructor (ctx) {
    super(ctx, 'webServer')
  }

  async register (entry) {
    if (this.stopped) { return false }
    for (const x of entry) { this.add(x) }
  }

  add (route) { this.routes.set(route.path, route) }

  static create (ctx) { return new WebServer(ctx) }

  get size () { return this.routes.size }

  notAMethod = () => true
}
`
  const r = serviceMethodsInText(host)
  check('识别服务名', r.services.includes('webServer'), r.services.join(','))
  check('提取普通方法 register', r.methods.includes('register'))
  check('提取普通方法 add', r.methods.includes('add'))
  check('提取 static 方法 create', r.methods.includes('create'))
  check('提取 getter size', r.methods.includes('size'))
  check('提取属性箭头函数 notAMethod', r.methods.includes('notAMethod'))
  check('不把 if 当方法', !r.methods.includes('if'))
  check('不把 for 当方法', !r.methods.includes('for'))
  check('不把 constructor 当公开方法', !r.methods.includes('constructor'), r.methods.join(','))
}

console.log('\n[2] 从插件源码提取调用点')
{
  const plugin = `
export const inject = ['webServer', 'slots']
const slots = ctx.get('slots')
slots.register({ name: 'x' })
ctx.webServer.register({ path: '/x' })
ctx.webServer.pruneStaleRoutes()
if (ctx.get('webServer')) { ctx.get('webServer').add({}) }
ctx.logger.warn('not a service method')
`
  const uses = serviceMethodUsageOf(plugin, ['webServer', 'slots', 'logger'])
  const keys = uses.map(u => u.service + '.' + u.method).sort()
  check('直接调用', keys.includes('webServer.register'), keys.join(','))
  check('ctx.get 调用', keys.includes('webServer.add'))
  check('别名调用', keys.includes('slots.register'))
  check('未知方法也记录', keys.includes('webServer.pruneStaleRoutes'))
  check('去重', keys.filter(k => k === 'webServer.register').length === 1)

  const filtered = serviceMethodUsageOf(plugin, ['webServer'])
  check('只保留已知服务', filtered.every(u => u.service === 'webServer'), filtered.map(u => u.service).join(','))
  check('未知服务不进入结果', !filtered.some(u => u.service === 'slots'))
}

console.log('\n[3] 判定：存在的方法不报，消失的方法才报')
{
  const host = `
class WebServer extends Service { constructor (ctx) { super(ctx, 'webServer') }
  register (e) {}
  add (r) {}
}
`
  const methods = {}
  for (const svc of serviceMethodsInText(host).services) {
    methods[svc] = serviceMethodsInText(host).methods
  }

  const uses = [
    { service: 'webServer', method: 'register' },
    { service: 'webServer', method: 'pruneStaleRoutes' },
  ]
  const unknown = unknownServiceMethods(uses, methods, [])
  check('只报丢失的那个', unknown.length === 1 && unknown[0].method === 'pruneStaleRoutes',
    unknown.map(u => u.method).join(','))

  const rescued = unknownServiceMethods(uses, methods, ['pruneStaleRoutes'])
  check('runtime 里出现过就不报', rescued.length === 0, rescued.map(u => u.method).join(','))

  const emptySet = unknownServiceMethods(uses, { webServer: [] }, [])
  check('方法集为空时不判', emptySet.length === 0, String(emptySet.length))

  const noService = unknownServiceMethods([{ service: 'ghostSvc', method: 'x' }], methods, [])
  check('未提取到该服务时不判', noService.length === 0)

  const many = Array.from({ length: 40 }, (_, i) => ({ service: 'webServer', method: 'gone' + i }))
  check('条数上限生效', unknownServiceMethods(many, methods, [], 20).length === 20)
}

console.log('\n[4] 不因为方法名撞词而误报')
{
  // `add` exists on webServer; a different service having `add` must not leak.
  const methods = { webServer: ['add', 'register'], store: ['get'] }
  const unknown = unknownServiceMethods([
    { service: 'store', method: 'add' },
    { service: 'store', method: 'get' },
  ], methods, [])
  check('按服务分别判定', unknown.length === 1 && unknown[0].service === 'store' && unknown[0].method === 'add',
    unknown.map(u => u.service + '.' + u.method).join(','))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

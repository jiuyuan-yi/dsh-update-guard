import { toolsInModule, parseParams, diffToolSurface } from '../lib/tool-surface.mjs'

let failures = 0
function check (label, condition, detail = '') {
  console.log(`${condition ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!condition) failures++
}

const mod = (body) => `ctx.tools.register(defineTool({${body}}))`

try {
  console.log('\n[1] 从模块源码提取工具')
  const src = mod(`
    name: "read",
    description: "Read a UTF-8 text file.",
    parameters: {
      file_path: { type: "string", description: "path" },
      offset: { type: "number", optional: true }
    },
    output: { schema: { content: { type: "string" } } }
  `) + mod(`
    name: "write",
    description: "Write a file.",
    parameters: {
      file_path: { type: "string" },
      content: { type: "string" }
    },
    output: { schema: { ok: { type: "boolean" } } }
  `)
  const tools = toolsInModule(src)
  check('提取到两个工具', tools.length === 2, String(tools.length))
  check('工具名正确', tools.map(t => t.name).join(',') === 'read,write', tools.map(t => t.name).join(','))
  check('保留描述', /UTF-8/.test(tools[0].description))

  console.log('\n[2] 参数名与结构键分离')
  const read = tools.find(t => t.name === 'read')
  check('参数含 file_path', read.params.names.includes('file_path'), read.params.names.join(','))
  check('参数含 offset', read.params.names.includes('offset'))
  check('不含 structural 键 parameters', !read.params.names.includes('parameters'))
  check('不含返回值字段 schema', !read.params.names.includes('schema'))
  check('不含返回值字段 output', !read.params.names.includes('output'))
  check('optional 标记被识别', read.params.optional.includes('offset'), read.params.optional.join(','))
  check('必填项不在 optional 里', !read.params.optional.includes('file_path'))

  console.log('\n[3] 无 defineTool 的模块')
  check('普通代码返回空', toolsInModule('export const x = 1').length === 0)
  check('无 parameters 时返回空参数', parseParams('name: "x"').names.length === 0)

  console.log('\n[4] 差异：工具被移除')
  const before = [
    { name: 'a', description: 'A', params: { names: ['p'], optional: [] }, module: 'm' },
    { name: 'b', description: 'B', params: { names: [], optional: [] }, module: 'm' }
  ]
  const droppedB = [before[0]]
  const d1 = diffToolSurface(before, droppedB)
  check('检测到移除', d1.removed.join(',') === 'b', d1.removed.join(','))
  check('移除算破坏性', d1.breaking === true)

  console.log('\n[5] 差异：参数丢失')
  const lostParam = [
    { name: 'a', description: 'A', params: { names: [], optional: [] }, module: 'm' }
  ]
  const d2 = diffToolSurface([before[0]], lostParam)
  check('检测到参数丢失', d2.changed[0].lostParams.join(',') === 'p')
  check('参数丢失算破坏性', d2.breaking === true)
  check('工具本身不算移除', d2.removed.length === 0)

  console.log('\n[6] 差异：可选项变必填')
  const nowRequired = [
    { name: 'a', description: 'A', params: { names: ['p'], optional: [] }, module: 'm' }
  ]
  const beforeOptional = [
    { name: 'a', description: 'A', params: { names: ['p'], optional: ['p'] }, module: 'm' }
  ]
  const d3 = diffToolSurface(beforeOptional, nowRequired)
  check('检测到变必填', d3.changed[0].newlyRequired.join(',') === 'p')
  check('变必填算破坏性', d3.breaking === true)

  console.log('\n[7] 差异：仅描述变化不算破坏性')
  const descChanged = [
    { name: 'a', description: 'A rewritten', params: { names: ['p'], optional: [] }, module: 'm' }
  ]
  const d4 = diffToolSurface([before[0]], descChanged)
  check('识别描述变化', d4.changed[0].descriptionChanged === true)
  check('描述变化不破坏调用', d4.breaking === false)

  console.log('\n[8] 差异：新增工具')
  const d5 = diffToolSurface(droppedB, before)
  check('检测到新增', d5.added.join(',') === 'b', d5.added.join(','))
  check('纯新增不算破坏性', d5.breaking === false)

  console.log('\n[9] 相同输入零差异')
  const d6 = diffToolSurface(before, before)
  check('无移除', d6.removed.length === 0)
  check('无新增', d6.added.length === 0)
  check('无变化', d6.changed.length === 0)
  check('不判破坏性', d6.breaking === false)
} catch (error) {
  console.log(`\n  FAIL  未捕获异常: ${error?.message ?? error}`)
  failures++
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`)
process.exit(failures === 0 ? 0 : 1)

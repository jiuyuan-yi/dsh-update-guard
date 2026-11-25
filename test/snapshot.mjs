/**
 * Surface-snapshot diff.
 *
 * The point of the snapshot tier is regression testing across versions without
 * keeping 200 MB archives. That only works if the diff is honest about what it
 * cannot see, and if it refuses to call an addition a breakage.
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { diffSnapshots, snapshotFileName, readSnapshot, buildSnapshot, SNAPSHOT_SCHEMA } from '../lib/snapshot.mjs'

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

function snap (over) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA,
    createdAt: '2026-01-01T00:00:00.000Z',
    dsh: { version: over.version ?? '0.0.1' },
    surface: { modules: over.modules ?? {} },
    services: { declared: over.services ?? [], methods: over.methods ?? {} },
    tools: over.tools ?? [],
  }
}

console.log('\n[1] 模块成员消失 = 破坏性')
{
  const a = snap({ modules: { '@deepseek-ai/dsh-client-ui-primitives': { members: ['Switch', 'Button'] } } })
  const b = snap({ modules: { '@deepseek-ai/dsh-client-ui-primitives': { members: ['Button'] } } })
  const d = diffSnapshots(a, b)
  check('抓到移除的成员', d.modules[0]?.removed.includes('Switch'), JSON.stringify(d.modules))
  check('判为破坏性', d.breaking === true)
}

console.log('\n[2] 只新增 = 不破坏')
{
  const a = snap({ modules: { '@deepseek-ai/dsh-client-ui-primitives': { members: ['Button'] } } })
  const b = snap({ modules: { '@deepseek-ai/dsh-client-ui-primitives': { members: ['Button', 'Switch'] } } })
  const d = diffSnapshots(a, b)
  check('记录新增', d.modules[0]?.added.includes('Switch'))
  check('不算破坏', d.breaking === false)
}

console.log('\n[3] 服务 / 方法消失 = 破坏性')
{
  const a = snap({
    services: ['webServer', 'session'],
    methods: { webServer: ['register', 'add'] },
  })
  const b = snap({
    services: ['webServer'],
    methods: { webServer: ['register'] },
  })
  const d = diffSnapshots(a, b)
  check('服务移除被记录', d.services.removed.includes('session'), JSON.stringify(d.services.removed))
  check('方法移除被记录', d.services.methods[0]?.removed.includes('add'), JSON.stringify(d.services.methods))
  check('判为破坏性', d.breaking === true)
}

console.log('\n[4] 工具参数从存在到消失 = 破坏性')
{
  const tool = (params, optional = []) => ({
    name: 'read',
    description: 'read',
    params: { names: params, optional },
  })
  const a = snap({ tools: [tool(['file_path', 'offset'], ['offset'])] })
  const b = snap({ tools: [tool(['file_path'])] })
  const d = diffSnapshots(a, b)
  check('参数消失被记录', d.tools.changed[0]?.lostParams.includes('offset'), JSON.stringify(d.tools.changed))
  check('判为破坏性', d.breaking === true)

  const c = snap({ tools: [tool(['file_path', 'limit'])] })
  const d2 = diffSnapshots(b, c)
  check('仅新增参数不破坏', d2.breaking === false, JSON.stringify(d2.tools.changed))
}

console.log('\n[5] 工具描述变化不算破坏')
{
  const a = snap({ tools: [{ name: 'read', description: 'old', params: { names: [], optional: [] } }] })
  const b = snap({ tools: [{ name: 'read', description: 'new', params: { names: [], optional: [] } }] })
  const d = diffSnapshots(a, b)
  check('记录描述变化', d.tools.changed[0]?.descriptionChanged === true)
  check('但不算破坏', d.breaking === false)
}

console.log('\n[6] 文件名与 schema 校验')
{
  check('版本进文件名', snapshotFileName({ dsh: { version: '0.2.2-rc.5' } }) === 'dsh-0.2.2-rc.5.json',
    snapshotFileName({ dsh: { version: '0.2.2-rc.5' } }))
  check('非法字符被替换', snapshotFileName({ dsh: { version: 'a/b c' } }) === 'dsh-a_b_c.json',
    snapshotFileName({ dsh: { version: 'a/b c' } }))

  const dir = mkdtempSync(join(tmpdir(), 'ug-snap-'))
  try {
    const good = join(dir, 'good.json')
    writeFileSync(good, JSON.stringify(snap({})))
    check('正常快照可读', readSnapshot(good).dsh.version === '0.0.1')

    const bad = join(dir, 'bad.json')
    writeFileSync(bad, JSON.stringify({ schemaVersion: 99 }))
    let threw = false
    try { readSnapshot(bad) } catch { threw = true }
    check('拒绝未知 schema', threw)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n[7] 真实归档导出（可选段）')
{
  const candidates = [
    process.env.DSH_ASAR,
    'D:/deep/resources/app.asar',
    'D:/deep/resources/app.asar.bak',
  ].filter(Boolean)
  const hit = candidates.find(p => { try { return existsSync(p) } catch { return false } })
  if (hit === undefined) {
    console.log('  （可选段跳过：没有找到 app.asar）')
  } else {
    try {
      const s = buildSnapshot(hit)
      check('快照含模块', s.counts.modules >= 3, String(s.counts.modules))
      check('快照含工具', s.counts.tools > 0, String(s.counts.tools))
      check('快照含服务', s.counts.services > 10, String(s.counts.services))
      check('版本非 unknown', s.dsh.version !== 'unknown', s.dsh.version)
      const self = diffSnapshots(s, s)
      check('自比对无变更', self.breaking === false && self.modules.length === 0)
    } catch (error) {
      check('真实导出不抛错', false, error instanceof Error ? error.message : String(error))
    }
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

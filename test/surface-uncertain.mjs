/**
 * A shell bundle whose module table is visible but whose export object cannot
 * be parsed must not be interpreted as exporting zero members. That is an
 * unknown result, not proof of incompatibility, and must never auto-lock.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { surfaceOf, TRACKED } from '../lib/surface.mjs'
import { analyse, lockFromAnalysis } from '../lib/run.mjs'

let failures = 0
function check (label, condition, detail = '') {
  console.log(`${condition ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!condition) failures++
}

const moduleName = '@deepseek-ai/dsh-client-store'
const bundle = `(()=>({"${moduleName}":a}))()`
const parsed = surfaceOf(bundle)
check('识别到模块表条目', parsed.modules[moduleName] !== undefined)
check('导出解析失败保留 none 信号', parsed.modules[moduleName]?.confidence === 'none')
check('不把未知导出伪装成已验证成员', Array.isArray(parsed.tracked[moduleName]) && parsed.tracked[moduleName].length === 0)

const dir = join(tmpdir(), `guard-surface-uncertain-${process.pid}`)
try {
  const pluginDir = join(dir, 'node_modules', 'probe-plugin')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'probe-plugin', version: '1.0.0' }))
  writeFileSync(join(pluginDir, 'index.js'), `const Store = require('${moduleName}');\nStore.useCurrentProfile();\n`)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['probe-plugin'] } } }))
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: probe-plugin\n  disabled: false\n')

  const report = analyse({
    profileDir: dir,
    cacheRoot: join(dir, 'cache'),
    surface: parsed.tracked,
    surfaceModules: parsed,
    version: '0.3.6',
  })
  const finding = report.findings.find(f => f.plugin === 'probe-plugin')
  check('未知模块形成待确认记录', finding?.unverified?.some(x => x.moduleName === moduleName))
  check('未知模块不生成 broken', finding?.broken?.length === 0, JSON.stringify(finding?.broken ?? []))
  check('报告明确列出未验证模块', report.surfaceUnverifiedModules?.includes(moduleName))
  const lock = lockFromAnalysis(report)
  check('未知模块不会触发自动锁定', lock.locked.length === 0, JSON.stringify(lock))
  check('profile 补丁保持不变', readFileSync(join(dir, 'cordis.patch.yml'), 'utf8') === '- id: probe-plugin\n  disabled: false\n')

  const emptyTable = surfaceOf('(()=>({}))()')
  check('空模块表保留可降级条件', emptyTable.tableSize === 0 && TRACKED.length === 4)
  const emptyReport = analyse({
    profileDir: dir,
    cacheRoot: join(dir, 'cache-empty-table'),
    surface: emptyTable.tracked,
    surfaceModules: emptyTable,
    version: '0.3.6',
  })
  const emptyFinding = emptyReport.findings.find(f => f.plugin === 'probe-plugin')
  check('模块表整体解析失败时不误报缺失成员', emptyFinding?.broken?.length === 0)
  check('模块表整体解析失败时明确标记待验证', TRACKED.every(name => emptyReport.surfaceUnverifiedModules.includes(name)))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

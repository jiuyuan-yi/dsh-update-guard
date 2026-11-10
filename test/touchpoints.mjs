import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanPlugin, riskOf, scanAll, TOUCHPOINTS } from '../lib/touchpoints.mjs'

let failures = 0
function check (label, condition, detail = '') {
  console.log(`${condition ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!condition) failures++
}

const root = mkdtempSync(join(tmpdir(), `guard-touch-${process.pid}-`))
const write = (rel, text) => {
  const full = join(root, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text)
}
const slugsOf = classes => classes.map(c => c.slug)

try {
  console.log('\n[1] 空目录与无匹配')
  const empty = join(root, 'empty')
  mkdirSync(empty, { recursive: true })
  check('空目录返回空数组', scanPlugin(empty).length === 0)

  const clean = join(root, 'clean')
  write('clean/index.js', 'export function hello () { return 1 }\n')
  const cleanHits = scanPlugin(clean)
  check('普通插件零命中', cleanHits.length === 0, JSON.stringify(slugsOf(cleanHits)))
  check('零命中判 none', riskOf(cleanHits).band === 'none')

  console.log('\n[2] 类识别')
  const patcher = join(root, 'patcher')
  write('patcher/lib/patch.js', [
    "import { writeFileSync } from 'node:fs'",
    "writeFileSync(join(root, 'app.asar'), buf)",
    "writeFileSync(join(other, 'app.asar'), buf2)",
    'const engine = createPatchEngine({ aiBase })'
  ].join('\n'))
  const patchHits = scanPlugin(patcher)
  check('识别 source-patch', slugsOf(patchHits).includes('source-patch'), JSON.stringify(slugsOf(patchHits)))
  check('source-patch 命中至少 3 次', (patchHits.find(c => c.slug === 'source-patch')?.hits ?? 0) >= 3)

  const chan = join(root, 'chan')
  write('chan/index.js', [
    'const s = createServer()',
    'new WebSocket(url)',
    'new MutationObserver(cb)',
    'sheet.insertRule(rule)'
  ].join('\n'))
  const chanHits = scanPlugin(chan)
  check('识别 custom-channel', slugsOf(chanHits).includes('custom-channel'), JSON.stringify(slugsOf(chanHits)))

  console.log('\n[3] 注释与文档不该算作依赖')
  const noisy = join(root, 'noisy')
  write('noisy/index.js', [
    '// This plugin deliberately does NOT writeFileSync(...app.asar...) or monkey patch anything.',
    '// It never calls APIProxy either.',
    'export const ok = true'
  ].join('\n'))
  const noisyHits = scanPlugin(noisy)
  check('注释里的 app.asar 不命中 source-patch', !slugsOf(noisyHits).includes('source-patch'), JSON.stringify(slugsOf(noisyHits)))

  console.log('\n[4] 单次命中不算「已触及」')
  const once = join(root, 'once')
  write('once/index.js', 'export const n = "APIProxy"\n')
  const onceHits = scanPlugin(once)
  const onceBand = riskOf(onceHits).band
  check('单次命中降级到 low', onceBand === 'low', onceBand)
  check('单次命中 reason 说明只是提到', /named only/.test(riskOf(onceHits).reason))

  console.log('\n[5] 多次触及内部服务 → medium 或更高')
  const heavy = join(root, 'heavy')
  write('heavy/index.js', 'const a = APIProxy\nconst b = APIProxy\nconst c = ctx.remote\n')
  const heavyHits = scanPlugin(heavy)
  const heavyBand = riskOf(heavyHits).band
  check('两次命中不判 none', heavyBand !== 'none', heavyBand)
  check('单类 heavy 只在 medium 档', heavyBand === 'medium', heavyBand)

  console.log('\n[6] 三个 heavy 类 → high')
  const three = join(root, 'three')
  write('three/a.js', 'APIProxy APIProxy\n')
  write('three/b.js', 'SessionEvent\nsession/turn\n')
  write('three/c.js', 'writeFileSync(join(x,"app.asar"), y)\nwriteFileSync(join(z,"app.asar"), w)\n')
  const threeBand = riskOf(scanPlugin(three)).band
  check('多面耦合判 high', threeBand === 'high', threeBand)

  console.log('\n[7] 跳过 node_modules')
  const skip = join(root, 'skip')
  write('skip/index.js', 'export const ok = 1\n')
  write('skip/node_modules/dep/big.js', 'APIProxy APIProxy APIProxy createServer() WebSocket\n')
  const skipHits = scanPlugin(skip)
  check('node_modules 内的文件不参与扫描', skipHits.length === 0, JSON.stringify(slugsOf(skipHits)))

  console.log('\n[8] 批量入口保持排序与结构')
  const rows = scanAll([
    { name: 'b-low', version: '1.0.0', dir: clean },
    { name: 'a-high', version: '2.0.0', dir: three }
  ])
  check('返回两行', rows.length === 2)
  check('high 排在前面', rows[0].risk.band === 'high', rows[0].name)
  check('保留 version', rows[0].version === '2.0.0')
  check('每行都带 risk.reason', rows.every(r => typeof r.risk.reason === 'string' && r.risk.reason.length > 0))

  console.log('\n[9] 分类表自身完整性')
  check('七类触点', TOUCHPOINTS.length === 7, String(TOUCHPOINTS.length))
  check('每类都有 slug/weight/patterns', TOUCHPOINTS.every(c => c.slug && c.weight > 0 && c.patterns.length > 0))
  check('slug 唯一', new Set(TOUCHPOINTS.map(c => c.slug)).size === TOUCHPOINTS.length)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`)
process.exit(failures === 0 ? 0 : 1)

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFeedConfig, parseFeedYaml, versionDistance } from '../lib/feed.mjs'

let failures = 0
function check (label, condition, detail = '') {
  console.log(`${condition ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!condition) failures++
}

const root = mkdtempSync(join(tmpdir(), `guard-feed-${process.pid}-`))

try {
  console.log('\n[1] 解析 app-update.yml')
  mkdirSync(join(root, 'resources'), { recursive: true })
  writeFileSync(join(root, 'resources', 'app-update.yml'), [
    'provider: generic',
    'url: https://download.deepseek.com/dsh-desk/feeds/win-x64/',
    'channel: nightly',
    'updaterCacheDirName: "@deepseek-aidsh-desktop-updater"',
    'publisherName:',
    '  - CN=Something'
  ].join('\n'))
  const cfg = readFeedConfig(root)
  check('读到 url', cfg?.url === 'https://download.deepseek.com/dsh-desk/feeds/win-x64/', String(cfg?.url))
  check('读到 channel', cfg?.channel === 'nightly', String(cfg?.channel))
  check('provider 正确', cfg?.provider === 'generic')

  console.log('\n[2] 缺失与不可读')
  check('不存在的根目录返回 null', readFeedConfig('Z:/nope') === null)
  check('空路径返回 null', readFeedConfig('') === null)
  const noFile = mkdtempSync(join(tmpdir(), 'guard-feed-empty-'))
  check('没有 app-update.yml 返回 null', readFeedConfig(noFile) === null)
  rmSync(noFile, { recursive: true, force: true })

  console.log('\n[3] 解析 feed YAML')
  const real = [
    'version: 0.2.2-rc.3',
    'files:',
    '  - url: >-',
    '      https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.3-win-x64.exe',
    '    size: 299595752',
    '    sha512: >-',
    '      GiJf8kx+C7eoiZ0xQSYBcTyh5xmXQl+vh63U6uSm963McK1AkMgB8PydzuekWdUY7hyURvhVMHANM4pn+tCKzQ==',
    'path: >-',
    '  deepseek-harness-0.2.2-rc.3-win-x64.exe',
    'releaseDate: 2026-11-13T07:31:42.937Z'
  ].join('\n')
  const parsed = parseFeedYaml(real)
  check('版本号', parsed.version === '0.2.2-rc.3', String(parsed.version))
  check('文件 URL', /deepseek-harness-0\.2\.2-rc\.3-win-x64\.exe$/.test(parsed.fileUrl ?? ''), String(parsed.fileUrl).slice(0, 60))
  check('大小', parsed.size === 299595752, String(parsed.size))
  check('sha512', /^GiJf8kx/.test(parsed.sha512 ?? ''))
  check('发布日期', /2026-11-13/.test(parsed.releaseDate ?? ''))

  console.log('\n[4] 解析异常输入')
  check('空文档无版本', parseFeedYaml('').version === undefined)
  check('无 version 行', parseFeedYaml('files:\n  - url: x').version === undefined)

  console.log('\n[5] 版本跨度')
  const cases = [
    // Semver reads left to right: 0.2.1 → 0.2.2 moves the third field, so it is
    // a patch even though the numbers look "one apart" at a glance.
    ['0.2.1-rc.5', '0.2.2-rc.3', 'patch'],
    ['0.2.9', '0.3.0', 'minor'],
    ['0.2.2-rc.1', '0.2.2-rc.3', 'prerelease'],
    ['0.2.2', '0.2.3', 'patch'],
    ['1.0.0', '2.0.0', 'major'],
    ['0.2.2-rc.3', '0.2.2-rc.3', 'same']
  ]
  for (const [a, b, want] of cases) {
    const d = versionDistance(a, b)
    check(`${a} → ${b} 判 ${want}`, d.kind === want, d.kind)
  }
  check('无法解析时给 unknown', versionDistance('nonsense', '1.0.0').kind === 'unknown')
  check('跨度带可读标签', /rc\.1 → rc\.3/.test(versionDistance('0.2.2-rc.1', '0.2.2-rc.3').label))
} catch (error) {
  console.log(`\n  FAIL  未捕获异常: ${error?.message ?? error}`)
  failures++
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`)
process.exit(failures === 0 ? 0 : 1)

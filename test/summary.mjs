/**
 * Panel wording tests.
 *
 * The rule the panel must never break: an incomplete check is not a pass.
 * Loading a green sentence after a skipped API comparison is worse than
 * showing nothing, because it answers a question nobody actually asked.
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

const registered = []
const run = new Function('window', 'document', 'console', code)
run(
  { __ModuleLoader__: { load: r => registered.push(r) } },
  { querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild () {} } },
  { warn () {}, log () {} },
)

const stubRequire = () => ({
  createElement: () => null,
  useState: v => [v, () => {}],
  useEffect: () => {},
  Switch: () => null,
})
const exports = registered[0].factory(stubRequire)
const summarize = exports.__test?.summarize
check('暴露了 summarize', typeof summarize === 'function')

console.log('\n[1] 完整检查通过')
{
  const t = summarize({ stage: 'analysed', tier: 'declared+surface', checkedPlugins: 15, clientChecked: 2, findings: [] })
  check('说是完整检查', /完整检查/.test(t), t)
  check('含插件数', /15/.test(t), t)
  check('不出现"部分"', !/部分/.test(t), t)
}

console.log('\n[2] 只做了版本声明 —— 不能说通过')
{
  const t = summarize({ stage: 'analysed', tier: 'declared-only', note: 'no-extractor', checkedPlugins: 15, findings: [] })
  check('说是部分检查', /部分检查/.test(t), t)
  check('点明原因', /解压器/.test(t), t)
  check('不出现"没有发现不兼容"', !/没有发现不兼容/.test(t), t)
}

console.log('\n[3] 解包失败也是部分检查')
{
  const t = summarize({ stage: 'analysed', tier: 'declared-only', note: 'extract-failed', checkedPlugins: 15, findings: [] })
  check('点明解包失败', /解包失败/.test(t), t)
  check('仍是部分', /部分/.test(t), t)
}

console.log('\n[4] 有发现时说风险并点名')
{
  const t = summarize({ stage: 'analysed', tier: 'declared+surface', checkedPlugins: 3, clientChecked: 1, findings: [{ plugin: 'alpha' }, { plugin: 'beta' }] })
  check('说是发现风险', /发现风险/.test(t), t)
  check('点名两个插件', /alpha/.test(t) && /beta/.test(t), t)
}

console.log('\n[5] 没有待装更新')
{
  const t = summarize({ stage: 'no-pending' })
  check('明确说没有更新', /没有待安装的更新/.test(t), t)
  check('不声称检查通过', !/通过|没有发现不兼容/.test(t), t)
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

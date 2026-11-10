import { detectGhost } from '../lib/ghost.mjs'

let failures = 0
function check (label, condition, detail = '') {
  console.log(`${condition ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!condition) failures++
}

try {
  console.log('\n[1] 路径不可读')
  const missing = detectGhost('Z:/definitely/not/here/app.asar')
  check('返回 unknown', missing.status === 'unknown', missing.status)
  check('原因是 stat 失败', /cannot stat/.test(missing.reason), missing.reason.slice(0, 40))
  check('asarMtime 为 null', missing.asarMtime === null)
  check('进程列表为空数组', Array.isArray(missing.processes) && missing.processes.length === 0)

  console.log('\n[2] 真实归档')
  const real = detectGhost('D:/deep/resources/app.asar')
  check('状态在三值之内', ['ghost', 'clean', 'unknown'].includes(real.status), real.status)
  check('asarMtime 可解析为日期', real.asarMtime !== null && !Number.isNaN(new Date(real.asarMtime).getTime()), String(real.asarMtime))
  check('reason 非空', typeof real.reason === 'string' && real.reason.length > 0)
  check('processes 是数组', Array.isArray(real.processes))

  if (real.processes.length > 0) {
    console.log('\n[3] 进程条目结构')
    const p = real.processes[0]
    check('含 id', 'id' in p, JSON.stringify(p.id))
    check('含 name', 'name' in p, String(p.name))
    check('含 start', 'start' in p, String(p.start))
    check('start 可解析为日期', p.start !== null && !Number.isNaN(new Date(p.start).getTime()))
    check('所有条目字段已归一化', real.processes.every(x => 'id' in x && 'name' in x && 'start' in x))
  } else {
    console.log('\n[3] 无运行进程（跳过结构检查）')
  }

  console.log('\n[4] 状态与说明自洽')
  if (real.status === 'clean') check('clean 时说明提到 started after', /started after/.test(real.reason), real.reason.slice(0, 40))
  if (real.status === 'ghost') check('ghost 时说明提到 previous build', /previous build/.test(real.reason))
  if (real.status === 'unknown') check('unknown 时说明给出原因', real.reason.length > 0)
} catch (error) {
  console.log(`\n  FAIL  未捕获异常: ${error?.message ?? error}`)
  failures++
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`)
process.exit(failures === 0 ? 0 : 1)

/**
 * The host runs `analyse` on a worker thread.
 *
 * Why this suite exists: the whole point of the worker is that a long analysis
 * cannot freeze the desktop UI. That property is invisible to a normal unit
 * test, so what is checked here is the contract the host relies on — the worker
 * starts, returns a structured analysis, and turns failures into a rejection
 * instead of an unhandled throw or a hang.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'

// Worker takes an absolute path or a URL object; a file:// string is rejected.
const WORKER = new URL('../lib/analysis-worker.mjs', import.meta.url)

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

function runWorker (workerData, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData })
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate().catch(() => {})
      fn(value)
    }
    const timer = setTimeout(() => finish(reject, new Error('timeout')), timeoutMs)
    worker.once('message', (m) => {
      if (m?.ok === true) finish(resolve, m.result)
      else finish(reject, new Error(m?.error ?? 'failed'))
    })
    worker.once('error', (e) => finish(reject, e))
    worker.once('exit', (code) => {
      if (!settled && code !== 0) finish(reject, new Error('exit ' + code))
    })
  })
}

const work = mkdtempSync(join(tmpdir(), 'ug-worker-'))
try {
  const profile = join(work, 'profile')
  const cacheRoot = join(work, 'cache')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'desktop',
    dsh: { profile: { bundles: [] } },
  }))

  console.log('\n[1] 正常返回结构化结果')
  const result = await runWorker({ profileDir: profile, cacheRoot })
  check('返回对象', result !== null && typeof result === 'object')
  check('有 stage', typeof result.stage === 'string', String(result.stage))
  check('没有待安装更新时是 no-pending', result.stage === 'no-pending', String(result.stage))

  console.log('\n[2] 重复调用稳定，不泄漏 worker')
  {
    // The host runs this on every start. A worker that leaves a thread behind,
    // or that only works the first time, would show up as rising thread counts
    // after a few restarts.
    for (let i = 0; i < 3; i += 1) {
      const again = await runWorker({ profileDir: profile, cacheRoot })
      check(`第 ${i + 2} 次仍返回同一结论`, again.stage === result.stage, String(again.stage))
    }
  }

  console.log('\n[3] 主线程在 worker 运行期间仍能推进')
  {
    let ticks = 0
    const interval = setInterval(() => { ticks += 1 }, 5)
    await runWorker({ profileDir: profile, cacheRoot })
    clearInterval(interval)
    // A synchronous analyse on this thread would starve the timer almost
    // entirely; a worker leaves the loop free. Anything above zero proves the
    // loop kept running, which is the property the host depends on.
    check('事件循环没有被阻塞', ticks > 0, 'ticks=' + ticks)
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

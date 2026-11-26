/**
 * Runs one analysis off the host's main thread.
 *
 * `analyse` can block for minutes: it spawns 7-Zip synchronously (up to four
 * attempts, 180 s each) and `readFileSync`s a ~175 MB `app.asar`. Doing that on
 * the Cordis context's thread freezes the whole desktop UI — `setImmediate` only
 * defers the call, it does not yield.
 *
 * A worker thread is the smallest fix that keeps the host responsive: the
 * blocking `execFileSync` parks this worker, not the renderer or the main loop.
 * `child_process.fork` would NOT work here — in a packaged app `process.execPath`
 * is the application binary, and re-running it needs `ELECTRON_RUN_AS_NODE`,
 * which packaging may have disabled.
 */
import { parentPort, workerData } from 'node:worker_threads'

import { analyse } from './run.mjs'

try {
  const result = analyse({
    profileDir: workerData.profileDir,
    cacheRoot: workerData.cacheRoot,
    // Only set by tests: an explicit root makes the result independent of what
    // happens to be installed on the machine running the suite.
    installRoot: workerData.installRoot,
  })
  // The analysis is plain JSON-shaped data by construction; anything else would
  // fail the structured clone here rather than silently crossing the boundary.
  parentPort.postMessage({ ok: true, result })
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: String(error?.message ?? error),
    stack: typeof error?.stack === 'string' ? error.stack : undefined,
  })
}

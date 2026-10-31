/**
 * Host half of dsh-update-guard.
 *
 * What it does: when an update has been DOWNLOADED but not installed, compare
 * the new version's shared-client-module surface against the plugins actually
 * installed, and record the result. With `autoLock` enabled it can also disable
 * exactly the plugin entry ids that would break.
 *
 * What it never does:
 *   - never blocks, delays, or rolls back an update
 *   - never touches `resources/` or the installer
 *   - never throws into the Cordis context that loaded it
 *
 * The startup hook is deliberately late and cheap: a pending update usually
 * does not exist, and in that case this plugin costs one directory stat.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  analyse, lockFromAnalysis, readConfig, saveReport, defaultProfileDir,
} from './run.mjs'
import { ensureLauncher } from './launcher.mjs'
import { registerRoutes } from './routes.mjs'

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const CACHE_ROOT = join(PKG_DIR, '.cache')

/** Delay before the background check so it never competes with startup. */
const STARTUP_DELAY_MS = 4000

export const name = 'update-guard'

export function apply (ctx) {
  // Nothing in this plugin may propagate a throw: a failing guard must leave
  // DSH exactly as it shipped.
  let timer
  try {
    const config = readConfigSafe(ctx)

    const runOnce = () => {
      setImmediate(() => {
        try {
          checkInBackground(ctx, config)
        } catch (error) {
          logWarn(ctx, 'background check failed: ' + describe(error))
        }
      })
    }

    if (config.preflightOnStartup !== false) {
      timer = setTimeout(runOnce, STARTUP_DELAY_MS)
      if (typeof timer.unref === 'function') timer.unref()
    }

    // Second leg: while we are healthy, install the launch wrapper that can
    // repair a broken profile when this plugin cannot run at all.
    //
    // Deliberately do NOT pass exePath: the same code runs from the CLI, where
    // `process.execPath` is node.exe, and a launcher built around node.exe exits
    // instantly — which then reads as "startup failed" and drops the profile to
    // the official core. `ensureLauncher` resolves the real app from the install
    // root and refuses to adopt node/wscript/powershell as the target.
    if (config.installLauncher === true) {
      const launcher = ensureLauncher({
        profileDir: defaultProfileDir(),
        pkgDir: PKG_DIR,
      })
      if (launcher.ok) {
        logInfo(ctx, '启动器已就绪 (' + (launcher.cmd ?? '') + ')')
      } else {
        logWarn(ctx, '启动器未生成（不影响使用）: ' + (launcher.reason ?? 'unknown'))
      }
    }

    // Settings panel backend. Registered lazily: if no web server exists (CLI
    // host), the plugin still works, just without the panel.
    try {
      ctx.inject(['webServer'], (webCtx) => {
        try {
          const dispose = registerRoutes(webCtx.webServer, defaultProfileDir(), readLastReport)
          webCtx.effect(() => dispose, 'update-guard: settings routes')

          // Read-only self-check: did our client half make it into the boot
          // graph? Answering that from outside normally needs the page token,
          // and this route is the difference between "the panel is missing" and
          // "the panel is broken" without guessing.
          webCtx.webServer.register({
            kind: 'exact',
            path: '/dsh-update-guard/diag.json',
            handler: (req, res) => {
              let graph
              try { graph = ctx.get('clientModules')?.graph?.() } catch { graph = undefined }
              const ids = []
              if (graph && Array.isArray(graph.batches)) {
                for (const batch of graph.batches) {
                  if (Array.isArray(batch.entries)) ids.push(...batch.entries)
                }
              }
              const body = JSON.stringify({
                ok: true,
                plugin: 'dsh-update-guard',
                clientDeclared: true,
                clientInGraph: ids.includes('dsh-update-guard'),
                graphEntries: ids.length,
              })
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(body)
            },
          })
        } catch (error) {
          logWarn(ctx, '面板路由未注册: ' + describe(error))
        }
      })
    } catch (error) {
      logWarn(ctx, '面板路由未注册: ' + describe(error))
    }

    ctx.effect(() => () => {
      if (timer !== undefined) clearTimeout(timer)
    }, 'update-guard: startup check')

    logInfo(ctx, 'update-guard 已加载（更新前兼容性检查）')
  } catch (error) {
    try { logWarn(ctx, 'update-guard 未启用: ' + describe(error)) } catch { /* ignore */ }
  }
}

/** Newest cached analysis, for the panel. Never throws. */
function readLastReport () {
  try {
    const p = join(CACHE_ROOT, 'last-report.json')
    if (!existsSync(p)) return undefined
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return undefined
  }
}

function readConfigSafe (ctx) {
  try {
    return readConfig(defaultProfileDir())
  } catch (error) {
    logWarn(ctx, 'read config failed: ' + describe(error))
    return { preflightOnStartup: false, autoLock: false, maxAutoLock: 3 }
  }
}

/**
 * One background pass. Every outcome is a log line, never a throw.
 */
function checkInBackground (ctx, config) {
  const profileDir = defaultProfileDir()
  const analysis = analyse({ profileDir, cacheRoot: CACHE_ROOT })

  if (analysis.stage === 'no-pending') return          // the common case: silent
  if (analysis.stage === 'error') {
    logWarn(ctx, `更新前检查未能完成（${analysis.reason}）`)
    return
  }

  saveReport(CACHE_ROOT, analysis)

  const findings = analysis.findings
  if (findings.length === 0) {
    logInfo(ctx, `待安装更新 ${analysis.version ?? ''}：已装 ${analysis.checkedPlugins} 个插件全部兼容`)
    return
  }

  const names = findings.map(f => f.plugin).join(', ')
  if (config.autoLock === true) {
    const limit = Number.isFinite(config.maxAutoLock) ? Math.max(1, config.maxAutoLock) : 3
    if (findings.length > limit) {
      // Several at once is far more likely a measurement problem than a real
      // mass breakage; report and leave the profile alone.
      logWarn(ctx, `检测到 ${findings.length} 个插件不兼容（${names}），超过自动处理上限 ${limit}，仅报告未改动`)
      return
    }
    try {
      const result = lockFromAnalysis(analysis, limit)
      logInfo(ctx, `已自动锁定 ${result.locked.length} 个配置项，涉及：${names}。其余插件不受影响，可在设置里撤销`)
    } catch (error) {
      logWarn(ctx, '自动锁定失败，插件配置未改动: ' + describe(error))
    }
    return
  }

  logWarn(ctx, `待安装更新 ${analysis.version ?? ''} 会让 ${findings.length} 个插件失效：${names}。运行 dsh-update-guard lock 可只锁定它们`)
}

function describe (error) {
  return error instanceof Error ? error.message : String(error)
}

function logInfo (ctx, message) {
  try { ctx.logger?.info?.(message) } catch { /* ignore */ }
}

function logWarn (ctx, message) {
  try { ctx.logger?.warn?.(message) } catch { /* ignore */ }
}

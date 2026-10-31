/**
 * Explain the automatic-restore decision.
 *
 * The restore condition is a chain: a recorded observation, a time link, a patch
 * comparison, a usable backup, and the switch itself. When it declines to act in
 * a real environment, "it didn't restore" is useless — the question is which
 * link failed. This prints every link with its actual values.
 *
 * It reads the same files the launcher reads and changes nothing. It does not
 * import the launcher's PowerShell logic; it re-derives the conditions, so a
 * divergence between the two would show up as a disagreement worth fixing.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { readConfig } from './run.mjs'

const SEEN = '.dsh-update-guard-lastseen.json'

function readJsonSafe (path) {
  try {
    const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function mtime (path) {
  try { return statSync(path).mtimeMs } catch { return undefined }
}

function size (path) {
  try { return statSync(path).size } catch { return undefined }
}

function listBackups (dir, prefix) {
  try {
    return readdirSync(dir)
      .filter(f => f.startsWith(prefix))
      .map(f => ({ name: f, path: join(dir, f), mtime: mtime(join(dir, f)) ?? 0 }))
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}

/**
 * @param {string} profileDir
 * @returns {{conditions: object[], ok: boolean, note?: string}}
 */
export function diagnoseRestore (profileDir) {
  const pkgPath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')

  const manifest = readJsonSafe(pkgPath)
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const thirdNow = bundles.filter(b => b && !b.startsWith('@deepseek-ai/'))

  const seen = readJsonSafe(join(profileDir, SEEN))
  const recorded = Array.isArray(seen?.lastWithThirdParty)
    ? seen.lastWithThirdParty.filter(b => b && !b.startsWith('@deepseek-ai/'))
    : []

  const seenAtRaw = seen?.lastWithThirdPartyAt
  const seenAt = typeof seenAtRaw === 'string' ? Date.parse(seenAtRaw) : NaN
  const seenAtOk = Number.isFinite(seenAt)

  const patchNow = size(patchPath)
  const patchRenamed = seenAtOk
    ? listBackups(profileDir, 'cordis.patch.yml.bak-').filter(b => b.mtime >= seenAt)
    : []

  const seenPatch = typeof seen?.lastPatchSize === 'number' ? seen.lastPatchSize : undefined
  const shrunk = patchNow === undefined
    ? true
    : (seenPatch !== undefined && patchNow < seenPatch)

  const cfgBackups = listBackups(profileDir, 'package.json.bak-')
  const withThird = cfgBackups.filter(b => {
    const m = readJsonSafe(b.path)
    const list = Array.isArray(m?.dsh?.profile?.bundles) ? m.dsh.profile.bundles : []
    return list.some(n => n && !n.startsWith('@deepseek-ai/'))
  })

  const autoOn = readConfig(profileDir).autoRestore === true

  const conditions = [
    { key: 'no-third-party-now', label: '当前没有第三方插件', pass: thirdNow.length === 0, detail: `${thirdNow.length} 个第三方：${thirdNow.join(', ') || '无'}` },
    { key: 'has-record', label: '存在上次记录', pass: seen !== undefined, detail: seen === undefined ? `缺少 ${SEEN}` : String(seen.at ?? '(无 at)') },
    { key: 'record-had-third', label: '上次记录里有第三方', pass: recorded.length > 0, detail: `${recorded.length} 个：${recorded.join(', ') || '无'}` },
    { key: 'has-observed-at', label: '有最后看到第三方的时刻', pass: seenAtOk, detail: seenAtOk ? new Date(seenAt).toISOString() : '缺失或无法解析' },
    { key: 'patch-renamed', label: '本次有补丁改名备份', pass: patchRenamed.length > 0, detail: `${patchRenamed.length} 份晚于该时刻${patchRenamed.length ? '（' + patchRenamed[0].name + '）' : ''}` },
    { key: 'patch-shrunk', label: '补丁比记录时更小', pass: shrunk, detail: `${seenPatch ?? '(未记录)'} -> ${patchNow ?? '(不存在)'} 字节` },
    { key: 'backup-with-third', label: '存在含第三方的配置备份', pass: withThird.length > 0, detail: `${withThird.length} 份${withThird.length ? '（' + withThird[0].name + '）' : ''}` },
    { key: 'switch-on', label: 'autoRestore 已开启', pass: autoOn, detail: String(autoOn) },
  ]

  const firstFail = conditions.find(c => !c.pass)
  return {
    conditions,
    ok: firstFail === undefined,
    note: firstFail === undefined
      ? '全部条件成立：此时启动会自动还原'
      : `卡在「${firstFail.label}」：${firstFail.detail}`,
  }
}

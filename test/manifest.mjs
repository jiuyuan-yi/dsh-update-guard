/**
 * Offline replication of the loader's `dsh.client` validation.
 *
 * The client-module registry rejects a whole boot when a declared client bundle
 * is malformed, so a typo here takes the app down. These rules are copied from
 * `dsh-client-modules`: field types are checked, and `exports["./client"]` must
 * resolve — the file's *content* is not inspected at this stage.
 *
 * Running this before touching package.json is the only way to know the change
 * is safe without restarting the app.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const manifestPath = join(PKG, 'package.json')

let failures = 0
function check (label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

function optionalStringArray (subject, field, value) {
  if (value === undefined) return
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${subject} ${field} must be a string array`)
  }
}

function parseDshClient (pkgName, value) {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) throw new Error(`${pkgName} has a non-object dsh.client`)
  if (typeof value.platform !== 'string') throw new Error(`${pkgName} dsh.client.platform must be a string`)
  optionalStringArray(pkgName, 'dsh.client.inject', value.inject)
  optionalStringArray(pkgName, 'dsh.client.external', value.external)
  if (value.immediately !== undefined && typeof value.immediately !== 'boolean') {
    throw new Error(`${pkgName} dsh.client.immediately must be a boolean`)
  }
  return value
}

function clientExportOf (pkgName, exportsField) {
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const client = exportsField['./client']
  if (client === undefined) return undefined
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null && typeof client.default === 'string') return client.default
  throw new Error(`${pkgName} exports["./client"] must be a string or an object with a string default`)
}

console.log('\n[1] 读取清单')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
check('package.json 可解析', true)
check('有 dsh 字段', manifest.dsh !== undefined && typeof manifest.dsh === 'object')
check('有 bundle.patch', typeof manifest.dsh?.bundle?.patch === 'string', String(manifest.dsh?.bundle?.patch))

console.log('\n[2] dsh.client 校验（加载器的规则）')
let decl
try {
  decl = parseDshClient(manifest.name, manifest.dsh?.client)
  check('解析不抛', true)
} catch (error) {
  check('解析不抛', false, error.message)
}

if (decl === undefined) {
  console.log('  --  没有声明 dsh.client：这款插件不会有浏览器半侧')
} else {
  check('platform 是 web', decl.platform === 'web', String(decl.platform))
  check('immediately 是布尔（若声明）', decl.immediately === undefined || typeof decl.immediately === 'boolean')
  let rel
  try {
    rel = clientExportOf(manifest.name, manifest.exports)
    check('exports["./client"] 可解析', rel !== undefined, String(rel))
  } catch (error) {
    check('exports["./client"] 可解析', false, error.message)
  }
  if (rel !== undefined) {
    const abs = join(PKG, rel)
    check('客户端文件真实存在', existsSync(abs), abs)
  }
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openAsar, asarText } from '../lib/asar.mjs'

let failures = 0
function check (label, condition, detail = '') {
  console.log(`${condition ? '  PASS' : '  FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!condition) failures++
}
function makeAsar (entry, content = 'hello') {
  const json = Buffer.from(JSON.stringify({ files: { [entry]: { size: Buffer.byteLength(content), offset: '0' } } }), 'utf8')
  const payloadSize = 8 + json.length
  const dataStart = 8 + payloadSize
  const out = Buffer.alloc(dataStart + Buffer.byteLength(content))
  out.writeUInt32LE(payloadSize, 4)
  out.writeUInt32LE(payloadSize, 8)
  out.writeUInt32LE(json.length, 12)
  json.copy(out, 16)
  out.write(content, dataStart, 'utf8')
  return out
}

const dir = mkdtempSync(join(tmpdir(), `guard-asar-${process.pid}-`))
try {
  console.log('\n[1] 合法归档')
  const valid = join(dir, 'valid.asar')
  writeFileSync(valid, makeAsar('package.json', '{"version":"1.0.0"}'))
  check('可读取合法文件', asarText(valid, /^package\.json$/)?.text === '{"version":"1.0.0"}')
  check('目录查找返回正确大小', openAsar(valid).find(/^package\.json$/)?.size === Buffer.byteLength('{\"version\":\"1.0.0\"}'))

  console.log('\n[2] 非法边界')
  const short = join(dir, 'short.asar')
  writeFileSync(short, Buffer.alloc(12))
  let shortThrew = false
  try { openAsar(short) } catch (error) { shortThrew = /truncated/.test(error.message) }
  check('截断的头部被拒绝', shortThrew)

  const outOfBounds = join(dir, 'oob.asar')
  const bad = makeAsar('bad.txt', 'hello')
  const jsonLen = bad.readUInt32LE(12)
  const json = JSON.parse(bad.subarray(16, 16 + jsonLen).toString('utf8'))
  json.files['bad.txt'].offset = '999999'
  const badJson = Buffer.from(JSON.stringify(json))
  const payloadSize = 8 + badJson.length
  const badArchive = Buffer.alloc(8 + payloadSize)
  badArchive.writeUInt32LE(payloadSize, 4)
  badArchive.writeUInt32LE(payloadSize, 8)
  badArchive.writeUInt32LE(badJson.length, 12)
  badJson.copy(badArchive, 16)
  writeFileSync(outOfBounds, badArchive)
  let boundsThrew = false
  try { openAsar(outOfBounds).find(/^bad\.txt$/) } catch (error) { boundsThrew = /out of bounds/.test(error.message) }
  check('越界文件 offset 被拒绝', boundsThrew)

  const invalidSize = join(dir, 'bad-size.asar')
  const badSize = makeAsar('bad.txt', 'hello')
  const badSizeLen = badSize.readUInt32LE(12)
  const badSizeJson = JSON.parse(badSize.subarray(16, 16 + badSizeLen).toString('utf8'))
  badSizeJson.files['bad.txt'].size = -1
  const badSizeBytes = Buffer.from(JSON.stringify(badSizeJson))
  const badSizePayload = 8 + badSizeBytes.length
  const badSizeArchive = Buffer.alloc(8 + badSizePayload)
  badSizeArchive.writeUInt32LE(badSizePayload, 4)
  badSizeArchive.writeUInt32LE(badSizePayload, 8)
  badSizeArchive.writeUInt32LE(badSizeBytes.length, 12)
  badSizeBytes.copy(badSizeArchive, 16)
  writeFileSync(invalidSize, badSizeArchive)
  let sizeThrew = false
  // The reader reports size and offset failures separately now, so match the
  // size case specifically instead of the old combined wording.
  try { openAsar(invalidSize).find(/^bad\.txt$/) } catch (error) { sizeThrew = /invalid size/.test(error.message) }
  check('负数文件大小被拒绝', sizeThrew)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

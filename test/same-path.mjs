/**
 * Path comparison for shortcut discovery.
 *
 * The bug this exists for: the guard compares the shortcut's target with the
 * executable path as plain strings. A caller that passes "D:/deep/App.exe"
 * (forward slashes) versus a shortcut holding "D:\\deep\\App.exe" fails the
 * comparison, so the guard does not recognise the icon the user already has and
 * silently creates a second one.
 *
 * Backslashes are built with String.fromCharCode(92) rather than written as
 * literals: this file has been mangled twice by a layer that strips them, and a
 * test whose fixture is wrong is worse than no test.
 */
import { samePath } from '../lib/launcher.mjs'

const B = String.fromCharCode(92)
const win = (...segments) => segments.join(B)

let failures = 0
function check (label, got, want) {
  const ok = got === want
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}  -> ${got} (期望 ${want})`)
  if (!ok) failures++
}

const exe = win('D:', 'deep', 'DeepSeek Harness.exe')

console.log('\n[1] 正斜杠与反斜杠是同一个文件')
check('D:/ 与 D:\\ 相等', samePath('D:/deep/DeepSeek Harness.exe', exe), true)

console.log('\n[2] 大小写不敏感')
check('DEEP 与 deep 相等', samePath(win('D:', 'DEEP', 'A.EXE'), win('d:', 'deep', 'a.exe')), true)

console.log('\n[3] 不同文件不相等')
check('a.exe 与 b.exe', samePath(win('D:', 'deep', 'a.exe'), win('D:', 'deep', 'b.exe')), false)

console.log('\n[4] 缺省值不相等')
check('undefined', samePath(undefined, exe), false)
check('空串', samePath('', exe), false)

console.log('\n[5] 同一路径重复比较（大小写混写）')
check('带空格的文件名', samePath(win('D:', 'deep', 'DeepSeek Harness.exe'), win('D:', 'deep', 'DeepSeek Harness.exe')), true)

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

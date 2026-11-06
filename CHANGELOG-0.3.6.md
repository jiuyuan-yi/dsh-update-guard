# dsh-update-guard 0.3.6：实操修订与独立复核

## 本次交付

- 基线：用户提供的 `0.3.5` 完整源码快照（commit `8c01b15`）。
- 交付版本：`0.3.6` 工作副本。
- 修改方式：只改解压后的副本；没有覆盖上传的 `update-guard-open-issues.zip`，也没有修改用户机器上的 DSH profile、快捷方式、安装目录或真实配置。

## 实际落地的代码修订

### 1. 路径与文件边界保护

- 新增 `lib/package-path.mjs`，将 bundle 名称限制为正常 npm 包名（普通包或 `@scope/name`），拒绝 `..`、反斜杠、绝对路径和非字符串。
- `compat.mjs`、`restore.mjs`、`diagnose.mjs` 共用安全路径解析，避免配置中的异常包名或 `dsh.bundle.patch` 路径逃出插件目录。
- 生成的 PowerShell 启动器增加相应的包目录和 patch 路径校验。

### 2. ASAR 输入校验

- `lib/asar.mjs` 验证头部、JSON 目录边界，以及文件条目的 offset/size 是否落在实际 archive 内。
- 新增 `test/asar-safety.mjs`，覆盖截断头、越界 offset 和非法 size。

### 3. 补丁层撤销记录保护

- `lib/patch.mjs` 使用唯一临时文件和 rename 原子替换。
- 状态文件损坏或结构不合法时拒绝继续写入，避免覆盖唯一的撤销记录。
- 先写撤销日志，再替换 patch；patch 写入失败时尝试回滚日志。
- `unlockAll()` 对找不到的条目保留未解决记录，不再静默清空撤销信息。

### 4. 启动器 runtime 恢复失败时停止启动

- PowerShell 启动器对恢复后的文件数验证失败采取 fail-closed：不再假定探针文件存在就等于 runtime 完整。
- runtime 仍不完整时，弹出修复提示并以非零状态退出，不带着已知损坏的 runtime 继续启动 DSH。
- 加强包名和 patch 路径校验；相应测试检查生成脚本中的保护逻辑。

### 5. 接口面解析不确定时不自动锁定（本轮新增）

- 模块表中找到模块、但导出对象解析失败（`confidence: none`）时，记录为 `unverified`，不再把空成员数组解释为“模块存在但所有成员都缺失”。
- 如果模块表整体解析为空，则四个受跟踪模块都降级为未验证，避免 parser drift 让所有插件被误判为不兼容。
- 未验证项写入 `surfaceUnverifiedModules`；CLI 展示具体模块名。
- `lockFromAnalysis()` 只对 `broken` 中的确定问题执行锁定；纯 `unverified` 记录属于 advisory，不会触发 `autoLock`。
- 新增 `test/surface-uncertain.mjs`，实际验证模块级解析失败和模块表整体解析失败两种场景，确保配置 patch 不被修改。

### 6. ASAR 来源标记只在解析成功后写入（本轮新增）

- 新解包开始前删除旧 `.source`，防止新文件或半成品继承上一次安装包的身份标记。
- 只有 `readSurface()` 成功读出 shell bundle 后，才写入当前安装包来源标记。
- `installer-fresh.mjs` 增加伪 7-Zip 故障测试：故意生成无效 `app.asar`，确认即使保留失败现场，`.source` 也不会留下。

### 7. 缓存元数据指纹增强（本轮新增）

- 缓存身份除路径、大小、修改时间外，也纳入 `dev`、`ino`、`ctimeMs` 和 `birthtimeMs`。
- 这仍不是完整文件内容哈希；这样做是为了避免每次启动都读取数百 MB 安装包。它降低同路径替换导致的误复用风险，但不是密码学意义的完整内容验证。

## 测试结果

最后一次运行：`node test/all.mjs`

| 结果 | 数量 |
|---|---:|
| PASS | 21 |
| UNVERIFIED | 6 |
| FAIL | 0 |

6 项未验证：

- `diagnose-agreement.mjs`
- `e2e.mjs`
- `gen-launcher.mjs`
- `installer-fresh.mjs`
- `launcher-flow.mjs`
- `launcher-repair.mjs`

汇总脚本返回退出码 `3`，这是因为存在未验证项，并非测试失败。

补充：`installer-fresh.mjs` 的新增伪 7-Zip失败路径已单独在当前环境实际执行，3 项断言全部通过；但真实 DSH 安装包/7-Zip 集成部分因为当前环境没有待安装更新包及 Windows 7-Zip，故该测试整体仍为 `UNVERIFIED`。

此外，对全部 46 个 `.js` / `.mjs` 文件执行 `node --check`，全部通过。

## 仍未解决的事

1. **profile 当前 `autoLock: true`**：这是用户机器上已有的配置状态，不会因为源码默认值是 `false` 就自动关闭。建议在实际 DSH profile 上执行：

   ```powershell
   node bin/guard.mjs config --set autoLock --value false
   ```

   这是配置操作，不需要改动源码；也不应该在未取得真实 profile 文件时，假装已经替用户关掉。

2. **pending 安装包版本与当前安装版本可能不一致**：目前没有足够证据确认 DSH EXE 的 `ProductVersion` 与 app 内部版本号语义完全一致，因此我没有擅自加入可能误拦真实恢复的版本判断。启动器现有失败提示已提醒用户版本不匹配时应使用当前版本安装程序修复/重装；该项仍需 Windows 实机验证。

3. **runtime 的完整性仍不是功能等价验证**：目录、子树、关键文件和文件数检查，不能代替逐文件清单或启动后的功能验证。

4. **PowerShell 与真实更新链路仍未验证**：当前环境无法执行 Windows PowerShell；真实的下载、安装、重启和 runtime 自愈链路仍需在有合适 DSH 更新包的 Windows 环境验证。

5. **`dsh.version` 字段语义仍不明确**：没有擅自改动。

## 我的建议

- 当前可以把 `0.3.6` 当作一份**带有实际代码修订的测试候选版**，不是已经通过 Windows 实机验收的稳定版。
- 真实 profile 上先将 `autoLock` 关闭，保留手动检查和手动锁定。
- 等 DSH 下一个版本发布后，优先验证：实际升级、pending 版本识别、runtime 缺失恢复、恢复后主程序能否正常启动和使用。
- 不建议把 21 项 PASS 表述成“全部测试通过”；正确说法是“21 项通过，6 项因环境未验证，0 项失败”。

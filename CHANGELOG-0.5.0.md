# 0.5.0 — 方法级服务比对、接口面快照库，以及 runtime 完整性的两处修正

三类改动：把宿主服务的检查从"名字还在吗"做到"这个方法还在吗"；把跨版本回归从"留着旧 app.asar"变成"存一份 JSON"；把 runtime 完整性从数文件升级为核对入口。

## 新：宿主服务方法级比对

**旧行为**：只检查服务名。`webServer` 还在就通过——哪怕 `register` 被改名了，插件在第一次调用时抛错。

**新行为**：

1. 从宿主源码里按文件提取「服务名 → 方法集」。只认强声明（`super(ctx,'x')` / `provide` / `registerService` / `defineService` / `static service`），不认 `.set('key')`——真实归档里它会匹配 `Map.set('active')` 这类数据键，造出 823 个方法的伪服务。
2. 从插件源码里提取**调用**形式：`ctx.webServer.register(...)`、`ctx.get('slots').register(...)`、`const s = ctx.get('slots'); s.register(...)`。
3. 只看调用，不看属性读取：`ctx.workingDirectory.defaultDirectory` 可能是 getter 或字段，不在方法集里说明不了任何问题。收紧到"必须跟调用括号"之前，本机 13 个插件的误报是 5 条；收紧之后是 **0 条**。
4. 方法名在宿主任何字符串字面量里出现过就不报（和 `mentioned` 兜底同一哲学）。
5. **只进 advisory，不进入 broken，不触发 autoLock**。方法可能定义在基类或 mixin 上，这个扫描器不跟继承。

本机实测：`app.asar.bak`（0.2.2-rc.5）提取出 157 个有方法集的服务、7475 个方法；`webServer` 拿到 `register/add/port/readResource/...`，`tools` 拿到 `execute/register/schemas/...`。扫描 1182 个文件约 2.9 秒，只在有待安装更新时跑。

报告里新增 `serviceMethodsChecked`（有多少服务真正参与了方法比对）与每个插件的 `methodUnknown`。

## 新：`surfaces` 接口面快照库

```bash
node bin/guard.mjs surfaces export --asar <app.asar>     # 写入 baselines/dsh-<version>.json
node bin/guard.mjs surfaces list
node bin/guard.mjs surfaces diff <旧.json> <新.json>      # --json 可选
```

快照只保存真正参与比对的部分：模块成员、服务名与方法集、工具签名，加上归档与 shell bundle 的 SHA256。**不保存 34k 条字符串字面量**（快照不用于离线 check，存了只是让文件大三倍）。本机一版 234 KB。

`diff` 的 `breaking` 判据很窄：成员消失、服务消失、方法消失、工具或参数消失。纯新增和描述变化都不算——否则每个版本都是红的，这个信号就没人看了。

## 修：runtime 完整性从「数文件」升级为「关键清单」

**旧判据**：四个子树存在 + `versions.json` + 文件数不低于基线的 95%。

**漏掉的情况**：文件数一个不少，入口已经坏了。一次被中断的写入、一个被杀软截断的 exe，都能让 6136 这个数字保持正确。

**新行为**：首次成功启动时写 `manifest`，只记"缺一个就必崩"的入口（`versions.json`、`primary-runtime/runtime.json`、`bin/` 与 `cli/` 浅层文件、依赖树里的 `node`/`pnpm`/`python` 入口），每条路径 + 大小 + SHA256；启动自检逐个核对。`versions.json` 哈希变了就跳过清单——升级后入口本来就该换。

顺带修掉两个会让它静默失效的坑：

- `ConvertTo-Json` 默认深度 2，manifest 每个元素会被序列化成字符串，读回来 `path` 全 `null`：清单在，什么也没校验。已显式 `-Depth 6`。
- 启动器模板换了但 stamp 不认生成器版本，插件升级后旧包装器继续跑旧逻辑，新自愈逻辑永远到不了实际执行的那份 ps1。已加 `GENERATOR_VERSION`。

## 修：安装包留底，更新器清缓存也能恢复

**旧行为**：恢复只从 `pending\`、缓存根、`installers\` 找安装包。前两处在更新器缓存里，清一次缓存就没了；第三处注释写着"上次成功恢复时留的底"，但代码里从来没有写入它的逻辑。

**新行为**：拿到可用安装包后，在同一卷的 `keep\` 下建**硬链接**——不复制数据、不占额外空间、删掉 `pending` 不影响；跨卷建不出来就静默跳过，退回原来的三层。滚动保留最近两份。恢复失败提示里补上了兜底目录的实际路径。

## 新：设置面板里的更新体检

CLI 里那几层能力普通用户很少敲命令去用。现在设置 → 通用 → 更新守卫里多了一块「更新体检」：

- **升级前确认**：有待安装更新、且确实有插件会断时，列出会断的插件与缺失成员，旁边给「先锁定这些插件」。点两次才执行（第一次武装，第二次写入），调用的是和 `guard.mjs lock` 完全相同的 `lockFromAnalysis`，所以面板和命令行不会分叉。`service-absent` 这类 advisory 永远不入锁。
- **幽灵提示条**：磁盘上的 `app.asar` 比正在运行的进程新时，直接提示"当前界面仍在跑旧版代码，建议重启"。只在真的检测到时出现，`unknown` 不占版面。
- **插件耦合风险**：每个已挂载插件的风险等级（高/中/低）+ 版本 + 命中类数；点开看具体命中了哪些类、哪几个文件。和 `touchpoints` 同源、同一套分级。
- **重新扫描**按钮：只有它才强制重扫，平时读缓存。

数据走 `/dsh-update-guard/panel.json`，宿主侧 5 分钟 TTL + 启动后后台预热一次。本机实测：13 个插件首次构建 1.8 秒，之后打开面板不等待。

体检区只读；唯一的写操作是「先锁定这些插件」，写的是 profile 的 `cordis.patch.yml`（带撤销日志，`guard.mjs unlock` 可回）。请求失败时整块不显示，四个开关照常可用。## 新：`support-bundle`，一段就能贴进 issue

```bash
node bin/guard.mjs support-bundle [--out report.md] [--json] [--ghost]
```

版本、runtime 基线、上次检查结论、插件触点分级、服务方法未确认项、`surfaceUnverifiedModules`、启动日志最后 40 行。家目录/profile/安装根/guard 目录全部替换成占位符；插件只报文件名与命中数。测试断言输出不含真实家目录。

## 工程：CI 与测试环境

- `.github/workflows/ci.yml`：`windows-latest` 跑 `node test/all.mjs`，并断言运行时依赖仍为 0
- CI 接受退出码 3（有测试缺真实安装），但打 warning、在 job summary 写明"跳过不是通过"
- 修掉三个**只要桌面开着 DSH 就必然失败**的端到端测试：启动器单实例互斥量在 DSH 运行期间被真实启动器持有，测试改用 `DSH_LAUNCHER_TEST_MUTEX` 拿自己的锁
- `ghost` 测试不再写死 `D:/deep/resources/app.asar`，改用临时归档

## 新：升级前状态快照

```bash
node bin/guard.mjs snapshot --note "before 0.3.1"
node bin/guard.mjs snapshot --list
node bin/guard.mjs snapshot --diff <旧> <新>
```

记的是"现场"而不是可还原的备份：DSH 版本、`bundles` 列表、每个插件版本、守卫配置、runtime 基线、上次检查结论。写在 `.cache/snapshots/`。

`--diff` 只报真正变化的东西。**刻意不做"从快照还原"**——配置还原已经有外科式机制，再多一条能改 `bundles` 的路径只会让现场更乱。

顺带修掉一个和目录模式安装共通的盲区：`installedVersion()` 以前只读 `app.asar`，目录模式（`resources/app` 未打包）下版本永远是 `unknown`，于是 `status`、`support-bundle`、快照里都缺版本号。现在会退回读 `resources/app/package.json`。

## 修：面板展示了别的 profile 的报告

面板里一度出现 `dsh-fixture-bad` / `dsh-fixture-multi` 这类插件——用户从没装过。

原因：`e2e` 测试用临时 profile 跑 `check`，而报告写进的是**共享的** `.cache/last-report.json`。面板读同一个文件，于是把一份"关于临时目录"的报告当成当前机器的风险，还给出了锁定按钮。那些 `ids` 属于已经不存在的树。

三处修：

- `readCachedReport(cacheRoot, expectedProfileDir)` 校验来源，面板只认当前 profile 的报告；
- CLI 新增 `--cache <dir>`，测试与诊断不再写默认缓存；
- `e2e` 传 `--cache`，污染源本身被切断。

锁定按钮本来就会 409（`postLock` 也校验 profileDir），所以不会真的锁错；但**展示假风险本身就是 bug**，尤其是它旁边就摆着一个写配置的按钮。

## 修：启动链路上的三个问题（2026-11-25 那次"runtime 不完整"弹窗）

现象：runtime 完好无损，启动器却弹"runtime 目录仍不完整，已阻止启动"。

1. **安装根识别只认 `app-update.yml`**。这台机器上它是 `app-update.yml.disabled`（防止更新破坏插件时改的名），于是识别失败。`isInstallRoot()` 现在接受 `app-update.yml` / `.disabled` / `resources\app.asar` / `resources\app`（目录模式）/ `resources\runtime` 中任一。
2. **识别失败后启动目标退回了 `node.exe`**。包装器于是从 node 的安装目录去找 `resources\runtime`，当然没有——真实 runtime 在 `D:\deep`。现在 `resolveDesktopExe()` 找不到可验证的安装根就**返回 `undefined`，拒绝生成**：不生成包装器是可恢复的，生成一个错的不是。
3. **`-Check` 排在单实例互斥量之后**。DSH 运行期间真实启动器一支持有那把锁，于是自检什么都不检查、什么都不打印、退出码 0——看起来像"通过"。自检现在排在互斥量之前，并且会真的核对 runtime 完整性：

```text
=== 启动前检查 ===
  exe     : D:\deep\DeepSeek Harness.exe
  profile : C:\Users\ASUS\.dsh\profiles\desktop
  [OK] 配置正常
  [OK] runtime 完整
```

同时删掉了修复过程中写进代码的 `D:\deep` 字面量（`findInstallRoot` 候选与启动目标兜底各一处）。这个包会发到 npm，别人的机器上没有那个目录；而本机在 DSH 进程内本来就能从 `process.execPath` 解析到安装根，写死只是把"这台机器"混进了发布物。

启动器模板版本升到 5：已有机器下次启动会重写包装器，这次重写才真正带上上述修复。

## 仍未覆盖

- 服务方法只比**名字**，不比参数个数与可选性。`register(a)` 变成 `register(a, b)` 抓不到。
- 方法集不跟继承与 mixin，所以"未找到"仍然是 advisory。
- 仍只在 `0.2.1-rc.5 → 0.2.2-rc.1` 一次真实升级上验证过。

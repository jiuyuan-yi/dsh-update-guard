# dsh-update-guard

**DSH 桌面端更新守卫：更新前查插件会不会崩，崩了能自己修回来。**

[![ci](https://github.com/jiuyuan-yi/dsh-update-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/jiuyuan-yi/dsh-update-guard/actions/workflows/ci.yml)

[English](README.en.md) · 中文

---

## 先看它是干什么的

```bash
dsh plugin --profile web add dsh-update-guard
```

装上之后 `dsh-update-guard status` 的输出：

```text
=== 状态 ===

profile     : C:\Users\ASUS\.dsh\profiles\desktop
安装目录    : D:\deep
待安装更新  : 无
已装插件    : 13
已锁定      : 无
自动锁定    : 关
启动自检    : 关
```

它只在你决定装更新、或者 DSH 起不来的时候出现，平时不占屏、不弹窗。

---

## 起因：一次更新，连崩四次

2026-11-05，升级到 `0.2.2-rc.1` 之后，DSH 起不来了。没有界面，没有提示，只有日志里这一句：

```
DesktopHostFatalError: ENOENT: no such file or directory, open
  'D:\deep\resources\runtime\office-skills\office\SKILL.md'
    at readFileSync (node:fs:483:20)
    at @deepseek-ai/dsh-skill-office/lib/index.js:64:38
    at new apply
    at Fiber.execute (cordis/lib/index.js:362:24)
    at main (dsh-desktop-host/lib/index.js:594:2)
```

更新器清空了 `resources\runtime`。`dsh-skill-office` 启动时必须读里面的 `SKILL.md`，读不到就在 Fiber 里抛错，**整个 host 启动失败**。而 runtime 不在 `app.asar` 内，磁盘上没有别处能补 —— 只能重装。

四份 crash log 是同一分钟内连崩四次留下的。

这个插件就是为了让这件事不再发生。

## 装与不装

|  | 不装 | 装了 |
|---|---|---|
| 更新前 | 不知道哪些插件会断 | 列出会失效的插件和具体成员 |
| 更新后崩了 | 重装 DSH | 启动器自动从安装包恢复 runtime，**实测 8 秒 / 6136 个文件**（0.2.2-rc.5） |
| 配置被重置 | 插件全没 | 从备份外科式还原，只跳过坏的那个 |
| 图标被改回 | 自愈能力一起没了 | 下次启动自动改回来 |

## 两条腿

### 一、更新前检查

应用下载完更新、还没安装时：从安装包里解出两套接口面，扫描已装插件实际用到什么，**只报告用到了新版本里没有的东西的插件**。

| 证据 | 缺失后果 | 自动锁定 |
|---|---|---|
| 客户端成员（`UiPrimitives.xxx`） | 渲染抛错，界面崩 | ✅ 会锁 |
| 宿主服务（`inject: [...]`） | 插件激活不了；required 插件会让整个应用起不来 | ❌ 只提示 |
| 宿主服务方法（`ctx.webServer.register(...)`） | 加载期不报，第一次调用才抛 | ❌ 只提示 |

宿主服务不自动锁：服务可能以扫描器没建模的方式动态提供，误判会锁掉正常插件。报出来，你自己判断。

服务方法同样只提示，而且只比**名字**：方法可能定义在基类或 mixin 上，扫描器不跟继承；参数个数与可选性也不比较。

**解析不出来就说解析不出来**，不当成"接口全缺"：模块表解析失败时该项标记为 `unverified` 并写进 `surfaceUnverifiedModules`，**不触发自动锁定**。

没有解压器也不失败，降级成「只比版本声明」（`engines.dsh` / `peerDependencies`），这本来就是加载器自己的检查。部分检查**不会**显示成"没有发现不兼容"。

### 二、崩了能修

桌面上挂一个启动包装器（`wscript` + 隐藏窗口，没有控制台黑框）：

- **runtime 被清空** → 从安装包解回来（实测 10.2 秒、6144 个文件），失败则明确阻止启动并提示修复
- **安装包被清掉** → 恢复成功时在同一卷留一个硬链接（零拷贝），更新器清缓存后仍能补
- **runtime 入口被损坏** → 关键文件清单核对大小与 SHA256，文件数对得上也能抓住
- 启动失败 → 重试 → 仍然失败就弹框问你（默认按钮是「否」）
- 插件配置被清空 → 从备份还原，只跳过有问题的那个
- 快捷方式被改回直连 exe → 下次启动自动改回
- 同一时刻只允许一个启动器

## 实测，不是理论上

```
runtime 恢复        10.2 秒，6144 个文件，SKILL.md 回来
解包读取            5.2 秒，951,974 字符的 shell bundle
缓存复用            同包第二次不重解（asar mtime 不变）
测试                39 项，本机全过；没有真实安装的环境里 3 项会跳过（不算通过）
真实崩溃            2026-11-05 连崩四次，本插件恢复后正常启动
```

那 3 项不是通过，也不假装是通过：`test/all.mjs` 会单独列出它们并以退出码 3 结束。CI 里同样会打 warning。

## 安装

需要 Node.js 18+、Windows、DSH 桌面端。

```bash
dsh plugin --profile web add dsh-update-guard
```

从 npm 装，不经过 git clone，也没有 `allowBuilds` 批准那一步。装完重启。

要跟源码（比如想改代码）再用：

```bash
dsh plugin --profile web add github:jiuyuan-yi/dsh-update-guard
```

市场页：https://awesome-dsh-plugin.com/p/jiuyuan-yi/dsh-update-guard/
npm 页：https://www.npmjs.com/package/dsh-update-guard

## 设置面板

设置 → 通用 → 更新守卫。除了四个开关，还有一块「更新体检」：

- **升级前确认**：检测到待安装更新、且确实有插件会失效时，列出会断的插件与具体缺失成员，旁边是「先锁定这些插件」——点两次才执行（第一次武装，第二次写入），走的是和 `guard.mjs lock` 完全相同的函数，只锁客户端成员缺失的那几个；`service-absent` 这类 advisory 不会被锁。
- **幽灵提示条**：磁盘上的 `app.asar` 比正在运行的进程新时，直接提示重启。只在真的检测到时出现。
- **插件耦合风险**：每个已挂载插件的等级（高/中/低）+ 版本 + 命中类数，点开看具体哪几类、哪几个文件。
- **重新扫描**：只有它强制重扫，平时读缓存。

体检数据来自宿主侧缓存（5 分钟 TTL，启动后后台预热一次）。实测 13 个插件首次构建 1.8 秒，之后打开面板不等待。风险列表和 `touchpoints` 同源、同一套分级——是排序，不是兼容性结论。

面板里唯一的写操作就是「先锁定这些插件」，写的是 profile 的 `cordis.patch.yml`（带撤销日志），撤销用 `guard.mjs unlock`。

## 命令行

```bash
node bin/guard.mjs check            # 检查待安装的更新
node bin/guard.mjs check --json     # 机器可读
node bin/guard.mjs check --remote   # 不下载安装包，直接问线上是什么版本
node bin/guard.mjs lock             # 锁定命中的插件
node bin/guard.mjs unlock           # 撤销锁定
node bin/guard.mjs diagnose         # 不还原时，看判定卡在哪一环
node bin/guard.mjs restore          # 预演：配置被重置后会还原成什么样
node bin/guard.mjs restore --apply
node bin/guard.mjs config --set autoLock --value false
node bin/guard.mjs status
node bin/guard.mjs touchpoints      # 不看新版本，只看已装插件耦合了宿主多少内部面
node bin/guard.mjs touchpoints --json
node bin/guard.mjs touchpoints --only dsh-core-sauce
node bin/guard.mjs tools --asar <app.asar>                 # 当前工具表面
node bin/guard.mjs tools --asar <旧> --diff <新>            # 工具/参数变化
node bin/guard.mjs ghost --asar <app.asar>                 # 运行中的进程是否比磁盘旧
node bin/guard.mjs support-bundle                          # 脱敏诊断，直接贴进 issue
node bin/guard.mjs support-bundle --out report.md --ghost
node bin/guard.mjs surfaces export --asar <app.asar>        # 存一份接口面快照（234 KB）
node bin/guard.mjs surfaces diff <旧.json> <新.json>         # 比两个版本，不需要旧 asar
node bin/guard.mjs snapshot                                 # 升级前拍一份状态（本机 .cache）
node bin/guard.mjs snapshot --list
node bin/guard.mjs snapshot --diff <旧> <新>
```

退出码：`0` 正常，`2` 发现不兼容，`1` 出错。

### touchpoints：最便宜的一层

`check` 要等一个新版本下来才能跑。`touchpoints` 不需要——它只读已装插件的源码，判断它们各自伸手进宿主的哪些不稳定面，秒级出结果。

七类，越靠前越危险：

| # | 类 | 命中意味着 |
|---|---|---|
| 1 | `source-patch` | 改写宿主安装目录里的文件。升级后补丁目标移动，要么空转要么把树弄坏 |
| 2 | `internal-events` | 订阅内部事件名。改名是静默的，handler 直接不再触发 |
| 3 | `internal-services` | 访问私有服务与 RPC 形状。成员被删时是调用期抛错，不是加载期 |
| 4 | `host-filesystem` | 直接读写 `DSH_HOME`、`profiles/`。目录搬家后读成空结果，不报错 |
| 5 | `internal-ui` | 注册进 client slot、命令表、模块加载器。键在 build 之间会移动 |
| 6 | `custom-channel` | 自己起 server/WebSocket、往 DOM 里插规则。假设了宿主不承诺的页面结构 |
| 7 | `subprocess-output` | 解析 CLI 的 stdout/stderr。措辞自由度很大，parser 会返回错值而不是失败 |

分级只看两件事：**是否真的写宿主**，以及**伸进多少个不稳定面**。同一类命中一次只算「提到」，两次以上才算「触及」——注释和文档里出现 API 名字不该抬高评级。

`--only <name>` 只看一个插件，`--max-files` 限制单插件扫描文件数（默认 4000）。

**它是启发式扫描，不是兼容性证明。** 零命中只代表这些模式没匹配到，不代表升级安全。

### tools：模型看见的那一面

工具名、参数集、哪个参数是可选，这些是**别人真的会调用**的东西。改一个工具名，或者把原本可选的参数改成必填，不会动实现一行代码就把调用方全弄死。

```bash
node bin/guard.mjs tools --asar <app.asar>                 # 列出当前工具表面
node bin/guard.mjs tools --asar <旧.asar> --diff <新.asar>  # 对比两个版本
```

对比只看三件会真的弄坏调用方的事：

- **工具被移除** —— 引用它的提示词和插件直接失效
- **参数被移除** —— 按旧参数调用会失败
- **参数从可选变必填** —— 省略它的调用会失败

仅描述变化单独列出：不影响调用，但可能改变模型行为。

### ghost：你比的是不是同一个东西

就地升级会替换 `app.asar`，而运行中的宿主还在跑它已经加载的旧代码。这之后磁盘上的版本号、目录名、`package.json` 全报新版本，**真正会挂载插件的那个进程还是旧的**。此刻做的任何兼容性判断，都是在拿新版本的接口去比一个跑旧代码的进程——结论通常是反的。

```bash
node bin/guard.mjs ghost --asar <app.asar>
```

判据是时间戳而不是版本号：**归档写入时间晚于进程启动时间**，说明那个进程加载的比归档旧。

Windows 专用（需要进程启动时间）。其他平台返回 `unknown` 而不是猜——一个错误的「没有幽灵」比诚实的「判断不了」更糟，因为这正是你会在错误基座上做决定的那一次。

### support-bundle：把现场打包成一段

```bash
node bin/guard.mjs support-bundle                 # markdown，直接贴进 issue
node bin/guard.mjs support-bundle --out report.md
node bin/guard.mjs support-bundle --json          # 机器可读
node bin/guard.mjs support-bundle --ghost         # 附带「磁盘比进程新」判定
```

包含：DSH 与 guard 版本、`runtime` 基线（文件数 / `versions.json` 哈希 / 关键清单条数）、上次更新前检查看到了什么、每个插件的触点分级、`surfaceUnverifiedModules`、启动日志最后 40 行。

**脱敏是硬规则，不是尽量**：家目录 → `<HOME>`，profile → `<PROFILE>`，安装根 → `<DSH_ROOT>`，guard 目录 → `<GUARD>`。插件只报文件名与命中数，不报源码。测试里有一条断言直接检查输出不含真实家目录。

报 issue 时带上这段，就不用再来回问「你装的是哪个版本、哪个插件」。

### surfaces：把接口面存下来，不用留 200 MB 的旧包

回归测试真正需要的不是整个运行时，是"被比较的那部分"。快照只保存模块成员、服务名与方法集、工具签名，加上归档和 shell bundle 的 SHA256——一版 234 KB，可以进仓库。

```bash
node bin/guard.mjs surfaces export --asar <app.asar>     # baselines/dsh-<version>.json
node bin/guard.mjs surfaces list
node bin/guard.mjs surfaces diff <旧> <新>                # --json 可选
```

`diff` 的破坏性判据很窄：成员消失、服务消失、方法消失、工具或参数消失。纯新增和描述变化都不算——否则每个版本都是红的，这个信号就没人看了。

快照不用于离线 `check`，所以不存那 34k 条字符串字面量；存了只是让文件大三倍。

### snapshot：升级前留一份现场

不是还原源，是对照用的记录：DSH 版本、`bundles` 列表、每个插件版本、守卫配置、runtime 基线、上次检查结论。写在 `.cache/snapshots/`，不进仓库。

```bash
node bin/guard.mjs snapshot --note "before 0.3.1"
node bin/guard.mjs snapshot --list
node bin/guard.mjs snapshot --diff <旧> <新>
```

`--diff` 只报真正变化的东西：插件新增/移除/版本变化、`bundles` 增删、配置键的变化、runtime 文件数、待安装更新。刻意不做"从快照还原"——配置还原已经有外科式机制，两条都能改 `bundles` 的路只会把现场弄得更乱。

## 配置

`<profile>/.dsh-update-guard.json`

| 键 | 默认 | 说明 |
|---|---|---|
| `preflightOnStartup` | `true` | 启动时跑检查 |
| `autoLock` | `false` | 命中直接锁定，不询问 |
| `maxAutoLock` | `3` | 一次最多锁几个 |
| `autoRestore` | `true` | 配置被清空时从备份还原 |
| `installLauncher` | `false` | 是否接管桌面快捷方式 |

## 它不会做什么

- 不联网，不上报任何数据
- 不改插件代码，只改 `cordis.patch.yml` 里的 `disabled` 字段，逐字节可还原
- 不碰 `!!js` 这类条件值（加载器的动态表达式，改写会破坏语义）
- 不判断自己
- 不写死绝对路径：安装目录从注册表 `InstallLocation` 问

## 已知限制

- **只在 Windows 验证过**（启动包装器依赖 `wscript.exe`）
- 接口面比对覆盖：4 个共享 UI 模块的**导出成员名**、宿主**服务名**、宿主**服务方法名**。方法签名（参数个数、可选性）仍不比较，服务方法也可能定义在基类上而漏检
- 只在 `0.2.1-rc.5 → 0.2.2-rc.1` 这一次真实升级上验证过，更早的版本对没有样本
- 还原时的插件校验只做结构检查，**不启动插件验证运行时行为**
- runtime 自愈的安装包来源：`keep` 硬链接（同卷、恢复过一次之后才有）、`pending`、更新器缓存、`installers/`。四处都没有时需要重装
- runtime 完整性核对的是**关键入口清单**（十来个文件的大小与哈希），不是 6136 个文件逐个校验

## 如果你也遇到了

这个插件最大的短板是**只经历过一次真实升级**。如果你在某个版本对上遇到下面任一情况，开个 issue 说一声，把版本号和现象带上就行：

- 更新后 DSH 起不来，日志里有 `ENOENT` 或 `is not a function`
- 更新前检查说某个插件会断，但你装完发现它其实没事（**这更重要** —— 误报会让人不敢用）
- 启动器把 runtime 判定成不完整，可你觉得 runtime 是好的（用 `DSH_LAUNCHER_FORCE_START=1` 能启动的那种）

前两种帮我补版本样本，最后一种帮我修判据。都不需要你改代码。

## 许可

MIT

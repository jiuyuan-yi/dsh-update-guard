# dsh-update-guard

**DSH 桌面端更新守卫：更新前查插件会不会崩，崩了能自己修回来。**

[English](README.en.md) · 中文

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
| 更新后崩了 | 重装 DSH | 启动器自动从安装包恢复 runtime，10 秒 |
| 配置被重置 | 插件全没 | 从备份外科式还原，只跳过坏的那个 |
| 图标被改回 | 自愈能力一起没了 | 下次启动自动改回来 |

## 两条腿

### 一、更新前检查

应用下载完更新、还没安装时：从安装包里解出两套接口面，扫描已装插件实际用到什么，**只报告用到了新版本里没有的东西的插件**。

| 证据 | 缺失后果 | 自动锁定 |
|---|---|---|
| 客户端成员（`UiPrimitives.xxx`） | 渲染抛错，界面崩 | ✅ 会锁 |
| 宿主服务（`inject: [...]`） | 插件激活不了；required 插件会让整个应用起不来 | ❌ 只提示 |

宿主服务不自动锁：服务可能以扫描器没建模的方式动态提供，误判会锁掉正常插件。报出来，你自己判断。

**解析不出来就说解析不出来**，不当成"接口全缺"：模块表解析失败时该项标记为 `unverified` 并写进 `surfaceUnverifiedModules`，**不触发自动锁定**。

没有解压器也不失败，降级成「只比版本声明」（`engines.dsh` / `peerDependencies`），这本来就是加载器自己的检查。部分检查**不会**显示成"没有发现不兼容"。

### 二、崩了能修

桌面上挂一个启动包装器（`wscript` + 隐藏窗口，没有控制台黑框）：

- **runtime 被清空** → 从 `pending` 里的安装包解回来（实测 10.2 秒、6144 个文件），失败则明确阻止启动并提示修复
- 启动失败 → 重试 → 仍然失败就弹框问你（默认按钮是「否」）
- 插件配置被清空 → 从备份还原，只跳过有问题的那个
- 快捷方式被改回直连 exe → 下次启动自动改回
- 同一时刻只允许一个启动器

## 实测，不是理论上

```
runtime 恢复        10.2 秒，6144 个文件，SKILL.md 回来
解包读取            5.2 秒，951,974 字符的 shell bundle
缓存复用            同包第二次不重解（asar mtime 不变）
测试                27/27 通过，47 秒，0 跳过
真实崩溃            2026-11-05 连崩四次，本插件恢复后正常启动
```

## 安装

需要 Node.js 18+、Windows、DSH 桌面端。

```bash
dsh plugin --profile web add github:jiuyuan-yi/dsh-update-guard
```

首次运行会要求 `allowBuilds` 批准，按提示加上再跑一次。装完重启。

市场页：https://awesome-dsh-plugin.com/p/jiuyuan-yi/dsh-update-guard/

## 命令行

```bash
node bin/guard.mjs check            # 检查待安装的更新
node bin/guard.mjs check --json     # 机器可读
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
- 接口面比对只看 4 个共享 UI 模块 + 宿主服务名，宿主侧 API 的**行为变化**（签名、语义）不在覆盖范围
- 只在 `0.2.1-rc.5 → 0.2.2-rc.1` 这一次真实升级上验证过，更早的版本对没有样本
- 还原时的插件校验只做结构检查，**不启动插件验证运行时行为**
- runtime 自愈依赖 `pending` 里还留着安装包；装完手动删掉就补不回来
- runtime 完整性用「四个子树 + versions.json + 文件数」判定，不是逐文件清单

## 如果你也遇到了

这个插件最大的短板是**只经历过一次真实升级**。如果你在某个版本对上遇到下面任一情况，开个 issue 说一声，把版本号和现象带上就行：

- 更新后 DSH 起不来，日志里有 `ENOENT` 或 `is not a function`
- 更新前检查说某个插件会断，但你装完发现它其实没事（**这更重要** —— 误报会让人不敢用）
- 启动器把 runtime 判定成不完整，可你觉得 runtime 是好的（用 `DSH_LAUNCHER_FORCE_START=1` 能启动的那种）

前两种帮我补版本样本，最后一种帮我修判据。都不需要你改代码。

## 许可

MIT

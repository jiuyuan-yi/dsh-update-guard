# 0.4.0

三个新命令，覆盖原先查不到的三类变化。

## `touchpoints`：不需要新版本的一层检查

`check` 必须等一个更新下载下来才能跑。`touchpoints` 不用——它只读已装插件的源码，
判断每个插件伸手进宿主的哪些不稳定面。秒级，离线。

七类耦合，按坏起来的严重程度排序：

| # | 类 | 命中意味着 |
|---|---|---|
| 1 | `source-patch` | 改写宿主安装目录里的文件 |
| 2 | `internal-events` | 订阅内部事件名，改名静默失效 |
| 3 | `internal-services` | 访问私有服务与 RPC 形状，调用期才抛 |
| 4 | `host-filesystem` | 直接读写 `DSH_HOME`、`profiles/` |
| 5 | `internal-ui` | 注册进 client slot、命令表、模块加载器 |
| 6 | `custom-channel` | 自起 server/WebSocket、往 DOM 插规则 |
| 7 | `subprocess-output` | 解析 CLI 的 stdout/stderr |

```bash
node bin/guard.mjs touchpoints
node bin/guard.mjs touchpoints --json
node bin/guard.mjs touchpoints --only dsh-core-sauce
```

## `tools`：模型看见的那一面

工具名、参数集、哪个可选——这才是调用方真的会撞上的东西。改个工具名不会动实现
一行代码，但引用它的提示词和插件全部失效。

```bash
node bin/guard.mjs tools --asar <app.asar>
node bin/guard.mjs tools --asar <旧> --diff <新>
```

只报三件真的会弄坏调用方的事：工具被移除、参数被移除、参数从可选变必填。
仅描述变化单独列出（不影响调用，但可能改变模型行为）。

## `ghost`：你比的是不是同一个东西

就地升级替换了 `app.asar`，而运行中的宿主还在跑它已加载的旧代码。此后磁盘上一切
都报新版本，真正会挂载插件的进程还是旧的——此刻的兼容性结论通常整个反过来。

```bash
node bin/guard.mjs ghost --asar <app.asar>
```

判据是时间戳：归档写入时间晚于进程启动时间，说明那个进程加载的更旧。
Windows 专用；其他平台返回 `unknown` 而不是猜。

## 内部改动

`asar.mjs` 增加 `findAll()`：`find()` 只返回第一个匹配，而遍历全部工具模块需要全部。
遍历与边界校验抽成共用的 `visit()`，`find` 的行为保持不变（`asar-safety` 全部通过）。

## 为什么是这套分级

风险分级的依据只有两条：**是否真的写宿主**，以及**伸进多少个不稳定面**。
不引入任何 0-100 的分数，因为那个数字没人该信到小数点后两位。

实测本机 13 个 bundle：`high 2 / medium 10 / low 1`。判 high 的两个
（`dsh-core-sauce`、`dshmarket`）确实都往安装目录里写文件；只改 cookie 的
`dsh-cookie-fix` 落在 low。

## 开发过程中修掉的四个自身缺陷

**注释被当成依赖。** 插件在注释里写「本插件不会写 app.asar」，最初的正则照样命中，
把它判成 host patcher。现在按行剥掉行注释与块注释再匹配。

**计数用的是文件数而不是出现次数。** 同一文件里写三遍 `APIProxy` 只算一次，
该升档的没升。改真计数，单文件上限 5。

**参数的可选性被邻居污染。** 判断 `file_path` 是否可选时用了 260 字符窗口，
把后一个参数的 `optional: true` 框了进来，导致必填参数被标成可选。
改成只看参数自己的平衡括号对象。

**进程字段大小写。** PowerShell 返回 `Id`/`ProcessName`/`Start`，下游按小写取值，
ID 全是 `undefined`。在数据源处归一化，调用方不再关心键名。

## 边界

这是启发式扫描与静态比对，不是兼容性证明。零命中只代表这些模式没匹配到。
报告里写的是风险排序，不是判决。

已知不完善：`dsh-better-sidebar` 因 `custom-channel ×61` 落在 medium，但其中多数是
前端 UI 代码里的 `MutationObserver` 和 WebSocket——在 UI 插件里属正常。按目录分层
（`lib/` 主体 vs `client/` UI）权重尚未实现。

# 0.3.7

ASAR 头部偏移修正（`readUInt32LE(4)`，此前用了 8 导致每个合法归档都被判无效），
并跳过 `unpacked: true` 条目（1583 个合法无偏移项）。

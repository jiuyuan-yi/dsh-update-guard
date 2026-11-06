# dsh-update-guard · 更新守卫

给 DeepSeek Harness 桌面端用的插件：**更新前检查插件会不会崩，崩了能自己修回来。**

起因很具体：一次版本更新后，界面加载到某个插件就不再出现，日志里只有一句 `is not a function`。更新器问了"要现在安装吗"，但没有任何东西检查过这个更新会不会把已装的插件打断。

## 两条腿

### 一、更新前检查

应用下载完更新、还没安装的时候：

1. 从安装包里解出**两套接口面**
   - 客户端：共享 UI 模块导出了哪些成员（浏览器半侧用）
   - 宿主：运行时提供了哪些服务名（纯宿主插件用）
2. 扫描已装插件实际用到什么
3. 只报告**用到了新版本里没有的东西**的插件

命中后可以自动锁定——在 `cordis.patch.yml` 里把那个插件的条目设为 `disabled: true`。锁的是**配置项，逐字节可还原**。

**两层证据，严格程度不同：**

| 证据 | 缺失后果 | 自动锁定 |
|---|---|---|
| 客户端成员（`UiPrimitives.xxx`） | 渲染时抛错，界面崩 | ✅ 会锁 |
| 宿主服务（`inject: [...]` 里的服务名） | 插件激活不了；若是 required 插件，整个应用起不来 | ❌ **只提示** |

宿主服务不自动锁，因为服务可能以扫描器没建模的方式动态提供，误报会锁掉正常插件。报出来，你自己判断。

没有解压器也不会失败：降级成"只比版本声明"（`engines.dsh` / `peerDependencies`），这本来就是加载器自己的检查。

### 二、崩了能修

在桌面挂一个启动包装器（`wscript` + 隐藏窗口，不带控制台）：

- 启动失败 → 重试 → 仍然失败就**弹框问你**要不要停用第三方插件（默认按钮是「否」）
- 发现插件配置被清空（比如点了官方的「禁用第三方插件」）→ **从备份还原，只跳过有问题的那个**
- `resources\runtime` 被更新器清空 → **从已下载的安装包解出来补回去**（见下）
- 快捷方式被改回直连 exe → 下次启动自动改回来
- 同一时刻只允许一个启动器；DSH 已在运行时不会起第二个进程

#### runtime 被更新器清空

桌面端升级时会清空 `<install>\resources\runtime`，而 `dsh-skill-office` 启动时用
`readFileSync` 读 `runtime\office-skills\office\SKILL.md`：文件不在就抛 ENOENT，
异常穿过 Fiber 直接让整个 host 起不来。2026-11-05 升级到 0.2.2-rc.1 时**连崩四次**，
只能重装恢复。

runtime 不在 `app.asar` 里，没法从别处补，所以启动器在 `Start-Process` 之前先查
一个探针文件（`SKILL.md`）；缺了就用 7-Zip 从 `pending` 里的安装包解出
`resources\runtime` 再启动。实测 10 秒、恢复 6144 个文件。

本机实测过完整链路：移走 `SKILL.md` 模拟更新器清空 → 启动器检出缺失 → 解包 →
启动成功。失败时只记日志并告警，不阻塞启动。

## 安装

需要 Node.js 18+、Windows、DeepSeek Harness 桌面端。

```bash
# 1. 放进 profile 的 node_modules
git clone <repo> "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-update-guard"
```

```jsonc
// 2. 编辑 <profile>/package.json，把它加进 bundle 列表
{
  "dsh": {
    "profile": {
      "bundles": [ "...", "dsh-update-guard" ]
    }
  }
}
```

重启应用。设置 → 通用 里会出现三行开关。

## 命令行

```bash
node bin/guard.mjs check          # 检查待安装的更新
node bin/guard.mjs check --json   # 机器可读
node bin/guard.mjs lock           # 锁定命中的插件
node bin/guard.mjs unlock         # 撤销全部锁定
node bin/guard.mjs restore        # 预演：配置被重置后会还原成什么样
node bin/guard.mjs restore --apply
node bin/guard.mjs config --set autoLock --value true
node bin/guard.mjs status

# 启动器（自愈腿）
node bin/guard.mjs launcher status           # 现在接管了什么
node bin/guard.mjs launcher restore --dry-run # 预演：会把图标指回哪
node bin/guard.mjs launcher restore          # 把快捷方式指回应用，删掉生成的脚本
node bin/guard.mjs launcher uninstall        # 上面这一步 + 配置改回 installLauncher=false
```

退出码：`0` 正常，`2` 发现不兼容，`1` 出错。

## 配置

`<profile>/.dsh-update-guard.json`

| 键 | 默认 | 说明 |
|---|---|---|
| `preflightOnStartup` | `true` | 启动时跑检查 |
| `autoLock` | `false` | 命中直接锁定，不询问 |
| `maxAutoLock` | `3` | 一次最多锁几个 |
| `autoRestore` | `true` | 配置被清空时从备份还原 |
| `installLauncher` | `false` | 是否接管桌面快捷方式（自愈腿）。**默认关闭**；打开会改桌面图标，关掉会把图标还原 |

## 覆盖范围

两类插件都要能看见，否则等于只查了一半：

| 插件类型 | 依赖什么 | 用哪套接口面查 |
|---|---|---|
| 有界面组件 | 共享 UI 模块的成员 | 客户端 |
| 纯宿主 | inject: [...] 里的服务名 | 宿主 |

宿主服务名从安装包的 pp.asar 里提取，识别三种注册形式
（ super(ctx,"name")、.provide("name")、.set("name",…) 以及

egisterService/defineService/static service），并额外收集运行时里出现过的
字符串常量作宽松兜底——**宁可漏报，不可误报**。

scripts/、	est/、docs/ 和 client.js（浏览器半侧）不计入宿主面。

## 检查状态（不把"没查"说成"通过"）

面板和 CLI 会明确区分四种状态：

| 状态 | 含义 |
|---|---|
| **完整检查** | 版本声明 + 接口面都比对过 |
| **部分检查** | 只比对了版本声明（没有解压器，或解包失败） |
| **发现风险** | 有插件命中，附清单 |
| **没有待装更新** | 当前没有已下载的更新 |

部分检查**不会**显示成"没有发现不兼容"。

## 测试用的环境变量

启动器读三个环境变量，只用于测试与无人值守：

| 变量 | 作用 |
|---|---|
| `DSH_LAUNCHER_PROFILE` | 指向别的 profile |
| `DSH_LAUNCHER_EXE` / `DSH_LAUNCHER_ARGS` | 指向别的可执行文件与参数 |
| `DSH_LAUNCHER_ANSWER` | 预置询问答案（`yes`/`no`），不弹框 |
| `DSH_LAUNCHER_QUIET=1` | 不弹任何对话框，只写日志 |
| `DSH_LAUNCHER_TEST_HIDE_WINDOW=1` | 测试专用：连应用窗口也隐藏。与 QUIET 分开，免得 QUIET 把主界面藏掉 |

## 解压器

NSIS 外壳只有 7-Zip 系能读。探测顺序：

1. 环境变量 `DSH_7Z` / `DSH_7ZA`
2. 包内 `vendor/7z.exe`
3. `PATH` 上的 `7z` / `7za` / `7zz`
4. 注册表 `HKLM\SOFTWARE\7-Zip\Path`
5. 常见目录（7-Zip、NanaZip）

都没有就降级到版本声明检查。设 `DSH_UPDATE_GUARD_NO_EXTRACTOR=1` 可强制降级。

> Windows 自带的 `tar.exe`（libarchive）能读内层 `app-*.7z`，但读不了 NSIS 外壳——实测报 `Unrecognized archive format`。

## 它不会做什么

- 不联网，不上报任何数据
- 不改插件代码，只改 `cordis.patch.yml` 里的 `disabled` 字段
- 不碰 `!!js` 之类的条件值（那是加载器的动态表达式，改写会破坏语义）
- 不判断自己
- 不写死任何绝对路径：安装目录从注册表 `InstallLocation` 问，profile 从 `DSH_PROFILE_DIR` 或 `~/.dsh/profiles/<名>` 取

## 测试

```bash
node test/all.mjs             # 一次跑全部；跳过会单独标 UNVERIFIED，不算通过
node test/launcher-flow.mjs   # 假应用驱动真实启动器：正常启动/失败/恢复失败后再启动
node test/diagnose-agreement.mjs # 诊断结论必须与启动器的真实行为一致
node test/tier-merge.mjs      # 两层结果必须合并且互不覆盖
node test/cache-hit.mjs       # 缓存真的命中，不重复解包
node test/launcher-repair.mjs # 损坏配置 / 结构缺失 / 主动精简 / 被重置 四种情况
node test/compat.mjs          # 版本范围与声明检查
node test/restore.mjs         # 外科式还原
node test/routes.mjs          # 面板接口
node test/client-bundle.mjs   # 浏览器半侧（假 window / 假 require）
node test/fresh-machine.mjs   # 虚构 profile：验证不夹带任何特定插件
node test/patch-safety.mjs    # patch 改写安全
node test/plugin-smoke.mjs    # 插件加载
node test/manifest.mjs        # dsh.client 声明按加载器规则校验
node test/e2e.mjs             # 真解包端到端
```

`e2e` 需要一份待安装的更新和能解包的安装目录；没有时会打印 `SKIP` 并以 `0` 退出。

## 真实环境验证

2026-11-05 做过一次真实的跨版本升级：0.2.1-rc.5 → 0.2.2-rc.1。

- **检查本身跑通了**：`tier: declared+surface`，15 个已装插件，0 个确认失效
- **但更新器清空了 `resources\runtime`**，`dsh-skill-office` 读不到 `SKILL.md`，
  host 连崩四次。这正是上面「runtime 被更新器清空」那一节要解决的问题，
  已在同一台机器上完整复现并验证修复

还没验证过的：从安装包恢复之后，DSH 在**功能层面**是否与全新安装等价
（文件数对上了，运行行为没逐项比）。其余场景按
[docs/real-env-checklist.md](docs/real-env-checklist.md) 逐条走。

## 已知限制

- 只在 Windows 上验证过（启动包装器依赖 `wscript.exe`）
- 「接口面比对」只看 4 个共享 UI 模块，宿主侧 API 改动不在覆盖范围
- 真实升级只走过一次（0.2.1-rc.5 → 0.2.2-rc.1），更早的版本对没有记录
- runtime 自愈依赖 `pending` 里还留着安装包；用户装完手动删掉就补不回来
- 自动还原的判定依据是**启动器自己记录的上次清单** + 补丁层证据；没有记录（首次运行）时不做任何推断
- 还原时的插件校验只做结构检查（包在、package.json 可解析、声明了 `dsh.bundle`、patch 文件在），**不启动插件验证运行时行为**：结构完整但接口不兼容的插件，还原后仍可能出问题
- 接口面比对只覆盖 4 个共享 UI 模块 + 宿主服务名；宿主侧 API 的**行为变化**（签名、语义）不在范围内

## 许可

MIT

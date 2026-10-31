# dsh-update-guard · 更新守卫

给 DeepSeek Harness 桌面端用的插件：**更新前检查插件会不会崩，崩了能自己修回来。**

起因很具体：一次版本更新后，界面加载到某个插件就不再出现，日志里只有一句 `is not a function`。更新器问了"要现在安装吗"，但没有任何东西检查过这个更新会不会把已装的插件打断。

## 两条腿

### 一、更新前检查

应用下载完更新、还没安装的时候：

1. 从安装包里解出新版本的**客户端接口面**（UI 模块导出了哪些成员）
2. 扫描已装插件实际用到哪些成员
3. 只报告**用到了新版本里没有的成员**的插件

命中后可以自动锁定——在 `cordis.patch.yml` 里把那个插件的条目设为 `disabled: true`。锁的是**配置项，逐字节可还原**。

没有解压器也不会失败：降级成"只比版本声明"（`engines.dsh` / `peerDependencies`），这本来就是加载器自己的检查。

### 二、崩了能修

在桌面挂一个启动包装器（`wscript` + 隐藏窗口，不带控制台）：

- 启动失败 → 重试 → 仍然失败就**弹框问你**要不要停用第三方插件（默认按钮是「否」）
- 发现插件配置被清空（比如点了官方的「禁用第三方插件」）→ **从备份还原，只跳过有问题的那个**
- 快捷方式被改回直连 exe → 下次启动自动改回来
- 同一时刻只允许一个启动器；DSH 已在运行时不会起第二个进程

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
| `installLauncher` | `false` | 是否接管桌面快捷方式（自愈腿） |

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

## 已知限制

- 只在 Windows 上验证过（启动包装器依赖 `wscript.exe`）
- 「接口面比对」只看 4 个共享 UI 模块，宿主侧 API 改动不在覆盖范围
- 从没在真实版本升级上跑过完整流程

## 许可

MIT

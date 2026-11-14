# 0.4.1

一次更新引发的三次崩溃，以及它们各自的根因。四个修复，一个新命令。

## 修：`check` 把"已装版本"当成待安装更新

更新器把跑完的安装包留在缓存里。旧逻辑看到缓存里有包就认为"有待安装更新"，
于是 `status` 永远在报一个更新，`check` 拿当前版本跟自己比对，还把它当成
"更新前的检查"。

现在比对已装版本，相同就判 `no-pending` 并说明原因。

## 修：启动器的探针把 `office-skills` 当必需项

探针按 0.2.2-rc.1 的目录布局写死了五个必需项，其中 `office-skills` 在 rc.3
的安装包里**一条都没有**（`app-64.7z` 里 grep 计数为 0）。

后果是：runtime 被清空后，自愈每次解包都成功，但探针永远找不到那个目录，
判失败 → 阻止启动 → 再试一次 → 同样的结果。22:05 到 22:07 循环了五六轮。

现在必需项只留各版本都有的四个（`versions.json` / `bin` / `cli` /
`primary-runtime`），`office-skills` 改成「存在才校验」。

## 修：启动器互斥锁名拼了 profile 名

```powershell
'dsh-update-guard-' + ((Split-Path $Profile -Leaf) -replace ...)
```

两次启动只要解析出的 profile 不同，拿到的就是两把不同的锁，互斥形同虚设。
22:20 那次正是两个实例各拿一把锁、都通过进程检查、同时拉起、共用一个 profile
撞死（主进程连本地 host 被 `ECONNRESET`，判启动失败退出）。

锁名改成固定常量 `dsh-desktop-launcher-single-instance`。实测：

```
first=True     ← 第一个拿到锁
second=False   ← 第二个被挡住
```

## 修：自愈只有单一来源

自愈只找 `pending\`。更新器装完常把这个目录清掉，自愈就在最需要它的时候断源。

现在是三层，按新鲜度排：

```
1. pending\                       已下载待安装
2. cache 根 installer.exe         更新器装完留下的
3. dsh-update-guard\installers\   自己的底（299 MB）
```

前两层都在更新器缓存里，它清缓存就一起没了；第三层在插件自己目录下，更新器
不会碰。三层都空才报错。

**注意**：生成器只在 `exe / profileDir / pkgDir` 变化时重建 `dsh-launch.ps1`，
改代码内容不会触发。修改 `launcher.mjs` 后必须删 `rescue/.generated.json`
强制重建，否则改动不会生效。

## 新：`check --remote`

`check` 原本必须有已下载的安装包才能跑，而"下载完成 → 弹窗 → 重启"之间只有
几十秒，人一按重启检查就没了。`check --remote` 跳过下载，直接读更新源：

```bash
node bin/guard.mjs check --remote
```

它读 `resources/app-update.yml` 拿到 feed 地址和渠道，拉对应 YAML，给出：

- 线上版本 vs 已装版本
- 版本跨度（major / minor / patch / prerelease / same）
- 声明范围层面的检查（这一层只需要版本号，不需要安装包）

```
渠道   : nightly
已装   : 0.2.2-rc.3
线上   : 0.2.2-rc.3
跨度   : same version
```

## 新：cookie 仓库可以只读查看

`lib/cookies.mjs` 与 `prune-cookies.py --list`。桌面端每次启动绑一个随机
loopback 端口，宿主按 `host:port` 命名 auth cookie，RFC 6265 按 (domain, path,
name) 去重，于是每个端口都新增一条永不失效的 cookie。到 70 条左右请求头越过
Node 的 16 KB `maxHeaderSize`，所有请求在解析头时就被拒掉。

`--list` 只打印当前有多条，不改任何东西——排查"到底堆了多少"时不用先动手。

## 测试

31 个，无跳过。新增 `test/feed.mjs`（feed 解析、版本跨度、异常输入）。
`test/e2e.mjs` 在机器上没有待装包时明确跳过接口比对阶段并以 3 退出，
而不是读 undefined 崩掉。

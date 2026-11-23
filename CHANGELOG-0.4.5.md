# 0.4.5 — runtime 自愈不再破坏现场，完整性判定改用基线

三处结构性修复，全部来自 2026-11-14 那次真实事故的日志（`rescue/launch.log` 22:05–22:07，连续失败 21 次）。

## 修：解包不再直接覆盖线上目录

**旧行为**：`7z x app-64.7z resources\runtime\* -o<installRoot> -y`
直接把文件解进正在使用的 `resources\runtime`。

**11-14 的失败原文**：

```
22:05:16  runtime 自愈异常: ERROR: Cannot delete output file : 另一个程序正在使用此文件
          : D:\deep\resources\runtime\primary-runtime\dependencies\python\tcl\tix8.4.3\demos\samples\EditGrid.tcl
22:05:16  runtime 自愈失败：解包已完成但探针文件仍然不存在
22:05:16  runtime 仍不完整：停止启动；需要修复或重新安装当前版本
```

解到一半撞上被占用的文件 → `versions.json` 没写出来 → 探针判不完整 → **目标目录已经被改坏一半**。

**新行为**：

1. 解到 `%TEMP%\dsh-runtime-restore-<pid>\stage`，线上目录全程不动
2. 暂存目录自检：文件数下界 + `versions.json` / `bin` / `cli` / `primary-runtime` 四个探针
3. 自检通过才替换：旧目录 `Move-Item` 到 `runtime.old-<ts>`，新的移入
4. 任何一步失败都回滚到旧目录

线上 runtime 因此只有两种状态：**旧的完整**或**新的完整**。

## 修：失败后退避 10 分钟

**旧行为**：每秒重试一次，每次都重解 290 MB。11-14 在 90 秒内触发 21 次。

**新行为**：失败写 `%TEMP%\dsh-runtime-restore.last-fail`，10 分钟内不再尝试，日志直接说明原因并给出标记文件路径。成功时删除标记。

## 修：完整性判定从写死 5000 改为基线

**旧行为**：`if ($files -lt 5000) { return $false }`

问题有两个：版本间文件数会变（rc.1 是 6144，rc.5 是 6136），而且"缺 600 多个文件"这种半坏状态照样过线。

**新行为**：首次通过检查时记下基线（文件数 + `versions.json` 的 SHA256）到 `rescue\runtime-baseline.json`，之后按基线的 95% 判定。

以当前 rc.5 的 6136 为例：

| 实际文件数 | 旧逻辑（<5000） | 新逻辑（<95% × 6136） |
|---|---|---|
| 6136 | 完整 | 完整 |
| 5830 | 完整 | 完整 |
| 5500 | **完整**（漏判） | 不完整 |
| 5000 | 完整（临界） | 不完整 |

没有基线时（首次运行、基线文件被删）退回旧的 5000 阈值，不会因为缺基线就不能启动。

## 修：cookie 清理不再"假装成功"

**现象**：`launch.log` 里 19 次记录全是 `cookie prune: PRUNE kept=0 removed=0`。

**查证**（2026-11-22）：

```
Network\TransportSecurity         11-22 19:48   ← 今天在写
Network\Network Persistent State  11-22 19:41   ← 今天在写
Network\Cookies                   11-14 21:52   ← 8 天没动
```

同目录其它文件每天都在更新，只有 cookie 库停在 11-14。宿主从那一刻起就不再写这个库了——所以 `kept=0` 是准确的，但这个保护对新版本已经没有作用对象。

**新行为**：库超过 7 天没有写入时，日志改为

```
cookie prune 跳过：cookie 库 7 天未被宿主写入（最后 2026-11-14）—— 当前宿主版本已不使用该库，此保护无作用
```

不再输出一行看起来正常的 `kept=0 removed=0`。

## 修：`package.json` 里两个版本号对齐

`version` 与 `dsh.version` 从 0.4.4 起就不同步（后者停在 0.2.15）。这次一起改成 0.4.5。

## 验证到哪一步

```
node --check lib/launcher.mjs                    OK
rescue\dsh-launch.ps1  pwsh 7 解析               PARSE-OK
生成物 527-576 行  基线读写逻辑                   ✓
生成物 663-679 行  原子替换段                     ✓
基线阈值模拟（6136 → 下限 5829）                  ✓
```

**没有验证的**：暂存解包 + 原子替换在"文件被真实占用"条件下的表现。要复现需要人为占住一个 runtime 文件句柄再触发修复，尚未做。

## 已知未处理

- 解包不比对版本号：`pending` 里若是新版本、已装是旧版本，仍会把新 runtime 解进旧安装
- 崩溃后仍只有"停用全部插件"一个选项
- 日志没有轮转，测试与真实运行混在一起

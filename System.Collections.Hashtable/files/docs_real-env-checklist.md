# 真实环境验证清单（等下个 DSH 版本）

模拟测试只能证明**流程逻辑**对，证明不了真实插件的运行时行为。
这份清单是给真实升级那天用的，按顺序做，每步记下结果。

**不要把模拟通过当成这一页通过。** 两件事是不同的。

---

## 0. 升级前：建立基线

```powershell
cd D:\dsh\plugins\dsh-update-guard
node bin\guard.mjs status
node test\all.mjs          # 期望：全部 PASS，无 UNVERIFIED
```

记录：

| 项 | 值 |
|---|---|
| 当前版本 | |
| 插件数（第三方） | |
| `test\all.mjs` 结果 | |

备份整个 profile（这一步现在还得手工做，没有内置快照）：

```powershell
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop" `
          "D:\dsh\backup\profile-before-<版本号>" -Recurse
```

---

## 1. 更新前检查（核心，最该验的一条）

在应用里点下载，**不要点安装**。

```powershell
node bin\guard.mjs check
```

要看的三件事：

- [ ] `检查层级` 显示 `版本声明 + 接口面比对`（不是"仅版本声明"）
- [ ] `待安装版本` 是新版本号
- [ ] 结论与预期一致——如果它说没问题，事后真的没问题；如果它点名某个插件，事后那个插件真的坏了

**把完整输出保存下来**，这是唯一能验证"判得准不准"的证据：

```powershell
node bin\guard.mjs check | Tee-Object D:\dsh\backup\check-<版本号>.txt
```

---

## 2. 版本声明冲突

如果 1 里点名了插件，核实它确实声明了不兼容：

```powershell
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\<插件>\package.json" |
  Select-String "engines|peerDependencies" -Context 0,3
```

- [ ] 报告里的 `range` 与 `package.json` 里一致
- [ ] 报告里的 `实际要装` 与安装包版本一致

---

## 3. 插件接口缺失

如果 1 里报告了"缺少 xxx 成员"：

- [ ] 升级后打开那个插件对应的界面，确认它真的坏了
- [ ] 如果没坏，说明检查误报——记下来，这是准确性问题

---

## 4. 正常升级

点安装、重启。

- [ ] DSH 能正常启动（桌面图标直连时）
- [ ] `设置 → 通用` 里三行开关还在
- [ ] 最近一次检查的结论显示正常

### 4.1 runtime 有没有被更新器清空

桌面端升级会清空 `<安装目录>\resources\runtime`。`dsh-skill-office` 启动时读
`runtime\office-skills\office\SKILL.md`，读不到就 ENOENT，整个 host 起不来
（2026-11-05 连崩四次）。启动器现在会在 `Start-Process` 之前补回它。

```powershell
Test-Path "D:\deep\resources\runtime\office-skills\office\SKILL.md"
```

- [ ] 返回 `True`
- [ ] 如果返回 `False`，看 `rescue\launch.log` 里有没有 `runtime 自愈` 的记录
- [ ] 如果自愈失败，确认 `pending` 目录里还留着安装包——装完手动删掉就补不回来了

---

## 5. 启动失败与恢复

**只在隔离环境做**。不要让主力环境进入失败状态。

准备：复制一份 profile 到临时目录，装一个必然崩的插件（例如把某个插件的 `client.js` 改成 `throw new Error('test')`）。

```powershell
node bin\guard.mjs launcher restore --dry-run   # 先看会改什么
```

- [ ] 启动失败后**重试**，不是立刻停用
- [ ] 连续失败后弹框询问，默认按钮是「否」
- [ ] 选「否」时配置文件**一个字节都没变**
- [ ] 选「是」时才停用第三方，且留下 `package.json.bak-launcher-*`

---

## 6. 配置意外重置

在隔离环境里，把 `cordis.patch.yml` 改名、把 `package.json` 的 bundles 砍到只剩官方（模拟官方按钮的行为）。

- [ ] 下次启动自动还原，且**只跳过坏的那个**
- [ ] 日志里写明依据（上次 N 个 → 现在 0 个）
- [ ] 留下 `package.json.bak-restore-*`

---

## 7. 用户主动删除插件（不能误恢复）

在隔离环境里，正常地删掉几个插件（不是清空），保留补丁文件不动。

- [ ] 下次启动**不还原**
- [ ] 日志里写明"缺少补丁层证据"或"上次记录里也没有"

---

## 8. 配置损坏

在隔离环境里，把 `package.json` 写成 `{ broken`。

- [ ] 启动后能自愈
- [ ] 原文件留证为 `package.json.bak-corrupt-*`
- [ ] 其它自定义字段（如果有）保留

---

## 9. 恢复失败后再次启动

保持隔离环境里的坏插件，连续启动两次。

- [ ] 第二次不会继续破坏配置
- [ ] 不会无限重启

---

## 10. 收尾

```powershell
node test\all.mjs
node bin\guard.mjs launcher status
```

- [ ] 全部 PASS，无 UNVERIFIED
- [ ] 桌面快捷方式指向正确（直连 exe 或经启动器，与配置一致）

对照第 0 步的基线，确认插件数量、版本号的变化都在预期内。

---

## 已知能力边界（不要用这份清单去验证它们）

| 做不到 | 原因 |
|---|---|
| 验证插件**运行时行为** | 只比对导出名，不比签名与语义 |
| 版本回滚 | 不保留旧版本文件 |
| 整个 profile 快照 | 只有文件级 `.bak-*` |
| 跨平台 | 只在 Windows 验证过 |

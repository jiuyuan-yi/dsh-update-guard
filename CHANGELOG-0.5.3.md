# 0.5.3 — 0.5.2 的修订：worker 支持显式安装根

0.5.2 的 worker 套件在**没有安装 DSH 的机器**上会失败：`analyse` 找不到安装根时返回 `stage: 'error'`，而测试断言的是 `no-pending`。等于用测试去断言"这台机器装了 DSH"，而不是 worker 的行为。

改了两处：

- `lib/analysis-worker.mjs` 接受可选的 `installRoot` 并透传给 `analyse`。生产调用不传，仍然走 `findInstallRoot()`。
- `test/analysis-worker.mjs` 显式指向一个空的假安装根，结论在任何机器上都一样。

CI 已转绿。0.5.2 的其余内容（worker、面板来源校验、原子写、补丁并发检查）未变。

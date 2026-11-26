# 0.5.2 — 宿主不再卡界面、写盘不再半截、面板写操作只认本机

三项都不是新功能，是"能用但在特定条件下不对"的地方。

## 修：分析不再占用宿主的线程

`analyse` 里有同步 `execFileSync` 调 7-Zip（单次 180 秒、最多 4 次），还有一次约 175 MB 的 `app.asar` 读取。它原本跑在 Cordis 上下文的线程上，`setImmediate` 只是把它推迟，没有让出线程——第一次遇到待安装更新时，整个桌面界面会跟着停住。

现在放进 `worker_threads`：阻塞的是 worker，主循环照常。

没有用 `child_process.fork`：打包后的应用里 `process.execPath` 是 DSH 自己的可执行文件，拿它再起 node 需要 `ELECTRON_RUN_AS_NODE`，而该 fuse 可能在打包时被禁用。worker 不依赖这一点。

超时 15 分钟后终止 worker，避免解包器卡死时留下线程。

## 修：面板的写操作只接受本机来源

`PUT config` 和 `POST lock` 之前没有来源校验。服务监听在 127.0.0.1，但**请求方可以在公网上**——一个网页就能让宿主改写 profile。

两道检查：

- `Origin` 存在时必须是 loopback（`127.0.0.1` / `localhost` / `::1`）；不存在时放行，因为同源或非浏览器调用不会伪造它，而浏览器一定会带。
- 带 body 的写必须声明 `application/json`。`text/plain` 是 CORS 的"简单请求"，不触发预检，恶意页面可以用它投递 JSON——要求 JSON 类型就把预检逼出来，再由来源检查拦下。

## 修：配置写入原子化

`restore.mjs` 的 `applyRestore` 直接用 `writeFileSync` 覆写 `package.json`——而它正是这个工具要修的文​​件，写一半崩溃等于自己制造事故。现在统一走 `lib/atomic.mjs`：临时文件 + rename，带三次短退避重试（Windows 上杀软或索引器短暂占用会让 rename 报 EPERM，那不是真失败）。

顺手覆盖了 `cordis.patch.yml`、守卫配置和报告缓存。

## 修：补丁读改写会检查并发

`lockIds` 现在在写之前重读 `cordis.patch.yml`：如果内容在这期间被别人改过（设置面板和 CLI 都能写），**中止并报错**，而不是拿旧内容覆盖。失败比覆盖安全——什么都没改，重试即可。

## 验证

41 项测试全过。新增：

- `test/analysis-worker.mjs`：worker 返回结构化结果、连续调用不泄漏、**事件循环在分析期间仍在推进**（这条是 worker 存在的理由，普通单测看不到）；
- `test/atomic.mjs`：覆盖写、无临时文件残留、目录缺失时抛错而不是静默丢弃、`retries:0` 不额外等待；
- `test/routes.mjs` 新增外站 Origin 403、`text/plain` 415、本机 Origin 与无 Origin 放行。

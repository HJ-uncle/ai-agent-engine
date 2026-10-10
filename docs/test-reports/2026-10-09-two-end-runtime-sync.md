# 2026-10-09 引擎 / SDK / Aether 客户端运行时同步验收

本报告覆盖 `D:\dev\ai-agent-engine` 的引擎、SDK 嵌入运行时，以及 `D:\dev\aether-code` 的安装包引擎资源。客户端完整 Electron E2E 由独立验收任务执行，其结果应以对应报告为准。本报告不把 API inject 或 Node 烟测写成界面验收。

最终主引擎构建身份：`sha256:a8a89f73942f86f277f1b807f296a9cbc0e16248ca7efadea9c3e0c78625f9b9`。主服务 `12323` 没有被重启；SDK 真实启动测试选择独立随机空闲端口，包内取消测试只用 Fastify inject，不绑定端口。此次保留原有客户端与引擎脏改动。

## 已确认并修复的问题

1. **不可复现的依赖锁。** 原 `package-lock.json` 把 CodeGraph 登记为不存在的 `../codegraph` link / 1.6.2，实际已安装的是正规 npm 1.6.0。客户端准备脚本正确拒绝此锁。恢复正规 1.6.0 registry 包和平台包，删除失效外部路径 / link，包声明未改变。进一步发现 12 项生产依赖的实际版本与锁不一致；移除有误的 npm 隐藏安装索引后按锁修复实际安装，npm 报 29 packages changed。生产依赖再次逐项审计为 0 差异。没有放宽 staging 的路径、符号链接或版本检查。
2. **SDK 默认入口与产物位置错位。** ESM 模块实际在 `bin/dist`，原默认启动 `bin/main.js` 的相对 import 指向不存在的位置。默认入口改为 `bin/dist/main.js`，历史 `bin/main.js` 保留为导入该入口的兼容 shim。
3. **SDK 自定义入口未实际使用。** `processManager` 原固定执行 `main.js`，现在执行调用方的显式 `binPath`，同时支持 writable `cwd`、隐藏 Windows 子进程窗口。
4. **SDK 与客户端 skills 启动器不同步。** Windows 精确目录名 `SKILLs` 避免误把 `dist/skills` 当技能资源；继承的 `SKILLS_ROOT` 继续生效。
5. **SDK 数据库文件契约。** 默认改为 `data/agent.db`，保留历史 `dataDir` 目录参数，目录路径自动追加 `agent.db`；指定 `.db` 文件仍直接使用。
6. **HTTP 实例关闭后的后台轮询残留。** 包内真实取消验收完成后，测试进程因 `tasks.ts` 模块级轮询无法自然退出。队列改由每个 Fastify 实例拥有，`onReady` 启动、`onClose` 停止。真实两个 HTTP 实例的回归验证了独立计时器、关闭一个后另一个仍运行、全部关闭后 Node 自然退出，没有 mock `start()`。
7. **Cron 停止后重新创建轮询。** 继续追踪真实包内残留资源发现 `CronScheduler.start()` 的初始对齐 `setTimeout` 没有被记录，`stop()` 只清理 interval，初始 timeout 到期后仍会创建永久 interval。现在记录 / 清除初始 timer，回调检查 `running`，HTTP 实例关闭自动停止 scheduler；补首次 tick 前停止、start-stop-start 以及真实 Node 自然退出回归。
8. **单机 Cron 请求缺失实例令牌。** 实际实例门禁没有 Cron 例外，原内部请求会被客户端 embedded 实例拒绝为 401。固定 loopback 调用现在透传进程实例令牌，并拒绝重定向；真实 HTTP 测试确认缺 token 的普通调用 401、Cron 到达受保护 handler、不会将 token 发往远端或 307 跳转目标。没有引入公开的认证绕过。

本轮同步还包含根任务完成的 Anthropic 温度透传修复：显式温度包含 `0`，兼容网关保留所选参数，原生 extended thinking 使用协议规定的温度 `1`。对应 12 项参数测试和 21 项流式测试已计入全量回归。

## 构建与验证

| 验证 | 最终结果 | 证据 |
|---|---|---|
| 引擎全量 Vitest | **127 文件通过，1311 项通过 / 1 平台跳过**，57.34 秒 | `.tmp/two-end-final-synchronized-suite-20261009.log` |
| 引擎 + SDK full 构建 | **通过**，TypeScript 编译检查通过 | `.tmp/two-end-final-synchronized-build-20261009.log` |
| 真实队列关闭回归 | **通过**，2 个独立 Fastify 实例自然关闭退出 | `.tmp/two-end-task-poller-regression-20261009.log` |
| Cron + 队列生命周期 | **4 项通过**，首次 tick 前停止、重复启停、真实 Node 退出、两个 HTTP 实例独立队列 | `.tmp/two-end-scheduler-lifecycle-regression-20261009.log` |
| 单机 Cron HTTP 认证 + 生命周期 | **7 项通过**，包含真实实例 token 认证、remote 目标拒绝、重定向拒绝 | `.tmp/two-end-scheduler-auth-regression-20261009.log` |
| SDK 真实嵌入启动 | **通过**，默认入口 + 目录、默认入口 + 文件、自定义改名入口，以及精确 / 继承 skills 配置共 5 组检查 | `.tmp/two-end-sdk-smoke-20261009.log` |
| 客户端 prepare / verify | **通过**，414 包，18710 文件，752965993 bytes，bundled Node 24.20.0 | `D:/dev/aether-code/.e2e-tmp/two-end-runtime-prepare-20261009.log` / `two-end-runtime-verify-20261009.log` |
| 三份 dist 逐文件 SHA256 | **通过**，281 个生产文件，SDK / client 共 562 次比对，18710 个 staging 文件逐项重读 SHA，0 差异 | `.tmp/two-end-artifact-parity-20261009.json` |
| 包内真实取消 / DB 完整性 | **通过且自然 exit 0**，6 个 child-owned 写入进程停止、5 个同时取消、单次失败恢复、SQLite 两项完整性通过，关闭后引用计时器为空 | `.tmp/two-end-packaged-cancel-smoke-20261009.log` |
| 完整 npm 式 TGZ | **已生成**，228308855 bytes，18711 文件，`package/` 根与包内 manifest 已确认，客户端真实导入 / 激活由完整 E2E 验收 | `.tmp/runtime-artifacts/aether-engine-2.0.0-a8a89f73942f.tgz` |

唯一引擎平台跳过是 Windows 文件名控制字符规则不允许该用例创建测试文件。客户端 E2E 跳过需独立统计，不与本表混合。

精确命令：

```powershell
# D:\dev\ai-agent-engine
npm install @colbymchenry/codegraph@1.6.0 --package-lock-only --ignore-scripts --no-audit --no-fund
# 保留原 node_modules/.package-lock.json 后删除该单个索引，强制 npm 核对实际安装版本
npm install --ignore-scripts --no-audit --no-fund
npm run build:sdk
node node_modules/vitest/vitest.mjs run src --maxWorkers=4 --minWorkers=1 --reporter=dot
npm --prefix sdk-package run test:embedded

# D:\dev\aether-code
npm run prepare:engine
npm run verify:engine

# D:\dev\ai-agent-engine
node .tmp/two-end-artifact-parity.mjs
& D:\dev\aether-code\resources\engine\win32-x64\runtime\node.exe .tmp/two-end-packaged-cancel-smoke.mjs D:\dev\aether-code\resources\engine\win32-x64
```

`sdk-package/scripts/smoke-embedded-runtime.mjs` 已保留为可重复运行的正式脚本（`npm --prefix sdk-package run test:embedded`）。包内取消夹具和结果保留在 `.tmp/two-end-packaged-cancel-*`，SDK 真实启动夹具保留在 `.tmp/two-end-sdk-smoke-*`。

最终 SDK 验收结果：`.tmp/two-end-sdk-smoke-Upra26/result.json`。最终包内取消业务结果：`.tmp/two-end-packaged-cancel-yZRoDL/result.json`。所有对应工具进程已确认自然退出，专用脚本进程查询无残留。

最终构建身份与制品 SHA256：

| 对象 | SHA256 |
|---|---|
| 构建 ID | `a8a89f73942f86f277f1b807f296a9cbc0e16248ca7efadea9c3e0c78625f9b9` |
| 三端相同 build-manifest.json | `d6bb542534255612c7131252e142db4380f7dfa0771045437984fa8225f3299b` |
| 客户端 stage-manifest.json | `221352ffa5d9e54c541fcf35aaf898eed898a7bc0534f46a3a1381282c356c43` |
| 正规依赖 package-lock.json | `49dbd981cdec849abb3d5c2fb9008c31a4d7b5a1eb41c79ca835186d18928704` |
| 最终可导入 TGZ | `bc4c4e7bdf6af9529c92318f860894d6431a0c6b77f45e3dc9a99eed0722ffde` |

## 包内验收边界

客户端 `verify-engine-runtime.mjs` 现在直接导入打包的 `LocalSqliteProcessClient`，使用包内 standalone Node。验证 50 个并发事务、提交后的队列释放、回滚、PRAGMA 不丢失、bigint / blob / 中文行值传输、关闭 / 重开 / 持久化、SQLite `quick_check`，并通过包内记忆数据库与管理器完成 CRUD、tags 和全局 / 会话隔离检查。原 CodeGraph ESM loader / TypeScript 索引 / 符号查询 / 重开、PTY native loader、TypeScript language server、技能检查保留。

包内取消测试创建真实 child-owned 写入进程。一次 `SQLITE_BUSY` 是**主动注入的单次根状态写入失败**，用于证明 HTTP 200 + failure body 的既有契约仍被保留、命令进程仍立即停止、重试能恢复根状态；不能计为真实负载下出现的 SQLite busy。另验证 5 个会话同时取消并与主库事务重叠、根状态 / command 状态一致、控制器中止、6 个写入进程停止，以及 `quick_check` / `foreign_key_check`。

客户端实际启动消费路径为 `src/main/engine/{runtime.ts,host.ts,sdk/process-manager.ts}`；渲染 HTTP / SSE 消费路径为 `src/renderer/src/core/engine/{client.ts,useChat.ts}`。客户端已经使用显式脚本入口和精确 skills 目录探测，本次不需要改动这些源码。HTTP / SSE 数据协议没有改变。

## 历史失败保留

- 首次 `prepare:engine` 因不存在的 CodeGraph 外部锁路径失败；日志保留 `two-end-runtime-prepare-original-lock-failure-20261009.log`。
- 锁修复后继续发现实际 multipart 版本不符；最终按锁统一安装后才通过。
- SDK 烟测最初请求了不存在的 `/engine/meta`，HTTP 404；正确产品路径是 `/meta`。这是烟测路径错误，日志保留 `.tmp/two-end-sdk-smoke-wrong-meta-path-20261009.log`。
- 第一版包内取消业务断言均通过，但 HTTP 关闭留下 task poller，进程未自然退出；根据该真实证据修复生命周期后复验。
- 队列修复后继续追踪确认初始 cron timeout 会在 stop 后重建 interval；根据唯一剩余 ref timer 堆栈修复。旧测试进程持有包内 Node 文件句柄，一次 prepare 因 EPERM 被正确拒绝，仅回收已确认的专用旧测试进程后重新同步。
- Windows 系统 bsdtar 不支持 `-s` 前缀重写；采用实际 `package/` 布局后，该归档器压缩进程仍 native 崩溃（exit `0xC0000005`），未输出有效 TGZ。最终使用 bundled Python 标准库 `tarfile` / PAX / gzip level 1 成功生成真实 package 根制品，没有使用损坏归档。该失败是系统 tar 进程，不是引擎服务。

本轮结果不等于 4–5 小时或 7×24 小时稳定性已验证，不等于已生成并分发安装包，也不等于用户当前运行的客户端 / 12323 服务已经切换到新构建。持续项目开发和 5 会话真实模型负载由根任务单独记录。

**明确未通过项：`AUTH_ENABLED=true` 的多租户 Cron 自动执行。** 现有 scheduler 的 enabled 列表跨租户，而 HTTP fireJob 没有用户认证 / 租户上下文；单机实例 token 修复没有也不应绕过账户认证。完整支持需要服务内部派发并以 job.tenantId 绑定权限，不能把管理员 JWT / 用户密钥复制到任意 Cron 任务。本轮正式 5 会话负载是客户端单机模式；不能据此声明多租户定时任务已经验收。

只读核实真实用户运行时选择：`Roaming/aether-code/settings.json` 的 `engineMode=embedded`，`engine/runtimes/active-runtime.json` 的 `id=null`，没有固定在旧导入包。旧 `sha256:0af1d55a…` 导入包仍保留但未选中；开发默认取同级引擎 `dist`，安装版本默认取 `resources/engine`。用户明确选择的导入包继续保留其版本选择，设置已有“恢复默认引擎并重启”入口；本轮没有修改该指针。

## 冻结后下一项：多租户 Cron 内部派发

此项是具体待办方案，**正式 5 会话测试期间没有修改产品实现**。当前 `CronStore.listEnabled()` 会列出全部 tenant 的任务；`fireJob()` 未传该 tenant，也未保存用户认证，`AUTH_ENABLED=true` 下不能执行。不能通过允许 `cron-*` 请求 ID 绕过认证来修复，因为外部请求可伪造此头。

建议实现由服务实例持有的内部派发接口：HTTP chat 路由与 Cron 调用共同复用创建根运行的 service，并由不同入口分别建立可信 context。HTTP 入口继续使用真实 `authContext`；Cron 入口从已持久化 job 取不可变 `tenantId`、绑定其可访问的 session / agent / model / workspace，而不是重新调用公共 HTTP 或发送管理员身份 token。内部 dispatcher 不能暴露成可由浏览器任意调用的 API，也不能把 token / API key 放入 Cron payload /日志。

建议任务顺序与验收门槛：

1. **提取统一 chat service。** 先保持 HTTP / SSE 当前协议，分离 `chat.ts` 路由的请求解析、根运行创建、权限与执行上下文。测试现有用户 chat、resume、cancel、pending 和 SSE 事件序列无变化。
2. **绑定 Cron tenant 与配置。** `CronJob` 已有 tenantId，内部 dispatcher 的 run context 必须由 store 读取；检查 session / agent / model / workspace 都属于同 tenant。若资源已删除或模型禁用，应留下明确失败状态而不转入 default tenant。
3. **加入 durable 执行记录与幂等键。** 为 `(jobId, plannedAtMinute)` 建唯一执行身份，进程重启 /重复tick不能同时派发两次；只在实际 admission /终态明确后更新 lastRunAt，不在异步 fire 报401时伪装成功。
4. **加入运行所有权。** scheduler.stop /server.close 取消 owned in-flight jobs并等待结束；避免长任务每分钟重叠创建，支持显式的排队 /跳过策略；root与child命令都可回收。
5. **真实多租户验收。** AUTH_ENABLED=true、实例token启用、两个租户拥有同名session/agent/model，Cron运行只触及各自文件/记忆/历史。外部伪造Cron头、猜jobId、跨租户读写均拒绝。验收JWT / account session变更、模型删除、重启幂等、断网、执行失败、重复tick、停止时正在运行的任务，以及真实SSE历史回放。

完成这些门槛后再安排 4–5 小时与 7×24 小时调度型压测。当前单机 Cron token 修复和最长约半小时的并发负载不能代替该验收。

## R1 上下文故障修复后的最终同步

上文 `a8a89…` 是客户端 758 项全量验收使用的冻结基线。实际 R1 五会话测试发现本地上下文预算错误后，本节记录后续修复；不能把原 R1 的失败改写为通过。

R1 会话 1 三次失败是引擎本地 `CONTEXT_LIMIT`，未再次调用模型。请求估算把模型适配器不发送的全部 `metadata` 当成输入，包括完整文件差异、子 Agent 回放等。首轮历史的存储 token 计数是 19,650，低于保留预算 25,600，压缩器无操作却记录为完成；请求检查却估成 132,561，超过 Qwen 的 128,000。两次立即重试增加用户指令，错误数字继续升为 135,821 / 138,002。

修复包含：

- 预算只统计模型消费的消息内容、工具调用参数/ID、适用的 assistant reasoning、系统提示词和工具定义；完整 UI / 回放 metadata 继续保留。
- SQLite 与 JSONL 共用同一模型输入计数和切分逻辑。保留预算按完整工具交换执行，包括交错的并行调用 / 结果，真实大参数不会因旧 `tokens=0` 而跳过压缩。自动压缩启用 `force`，日志同时记录请求级压缩前后估算。
- Code 模式继续省略供应商输出上限，但本地预留有限的下一次回答空间；128K 模型为 6,400，不再把 `undefined` 当成输出预算显示。
- 摘要输入包含工具名称、路径与参数证据，用户和 system 指令逐字保留。SQLite 写入 / 压缩重建在调用方只提供 `toolCall.id` 时也保存 ID。
- 根 Vitest 入口不再误运行 `.tmp` / 保留项目 / `scripts/longrun` 的独立原生测试。原生驱动与项目合同仍通过各自运行器独立执行，未排除任何 `src` 用例。

真实 R1 JSONL 以失败时刻截取，在独立临时夹具中只读回放；保留原系统提示词和工具定义的额外贡献，仅替换消息估算差额：

| 尝试 | 原完整请求估算 | 修复后完整输入估算 | 加 6,400 输出预留 | 128K 窗口 |
|---|---:|---:|---:|---|
| 0 | 132,561 | 47,928 | 54,328 | 可容纳 |
| 1 | 135,821 | 51,111 | 57,511 | 可容纳 |
| 2 | 138,002 | 53,214 | 59,614 | 可容纳 |

回放没有调用真实供应商、没有编辑原始历史，也不等于 R2 实时负载已经通过。证据为 `.tmp/context-budget-r1-replay-20261009.json`，脚本 `.tmp/context-budget-r1-replay.ts`。

修复后已完成验证：

- 上下文 / 两种历史 / 手动压缩针对性回归：**47 / 47**。
- 根 `npx vitest run`：**129 文件、1,324 通过、1 个既有 Windows 跳过**，42.90 秒；`.tmp/two-end-context-final-suite-20261009.log`。
- `npm run typecheck`：通过；`.tmp/two-end-context-final-typecheck-20261009.log`。
- 独立原生驱动 / 分析器 / 浏览器验证：**28 / 28，零跳过**；`.tmp/two-end-context-native-harness-20261009.log`。
- `npm run build:sdk`：通过；`.tmp/two-end-context-final-build-20261009.log`。
- SDK 包内真实启动 / 配置检查：**5 / 5**；`.tmp/two-end-context-sdk-smoke-20261009.log`，业务结果 `.tmp/two-end-sdk-smoke-1lp7un/result.json`。

新版构建 ID 为 `sha256:533c76315ca92ded4a0daa4bf4a0402a4b5108fafb4387b921e091ec77c18843`。错误测试入口的末次失败记录保留在 `.tmp/two-end-context-discovery-failure-20261009.log`，当时 1,324 个源代码功能测试已通过，失败项是 3 个错误运行器入口；修正后根命令完整通过。

最终包内同步验证已全部通过：

- 客户端 `prepare:engine` / `verify:engine`：414 个生产包、18,712 个文件、752,968,398 字节；standalone Node 24.20.0，ABI 137 / N-API 10。真实隔离进程 SQLite 50 个事务、提交 / 回滚 / PRAGMA / bigint / blob / 重开、记忆 CRUD 与作用域隔离，以及 CodeGraph / PTY / TypeScript LSP / 7 个技能均通过。
- 引擎、SDK 和客户端的 **283 个生产 dist 文件、566 次成对哈希核对**通过；客户端 **18,712 文件**整个 stage 清单核对通过，差异 0。证据 `.tmp/two-end-context-artifact-parity-20261009.json`。
- 新版客户端包内实际执行 **5 会话同时取消**与一次主动注入的持久化失败后恢复，**6 个 child-owned 写入进程全部停止**，根 / command 状态对齐，SQLite `quick_check` 和外键检查通过。业务证据 `.tmp/two-end-packaged-cancel-7hYesV/result.json`，日志 `.tmp/two-end-context-packaged-cancel-smoke-20261009.log`；HTTP / 命令 / SQLite / 记忆关闭后无引用 timer，执行进程自然退出 code 0，记录的 SQLite child PID 已不存在。
- 最终制品核对完成后 source、engine dist、SDK bin、client resources 冻结。新版客户端关联回归由客户端验收任务单独记录，R2 真实负载由根任务单独记录；没有为本次 source 修复重新输出 TGZ，旧可导入 TGZ 的测试只证明旧基线的导入功能。

最终日志：客户端 `.e2e-tmp/two-end-context-runtime-{prepare,verify}-20261009.log`，引擎 `.tmp/two-end-context-{final-build,final-suite,final-typecheck,native-harness,sdk-smoke,artifact-parity,packaged-cancel-smoke}-20261009.log`。

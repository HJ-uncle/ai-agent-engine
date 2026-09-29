# D7 后台命令：实施与验收

用户要求在 D0–D6 后开始下一阶段；本阶段按已接受计划完成 Agent 后台命令的两仓闭环。D8/D9 仍按实际需要安排。

## 契约

- `execute_cmd` 增加 `background?: boolean`，默认仍前台等待；后台在真实启动后返回 `metadata.commandJob`。
- 模型工具 `command_output`、`cancel_command` 使用不可变 jobId；沿用启动命令的权限校验和单次审批。主会话可管理所属任务，子代理只管理自身任务。
- Job schema 1：根 session/run、实际 owner session/run、turn/toolCall 身份、单调 version、独立状态、退出码和错误。时间为 Unix 毫秒；公开/持久状态均无 PID、env。
- 状态：running/cancelling/succeeded/failed/cancelled/timed_out/interrupted。工具派发成功不等于命令完成。
- 输出统一 seq 游标、stdout/stderr 类型；每 job 最多 256 KiB 尾部。earliestCursor 为最早保留 seq−1，旧游标返回 truncated；超前游标拒绝。
- SQLite 保存有限快照和尾部，重启将未结束记录标 interrupted；不重连旧 PID、不重新执行。
- HTTP `/api/v1/command-jobs` 查询、`/:jobId` 状态、`/:jobId/output` 增量输出、`/:jobId/cancel` 停止；没有绕过策略的 HTTP 启动入口。
- 正常根流结束允许后台继续；手动取消、历史删除、进程关闭等待所属命令树清理。前端刷新只读状态，无重启副作用。

## 验收状态

**已通过。** 结果以 `.e2e-tmp/d7-evidence/` 保存的构建与测试日志为准。

| 门槛 | 状态 |
|---|---|
| 引擎 runtime / tool / HTTP 权限与生命周期 | HTTP 14/14；manager 15/15；PID 复用保护 1/1；命令工具 7/7 |
| 两仓 build/typecheck | 均通过；两仓 git diff --check 均通过 |
| 引擎全量回归（不含独立控制台） | 68 文件、695/695 通过 |
| 前端后台任务真实 Electron 与受影响回归 | 57 契约测试 + 33 个不同的真实 Electron 用例，共 90/90 |
| 用户反馈：手动本机连接 token 前置检查 | 已修复；1 项契约、2 项新增真实 Electron 均通过，计入上述总数 |

进程测试仅处理自己启动的隔离夹具；不清理用户状态或输出真实凭据。

## 修正与边界

- 启动登记纳入 admission，停止等待所有已登记任务处理，覆盖持久化完成后才晚到 spawn 的竞态。
- 全量首轮发现终态清理 SQL JSON path 错误，已修复并补测终态保留上限；不将首轮失败算作通过。
- 引擎默认最多 16 个活动命令；终态记录最多 7 天、全局 500 个、每会话 100 个，活动任务不会被清理。每个输出条目和整体尾部均有界。
- Windows 命令树取消等待真实进程退出，失败明确呈现。自行完全脱离父进程/关闭继承管道的 daemon、系统崩溃后的旧进程不承诺重新接管。
- 已退出主进程但仍持有管道的后代可取消；PID 已复用时保守拒绝推导进程树，防止误杀无关进程。
- 删除轮次可保留有限诊断记录，但 F 子代理后台区必须匹配当前仍存在的 root run/turn。真实删除后刷新确认卡片消失、诊断记录仍在且模型调用不增加，避免保留记录让已删轮次重新出现。
- 用户报告的 token 报错位于 F `EngineHost.startRemote`：原实现无条件要求环境变量，而 E 的 standalone 未配置 token 时仍允许原认证方式。现在仅显式 loopback 手动地址可无预设 token，仍验证 health/meta/受保护业务接口；非本机地址保持必须有凭据。工作区映射限制保持原契约，完整本机能力走内置模式。

## 最终配对产物与证据

- E entry：`D:/dev/ai-agent-engine/dist/main.js`。
- E build：`sha256:4ad8fbdaf756c9df078a15cddb0b9a98f344c6d8e1c9b2e3d542299d4c4d946d`；协议 1、code profile、subagent schema 1。
- 最终 E 构建/全量日志：`engine-build-delivery.log`、`engine-full-delivery.log`。
- F 构建/契约日志：`D7-frontend-build.txt`、`D7-frontend-pure.txt`。
- 删除轮次显示修复后的最终 F 构建与定向复验：`D7-frontend-deletion-build.txt`、`D7-child-deletion-pure.txt`（10/10）、`D7-child-deletion-ui.txt`（1/1）；扩展原用例，总数仍为 90 个不同用例。
- 真实 Electron 共 33 个不同用例：既有/连接回归 27 项已通过；D7 6 项在最终 E 产物上全部通过。最终 D7 日志 `D7-command-job-targeted.txt`，产物身份 `D7-electron-final-engine-manifest.json`。
- 首轮 Electron 31 passed / 1 failed / 1 not run：失败来自夹具假设“杀死引擎后子进程仍能写结束标记”。修正该假设后继续验证真实崩溃、interrupted、无重跑；最终 D7 6/6。原日志和 trace 保留，不删除失败证据。
- 最终未执行 D8/D9；未清理真实开发会话、迁移真实密钥或自动提交代码。
- 测试所有进程/监听清理核查通过，最终 `OwnedD7FixtureProcesses=0`；未停止用户正在运行的引擎或前端。

# 当前引擎与 Claude Code 2.1.266 深度对比及全量测试状态

日期：2026-09-30

对象：

- 引擎：`D:\dev\ai-agent-engine` 当前工作树，包含本轮未提交开发改动。
- 实际消费方：`D:\dev\aether-code`。
- 对比包：`C:\Users\wb.xielin02\AppData\Roaming\Wuzu Client Dev\cli-binaries\claude\2.1.266`。

## 结论

本轮已完成本地可观察范围的 Claude 2.1.266 证据采集、引擎能力盘点、引擎全量测试、Fastify 路由扫测和 Aether Code 前端构建及 Playwright 回归。引擎单 worker 全量 Vitest 最终为 **74 个文件、714 个测试全部通过**；路由契约扫测为 **132/132 通过**；Aether Code 完整 Playwright 为 **261/261 通过**，其中独立 smoke 为 **39/39 通过**。构建、类型检查、Git 80 方法矩阵、平台 IPC 11 项矩阵、历史回放和窄布局也全部通过。

“全部能力”在本报告中指对本地源码、安装包、公开入口和可安全离线执行的功能做最大范围核验；未登录 Claude、未读取真实秘钥、未调用付费模型、未连接真实第三方 MCP/远端服务，因此云端账号能力、插件市场、真实供应商质量和生产安装升级仍需单独验收。

## Claude Code 2.1.266 的可核验面

指定包的指纹和静态采集结果：

| 项目 | 结果 |
|---|---|
| 版本 | `2.1.266 (Claude Code)` |
| 文件大小 | 218,971,808 bytes |
| SHA-256 | `d2c5f7b3b6a12819097ceb6efbce2a390157166003fcaee32dbde0e6d7b45ef7` |
| 帮助命令 | 51 组，全部 exit 0 |
| SDK 输入接口 | 45 个 `*Input` 接口 |
| 静态命令定义 | 115 处，94 个唯一命令名 |
| 环境变量线索 | 729 个名称，仅作静态检索索引 |

Claude 领先能力集中在编码代理的执行闭环：

- 后台 Bash、`TaskOutput`/`TaskStop`、会话 attach、resume、respawn 和工作树/分叉。
- 精确 `Edit`、`NotebookEdit`、完整 LSP 语义、REPL、Workflow、目标提议和可恢复后台任务。
- WebSearch、Chrome/IDE/云/远端入口、Artifacts/Projects、Hooks、Monitor/Wakeup、持久 Cron。
- MCP stdio、HTTP/SSE/streamable HTTP、OAuth、resources、refresh、通知和更完整的协议生命周期。
- 权限模式、restricted/sandbox、工具 allow/deny、structured output/schema、budget/fallback、插件市场和插件评测。

这些结论来自帮助、类型声明和二进制静态实现线索；它们不等于当前账号已开通，也不等于云服务在本机已动态验证。完整证据位于 [Claude 能力目录](2026-09-29-claude-capability-catalog.md) 和 [Claude 证据目录](claude-2.1.266-evidence/manifest.json)。

## 当前引擎的优势与差距

引擎当前盘点为 **30 个 HTTP 路由模块、157 个 Fastify operations、124 个唯一路径、46 个静态内置工具、244 个生产 TypeScript 文件**。它的优势是服务端和数据平台：HTTP/SSE/WS、多模型和自托管、多租户、SQLite、会话和恢复、记忆图谱、RAG、Office/PDF/DOCX/XLSX/OCR、CodeGraph、Flow/Cron、Web/mobile 管理能力，以及已经落地的子代理状态、预算、事件和投影。

与 Claude 的主要差距不是工具数量，而是编码工作流的深度和协议完整性：

1. 引擎没有 Claude 同等的后台命令句柄、后台子代理通信、精确文本编辑、Notebook 编辑和完整 LSP 导航。
2. MCP 当前更接近 HTTP tools/list/tools/call 客户端，stdio、OAuth、resources、refresh、通知和完整协商尚未形成同等闭环。
3. 权限、网络、技能脚本、MCP、命令和终端等入口需要统一 policy；不能把某个工具入口的检查当成全局沙箱。
4. 真实流式、fallback、结构化输出 schema、上下文预算和 durable resume 仍有接线差距。
5. 引擎独有的记忆、RAG、Office/OCR、CodeGraph、服务端多租户能力应保留并作为差异化，不应为了复制 Claude 命令名而削弱这些能力。

## 本轮实际修复

- 修复 memory DB 初始化顺序：`F32_BLOB`/vector fallback 不再让索引先于表执行；新增 `src/storage/memory/__tests__/db.test.ts` 回归测试。
- 将 Vitest 排除 `.e2e-tmp/**` 与旧 `multi-agent-console/**`，避免跨项目测试被根引擎误收集。
- 将标准响应中缺失请求头用例改为当前默认值契约并恢复执行。
- 为 Aether Code 补充缺失的 `src/main/git/parsers.ts`，并让 `git-format.ts` 同时兼容当前字段和旧测试字段；未删除或放宽失败断言。

## 引擎验证

### 全量测试

最终串行命令：

```powershell
npx vitest --run --maxWorkers=1 --minWorkers=1 --reporter=dot
```

结果：**74/74 测试文件通过，714/714 测试通过，退出码 0，约 101.5 秒**。原始证据：[2026-09-30-engine-vitest-single-worker-elevated-post-marker-fix.txt](2026-09-30-engine-vitest-single-worker-elevated-post-marker-fix.txt)。`npm run typecheck` 同样通过。JSONL clear/迁移 marker 与 SQLite 队列启动时缺表回归也包含在该结果内。

第一次全量并行启动曾产生 `SQLITE_BUSY`，单独重跑策略引擎后 8/8 通过；最终串行结果排除了该环境竞争。受限权限环境仍会让 D7/D8 的 `taskkill` 失败，因此最终全量使用单 worker 且允许进程树管理的 Windows 会话。

### 路由契约扫测

隔离临时工作区中注入 **132 个实际 Fastify 调用，132/132 通过**，覆盖 health/meta/metrics/openapi、tools/system-tools/external-skills、workspace 全生命周期、agents/models/tenant、knowledge/memory graph、todos/cron、MCP、security/settings/task queue、chat/session/messages/changes/subagent/command-jobs、CodeGraph/LSP、DeepSeek、Flow 和 auth/utility。404 用例也验证了未知资源和跨租户边界。

证据：[2026-09-30-route-sweep.json](2026-09-30-route-sweep.json)。这不是 157 个 operation 的逐一业务语义证明；未被扫测覆盖的真实外部 provider、PTY、MCP 网络连接和某些复杂副作用仍列为后续任务。metrics 在无指标后端时返回 HTTP 200、内部 envelope code 500，扫测按当前契约记录为通过，部署前应明确该状态是否要改成可用性错误。

## Aether Code 验证

- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npx playwright test --list`：**261 tests / 32 files**。
- 完整 Playwright 单 worker、提升 Windows 进程权限：**261/261 通过**，证据：[2026-09-30-aether-code-e2e-full-definitive.txt](2026-09-30-aether-code-e2e-full-definitive.txt)。
- 独立 smoke：**39/39 通过**，证据：[2026-09-30-aether-code-smoke-final-clean.txt](2026-09-30-aether-code-smoke-final-clean.txt)。
- Git 矩阵覆盖 preload 暴露的 **80 个 Git invoke 方法**，平台矩阵 **11/11**；均已包含在 261 项结果中。
- `npm run typecheck` 和提升权限下 `npm run build` 通过。当前引擎重建、staging、runtime verify 证据分别见 [2026-09-30-engine-build-final.txt](2026-09-30-engine-build-final.txt)、[2026-09-30-aether-code-prepare-engine-final.txt](2026-09-30-aether-code-prepare-engine-final.txt) 与 [2026-09-30-aether-code-verify-engine-final.txt](2026-09-30-aether-code-verify-engine-final.txt)。

本轮没有留下 Playwright 失败或跳过项。之前的旧选择器/布局失败已通过更新测试契约、修复共享 fixture 祖先展开和确认弹窗路径消除；这不改变产品实现，只使断言匹配现行 UI。

前端审计仍将以下能力列为“实现已盘点、但未逐项形成完整真机证据”：Git SSH/真实第三方远端和认证失败路径、MCP OAuth/stdio/resources、完整多语言 LSP provider、聊天附件/mentions 的所有组合、打包安装升级和真实第三方模型/远端服务/插件市场。这些不应被 261 项本地离线 E2E 夸大为已在线验证。

## 未验证边界与剩余任务

当前仍有 **4 类高价值未完成项**：

1. 为 Git SSH/认证失败和真实远端服务补充隔离真机矩阵；本地 bare remote 已覆盖常规 fetch/pull/push/clone/sync。
2. 为 MCP stdio/OAuth/resources、真实 provider/test-connection、附件/mentions、LSP provider 全集合增加离线 stub 或受控服务测试。
3. 在干净打包环境验证安装、升级、退出回收、embedded/remote 两种引擎连接，并单独核对 `AETHER_IDE_REMOTE_INSTANCE_TOKEN` 的主进程注入链。
4. 对引擎 157 operations 中尚未被 route sweep 覆盖的复杂副作用补充业务断言；route sweep 仍是契约探针，不替代所有外部 provider 和生产数据验证。

不应把“静态发现”写成“在线能力已开通”，也不应把前端旧选择器失败直接升级为产品故障。下一阶段性价比最高的顺序是先让 E2E 全绿，再做 Git/FS 安全真机矩阵，最后处理 Claude 领先的 MCP OAuth/stdio、后台任务和精确编辑能力。


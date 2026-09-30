# 引擎功能与测试覆盖盘点

日期：2026-09-30。对象：`D:\dev\ai-agent-engine` 当前工作树（包含未提交开发改动）。本记录用于在补测前建立不遗漏的目录；“有源码”不等于“已通过真实端到端测试”。

## 规模和入口

- HTTP 路由：30 个 route 模块，157 个 Fastify 方法，124 个唯一路径。完整方法树见 `docs/research/engine-registered-routes.txt`；该树以 `/api/v1` 前缀表示，健康与认证路由分别是 `/health`、`/meta`、`/metrics`、`/openapi.json` 和 `/auth/user`。
- 内置工具工厂：46 个静态工具，另有动态 MCP 工具。详细边界和工具名见 `docs/research/2026-09-29-tools-security-audit.md`。
- 生产 TypeScript：244 个文件；测试文件：71 个（另有 `docs/standard-response.test.ts` 和前端测试）。
- 启动路径：环境与 `.aether` 配置 → SQLite 主库和 memory DB → 中断子代理恢复/投影 → memory consolidator → DB/受管配置 → skills registry → Fastify server；见 `src/main.ts`。

## 功能目录和当前测试状态

| 区域 | 已实现能力 | 当前测试覆盖 | 补测优先级 |
|---|---|---|---|
| HTTP/聊天 | ReAct 多轮、SSE/快照/重放、取消、状态和 runs | chat-recovery、compress、conversation-destructive；没有完整 `/chat` 正常模型端到端覆盖 | P0 |
| HTTP/工作区 | 文件列举、读/写/上传/下载/流、创建目录、移动、格式化、回收站、重命名、图片 | workspace-file-lock 只验证锁和回滚竞态 | P0 |
| HTTP/模型 | 模型 CRUD、能力覆盖、连通性测试、能力探测、白名单 | model-overrides 覆盖能力持久化/脱敏；正常 CRUD、探测和真实 provider 未覆盖 | P0 |
| HTTP/变更 | changes list/keep/revert/batch/keep-all/keep-many | changes-revert 覆盖批量和隔离 | 已有；需错误边界 |
| HTTP/会话历史 | 列表、历史、删除、truncate、compress、消息/turn 删除、token、regenerate | destructive/compress/chat recovery；messages 路由和 regenerate 未覆盖 | P1 |
| HTTP/子代理 | runs、events、cancel、chat 子代理取消 | subagent-routes + core/tool tests 覆盖状态、租户隔离；真实 UI 未覆盖 | P1 |
| HTTP/技能导入 | skills CRUD、zip 导入、分片上传/合并/进度、导入历史、权限守卫 | skill-imports、skill-imports-auth | 已有；需损坏包/大包 |
| HTTP/命令任务 | command-jobs list/status/output/cancel；聊天和历史清理联动 | tests 很完整，但当前受 Windows taskkill/Get-CimInstance 权限阻塞 | P0 环境修复 |
| HTTP/代码图、流程、后台任务 | codegraph index/status；flows run/stop；tasks CRUD；performance stats/pool | 无直接 route 测试（flow-executor 只测 executor） | P0 |
| HTTP/定时和 DeepSeek | cron CRUD/enable/disable；DeepSeek status/FIM/JSON/prefix/prices/balance/models | 无 route 测试 | P1 |
| HTTP/知识与记忆 | knowledge upload/list/search/delete；memory remember/recall/list/graph/link/consolidate/edit/delete | knowledge scope 只测存储 scope；memory HTTP 无测试 | P0 |
| HTTP/MCP | server CRUD/enable/disable/test | 无 route 测试；客户端边界见工具安全审计 | P0 |
| HTTP/安全租户设置 | policies、audit log、network policy、security mode、settings、tenant identity | policy engine/sandbox/code boundaries/instance token 是单元或 auth 测试；HTTP CRUD 无完整覆盖 | P0 |
| HTTP/终端 | node-pty create/ws/kill；session binding | 无直接测试 | P0（Electron 联测） |
| HTTP/系统元数据 | health/meta/metrics/openapi、tools/system-tools/external-skills、utility/chat | 无直接测试 | P1 |
| Agent loop | ReAct、工具批、ask_user、审批、失败刹车、编辑集成、预算收尾 | react/react-streaming/tool-batch/edit integration 覆盖 | 已有；需真实多轮 provider |
| LLM adapters | OpenAI、Anthropic、DeepSeek、Qwen、Ollama、fallback/retry、能力解析 | llm-adapter、provider-attempts、fallback、history-capabilities、resolved-model | P1：Anthropic/Ollama/DeepSeek真实协议 |
| Stream pipeline | Bus、SSE sink、pipeline、投影 | pipeline/sse-sink/stream-bus | P1：断线重连真实 HTTP |
| Subagent runtime | pool/runner/store/projection/budget、崩溃恢复 | runtime/projection/budget-fork + tool/HTTP | 已有；需真实 engine restart |
| LSP | TypeScript/ESLint diagnostics、取消/超时/缓存/安全路径 | 27 项 D8 测试；本次全量受进程树权限失败 | P0 环境修复后复跑 |
| Security | policy engine、命令白名单、network policy、guarded HTTP、audit log | policy/sandbox/code-boundaries；HTTP 审计路由缺覆盖 | P0 |
| Skills | 双层 registry、外部加载、导入管线、OSM packs、脚本 | registry/external-loader/import-pipeline/osm-pack；`web-search.ts` 未覆盖且未注册 | P1 |
| Storage | SQLite 19 migrations、models/system/tenant config、conversation JSONL/SQLite、memory、knowledge、MCP、cache、cron、session、task queue、todo、changes、root-runs、skill imports | conversation 压缩、knowledge scope、root-runs、dev migration；大量存储未测 | P0 migrations/config；P1 其余 |
| File/Office/OCR | text/json/xlsx/xls/csv/image/PDF/doc/docx handlers、OCR、vision proxy、trash/change recorder | edit-file/file-change-producers；Office/PDF/image/OCR/vision 未测 | P1 |
| Search/network/package | glob/grep、web_fetch、http_request、install/list package | grep tests；glob/web/http/package 未测 | P1 |
| Codegraph | index runner/module/tool、query/callers/callees/impact | 无测试 | P1 |
| Terminal | workspace shell、node-pty manager、resize/input/output | 无测试 | P0 |
| Observability/runtime | logger/metrics/instrumentation/QA logger、build identity、env/config | build-identity；observability 无测试 | P1 |

## HTTP 路由缺口（没有直接 route test）

`agents.ts`, `codegraph.ts`, `cron.ts`, `deepseek.ts`, `knowledge.ts`, `mcp.ts`, `memory.ts`, `messages.ts`, `metrics.ts`, `performance.ts`, `sessions.ts`, `settings.ts`, `tasks.ts`, `tenant.ts`, `terminal.ts`, `todos.ts`, `tools.ts`, `utility.ts`；`workspace.ts` 仅锁竞争有测试。`auth.ts` 有 instance-token 测试；`chat.ts`, `changes.ts`, `command-jobs.ts`, `conversation.ts`, `lsp.ts`, `models.ts`, `skill-imports.ts`, `subagent.ts` 有部分 route 测试。

## 具体源码缺口（没有同名测试命中）

`api/http/chat-snapshot.ts`, `attachment-auto-processor.ts`, `flows/flow-event-bus.ts`; `auth/guards.ts`; `core/agent-loop/tool-batch.ts`, `codegraph-prompt.ts`, `deepseek/pricing.ts`, `llm-adapter/request-attempt.ts`, `llm-adapter/deepseek-errors.ts`, `stream-pipeline/stream-projection.ts`; `observability/instrument-tool.ts`, `qa-logger.ts`; `skills/web-search.ts`; `storage/cache-store/sqlite-cache.ts`, `memory/consolidation.ts`, `tenant-config.ts` 及 migrations 003/004/005/008/013/016/017/018/019；`tools/cmd/execute-command.ts`, 全部 `tools/codegraph/*`, `tools/cron/cron-tool.ts`, Office/image/PDF/Word/OCR/vision handlers、`http-request`, `install-package`, `memory`, `glob`, `task`, `todo`, `web-fetch/security-config`。

## 可复现的验证命令

```powershell
# 单 worker，避免 Electron/进程树并行
npm test -- --run --maxWorkers=1 --minWorkers=1 src
npm run typecheck
npm run build

# 高价值契约组
npm test -- --run --maxWorkers=1 --minWorkers=1 `
  src/api/http/routes/__tests__/chat-recovery.test.ts `
  src/api/http/routes/__tests__/changes-revert.test.ts `
  src/api/http/routes/__tests__/command-jobs.test.ts `
  src/lsp/__tests__/process-lifecycle.test.ts
```

### 本次全量命令的环境证据

在受限 Windows 会话执行 `npm test -- --run --reporter=dot` 时，Vitest 自动发现了 `.e2e-tmp` 的 Playwright 套件（缺 `@playwright/test`）和前端 store 套件（缺 `@testing-library/react`），并且 Windows `taskkill.exe`、`Get-CimInstance Win32_Process` 被拒绝，导致 D7 command-jobs 和 D8 LSP lifecycle 的取消/超时测试失败或超时；一次 dev-migration CLI 子进程还收到 `uv_os_get_passwd ENOMEM`。这次结果为环境阻塞证据，不能替代此前隔离 worker 的 D8 27/27 与 D0–D9 回归结果。应按上面过滤命令重跑，保留失败日志，不删除断言。

## 补测顺序

1. 先建立单 worker、隔离 TEMP、无真实密钥的 route contract harness；先覆盖 codegraph、memory、MCP、security/settings/tenant、terminal、knowledge、models、cron/tasks/todos。
2. 修复/确认 Windows 进程树测试运行权限后，重跑 D7 command-jobs 和 D8 LSP 全组。
3. 对 46 个工具逐个执行成功、拒绝、取消和路径/租户边界；Office/PDF/OCR 生成最小合成 fixture。
4. 做真实 Fastify + packaged Electron 联测，再以 Claude 能力矩阵标记“可用、部分可用、未实现、环境阻塞”。

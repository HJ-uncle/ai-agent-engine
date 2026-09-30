# 当前 Aether Engine / Aether Code 与 Claude Code 2.1.266 差距复核

复核日期：2026-09-30  
对象：`D:\dev\ai-agent-engine` 当前工作树 + `D:\dev\aether-code` 当前消费者；对照包：`C:\Users\wb.xielin02\AppData\Roaming\Wuzu Client Dev\cli-binaries\claude\2.1.266`。

这份报告用于替换旧对比中的过时判断。结论依据当前源码、D0–D9 阶段报告和已经保存的动态测试日志；没有登录 Claude 账号、调用付费模型或启动云端任务。

**同日修订：** 远端令牌现已可在 Aether Code 设置中输入并通过系统密钥存储加密保存；远端 GET 已扩展到会话列表、历史/快照/恢复流、改动、任务与安全策略等只读状态。下文“只允许元数据”和“必须使用环境变量”的描述记录的是修复前状态，最新边界以 [前端限制清单](D:/dev/ai-agent-engine/docs/research/2026-09-30-frontend-restrictions.md) 为准。远端工作区执行仍未实现。本报告没有同任务、同模型的 Claude 动态基准，因此“同级”“更强”“优势”等旧措辞仅表达 Aether 的实现特点，不构成质量、正确率、性能或成本优于 Claude 的证据。

## 证据等级

- **A：当前实现且有动态证据**：真实 HTTP、Electron、文件系统、进程或测试夹具验证过。
- **B：实现存在但边界或测试不完整**：源码和契约可追踪，尚不足以证明所有用户路径。
- **C：当前未见等价实现**。
- **Claude H/T/S**：分别表示本地 `--help`、SDK 类型、二进制/命令静态线索。它们证明能力入口或实现线索，不证明当前账号、服务端或灰度开关一定可用。

Claude 本地包的采集规模是 51 组 help 命令、45 个 `*Input` 接口、94 个唯一静态命令名；这些数字与 Aether 的工具注册数量不是同一个统计单位，不能用 45 对 46 推导覆盖率。

## 先纠正上一版的三项错误

以下能力已经完成，旧报告中的相反结论应视为历史快照：

| 能力 | 当前证据 | 结论 |
|---|---|---|
| 真实流式正文、思考和工具增量 | `src/core/agent-loop/react.ts:622-667`、`src/core/llm-adapter/retry.ts:134-153`；`streaming-model-ui.spec.ts` | A：按 provider delta 交付；交付后断流不切备用，未交付才按可重试错误切换 |
| hash 保护的精确编辑 | `src/tools/file/super-file-tool.ts:13-23,97-108`、`src/tools/file/edit-file.ts:27-104`；`edit-file-ui.spec.ts` | A：`read_file mode=exact` + `expectedHash` + 唯一/不重叠替换 + 一次写入；保留 CRLF/BOM |
| 可持久后台命令 | `src/tools/cmd/execute-command.ts`、`job-tools.ts`、`core/command-jobs/manager.ts`、`api/http/routes/command-jobs.ts`；`command-job-ui.spec.ts` | A：jobId、stdout/stderr 游标、尾部限制、取消、超时、重启 interrupted、owner 隔离 |

同样，D8 已补齐 TypeScript 客户端的 rename、signature help、document symbol、highlight、completion textEdit/additionalTextEdits/snippet/resolve；D9 已有 unpacked/NSIS 构建和隔离 packaged 启动证据。旧报告若称这些“完全不存在”，也不再适用。

## 能力对照

### 1. 模型、上下文和输出契约

| 维度 | Claude 2.1.266 证据 | 当前 Aether | 差距判断 |
|---|---|---|---|
| 多轮 Agent 循环 | H/T/S：Bash、文件、Task、Agent 等 | A：ReAct、工具批、审批、取消、终态与恢复 | 基础同级；两边都需继续做真实 provider 回归 |
| 供应商与自托管 | H：`--model`、`--effort`、`--fallback-model`；Bedrock/Vertex/Foundry 入口 | A/B：OpenAI、Anthropic、DeepSeek、Qwen、Ollama、兼容 HTTP，自托管 | Aether 的供应商开放性更强；Claude 的原生云账号/网关入口更完整 |
| 流式输出 | H/T/S：partial/stream-json、工具事件 | A：逐 delta 正文/思考/工具，usage 和实际模型去重 | 核心差距已收窄；仍需不同 provider 的协议矩阵 |
| 自动压缩和预算 | H：`--autocompact`、`--max-budget-usd` | A/B：上下文预留、micro-compact、摘要、物理请求预算；无统一美元上限 | Claude 的用户级预算/窗口配置更完整；Aether 的内部预算基础更细 |
| 结构化输出 | H：`--json-schema` | B：adapter 的 `response_format=json_object`；未见通用 schema 终态校验/修复 | 明确差距 |
| 工具按需加载 | S：ToolSearch、defer loading、tool reference | C：每轮通常发送完整工具 schema | 大 MCP 集合下 Claude 更省上下文和延迟 |
| 记忆/项目规则 | H/S：CLAUDE.md、auto-memory、rules | A/B：AE.md 分层、图记忆、RAG、技能索引 | Aether 的结构化记忆和数据处理是优势；目录作用域、导入和兼容规则较浅 |

### 2. 编码、文件和终端

| 维度 | Claude | 当前 Aether | 差距判断 |
|---|---|---|---|
| 读、搜索和写文件 | T：FileRead/FileWrite/FileEdit、Glob/Grep | A：分页读取、glob/grep、全量写和 hash 精确编辑 | 基础已对齐；Aether 的版本冲突保护更明确 |
| Notebook | T：`NotebookEditInput` | C：未见 `.ipynb` 单元级工具或 UI | 明确差距 |
| 后台 shell | T：Bash background、TaskOutput、TaskStop；S：Monitor | A：command job 生命周期、输出游标和取消 | 核心后台执行已对齐；Claude 仍多出持久 shell/monitor/跨命令会话语义 |
| LSP | S：有 LSP 线索，未对本机默认 provider 做同口径动态验证 | B：TS/JS/TSX/JSX 客户端已有 hover、definition、references、rename、signature、symbols、highlight、completion；A 级动态证据主要是诊断 | Aether 当前实际 TS LSP 路径更可验证，但 provider 全集和 UI 行为测试仍不完整 |
| 浏览器、搜索和 REPL | T/S：WebSearch、WebFetch、Chrome、REPL 线索 | B/C：`web_fetch`、`http_request`；无原生 `web_search`、Chrome/DOM、持久 REPL | 明确差距 |
| 办公/PDF/OCR/CodeGraph | 本地包未确认同等内置处理器 | A/B：Office/PDF/OCR、视觉代理、CodeGraph、RAG | Aether 的本地数据处理是产品优势，但性能和格式覆盖仍需逐类验收 |

### 3. 权限、安全和治理

| 维度 | Claude | 当前 Aether | 差距判断 |
|---|---|---|---|
| 权限模式 | H：acceptEdits、auto、bypassPermissions、manual、dontAsk、plan；T：Enter/ExitPlanMode | A/B：safe、standard、full-access，工具审批和会话安全状态 | Claude 的模式和 plan 工作流更完整；名称不能直接等价安全强度 |
| allow/deny 与自动策略 | H/S：allowed/disallowed、auto-mode defaults/critique、managed 配置 | A/B：policy engine、命令白名单、网络/路径检查、审计；安全模式会阻断受控扩展 | Aether 有规则基础，但 skill 脚本在非 safe 模式可直接继承宿主 shell/env；统一审批/沙箱仍是 P0 |
| OS 沙箱 | S：macOS/Linux/WSL/Windows 沙箱线索、restricted 模式 | C/B：普通工具运行于宿主进程，已有应用层策略和 DevContainer 配置 | Claude 的平台隔离入口更完整；两边静态线索都未替代渗透测试 |
| 企业配置 | H/S：gateway、managed hooks/MCP/permissions/marketplaces | B：多租户、JWT/API key、受管设置和审计 | Aether 服务治理更适合自托管；Claude 的 CLI 管理生态更完整 |

### 4. MCP、Skills、插件和 Hooks

| 维度 | Claude | 当前 Aether | 差距判断 |
|---|---|---|---|
| MCP 传输 | H：stdio、HTTP/SSE/streamable HTTP、OAuth | B：HTTP JSON-RPC/部分 SSE；loader 明确跳过 stdio | P0 差距 |
| MCP 协议 | T/S：initialize/session、resources、notifications、elicitation、刷新/分页等 | C/B：主要是 tools/list、tools/call 和有限 REST/SSE 降级 | P0 差距，不应称“完整 MCP 兼容” |
| OAuth 与 MCP server | H：`mcp login`、OAuth client/callback、`mcp serve` | C：未见 OAuth 握手/刷新，也未见对外 MCP server | P0/P1 差距 |
| Skills | H/S：skills、reload、plugin-dir | A/B：全局/项目 SKILL.md、按需正文、脚本 | 基础发现/调用已有；作用域、脚本隔离、依赖生命周期较浅 |
| 插件市场与评测 | H/S：plugin install/update/marketplace/eval、版本/依赖 | C：`plugin.json` 主要是技能元数据，zip 导入/备份 | 明确差距 |
| Hooks | H/S：多事件 hooks、include-hook-events、受管来源 | C：内部回调，不是用户可配置生命周期机制 | 明确差距 |

### 5. 会话、子代理和编排

| 维度 | Claude | 当前 Aether | 差距判断 |
|---|---|---|---|
| 子代理 | H/T：Agent、后台默认、模型/隔离配置 | A：role/access/maxSteps、权限快照、SQLite run/event/outbox、预算/取消 | 基础子代理已对齐 |
| 后台会话与通信 | T/S：TaskOutput/TaskStop、SendMessage、命名 agent、attach/resume/respawn | B：子代理通常由父工具等待，暂无邮箱式 send/followup/attach | P0 差距 |
| fork/continue/rewind | H：`--continue`、`--resume`、`--fork-session`、`/fork`、`/rewind` | A/B：历史、刷新/重启回放、重试、撤回；无真正会话 fork/attach/teleport | 明确差距 |
| worktree/PR 会话 | T/H：Enter/ExitWorktree、`--from-pr`、worktree 隔离 | C：Git 服务层强，但 Agent 没有 worktree 生命周期/PR 会话恢复 | 明确差距 |
| Workflow/DAG | T：Workflow agent/parallel/pipeline/phase，可按 run 恢复 | B：Flow DAG 同层并发；停止和状态仍以内存为主，约束传递/持久 resume 不完整 | 部分对齐 |
| 目标、任务板和通知 | T：TaskCreate/List/Update、依赖、owner、ProposeGoal | B：todo/task/cron 有 CRUD；没有完整 agent 依赖、通知和跨轮目标验收状态机 | 明确差距 |

### 6. 前端产品和远端

| 维度 | Claude | Aether Code | 差距判断 |
|---|---|---|---|
| 编辑器 | CLI/IDE 集成入口，Notebook 另计 | A：Monaco、二进制/图片预览、选区加入对话、tab/viewState、精确编辑 diff/撤回 | Aether IDE 体验更完整 |
| Git | Agent worktree/PR/命令能力 | A：80 个 Git IPC 方法，服务层矩阵通过；Git UI 深层动作仍未全部 E2E | Aether 本地 Git 服务强，Agent worktree/PR 对齐不足 |
| 附件/mentions | T/S：文件/图片等输入线索 | B：附件底层和文本 chip 已测；@ 补全、图片/拖放/粘贴/行号 source UI 未全测 | 产品路径部分对齐 |
| Skills/MCP/插件管理 UI | H：CLI 入口广 | C：前端主要把结果显示为通用工具卡，暂无完整 MCP/插件/Hooks 管理页 | 当前用户可见差距最大之一 |
| 远端工作区 | H/S：remote/cloud/IDE/Chrome/worktree 入口，具体可用性依账号/服务 | C（当前策略）：远端只允许 health/meta/metrics/models/tools 等信息读取，未配置共享工作区时拒绝聊天、诊断、文件操作 | 明确差距；这是产品边界，不是引擎健康故障 |

## 当前 Aether 的真实优势

1. 多供应商和自托管：OpenAI/Anthropic/DeepSeek/Qwen/Ollama/兼容 HTTP，以及能力覆盖和请求级模型配置。
2. 本地数据能力：Office/PDF/OCR、图片/视觉、CodeGraph、RAG、图记忆和多租户服务端。
3. 可集成的服务形态：Fastify REST、SSE、WebSocket、Flow/Cron、Web/mobile 控制台。
4. 编码安全契约：精确编辑的完整 hash、CRLF/BOM 保留、编辑冲突保护、后台命令 owner/游标/重启语义。
5. Aether Code 的 IDE 体验：Monaco、文件树、终端、Git 服务、Problems 面板和 packaged runtime 已有真实路径。

这些优势是当前实现和测试能支持的判断；不能直接推导成性能、准确率或成本优于 Claude。

## 剩余差距的性价比排序

### P0：先补，否则不能称为 Agent 产品对齐

1. **MCP 标准兼容**：stdio、initialize/session、resources、notifications、OAuth、分页/刷新，并为 tools/list/call 建跨传输一致性测试。
2. **统一执行安全**：skill/plugin/MCP/HTTP/包管理/后台命令走同一 policy、审批、审计和沙箱边界；至少禁止非 safe 模式下脚本无审计继承全部宿主环境。
3. **后台子代理生命周期**：detach/attach、TaskOutput/TaskStop 统一协议、SendMessage/命名 agent、跨重启 resume；与现有 D3/D7 持久状态复用。
4. **远端工作区合同**：明确共享根、身份、文件/聊天/诊断路由和失败语义；在此之前继续保持远端只读限制。

### P1：直接提升日常编码效率

1. 通用 JSON Schema 输出、校验/修复、可选美元预算。
2. Notebook 单元编辑、持久 REPL、WebSearch/浏览器工具。
3. Agent worktree/PR 会话、fork/attach/rewind、Flow durable resume。
4. Cron/task 的执行身份、幂等、日志、恢复和通知。
5. Aether Code 的 Git UI、mentions/附件 UI、完整 LSP provider、模型 test connection 真实矩阵。

### P2：生态和企业扩展

插件市场/依赖/升级/评测、Hooks 管理、企业 gateway/managed policy、云远端/Artifacts/Projects 等。Claude 对这些有大量入口证据，但本地静态包不能证明账号侧已开通。

## 测试证据的正确解读

- 引擎此前单 worker 全量 **74 files / 714 tests passed**；Aether Code 最终全量 **261 passed / 0 failed / 0 skipped**，另有 smoke 39/39、LSP 定向 4/4。
- 这些数字证明已覆盖路径的回归状态，不能转换为“Claude 能力覆盖率”或“所有用户功能已验证”。仍有 Git UI 深层、mentions/附件组合、SessionHistory/Appearance/Engine/CodeGraph UI、provider 真实连接、完整 LSP provider、MCP、原生 picker/SSH、安装升级等测试缺口。
- D9 已证明历史 packaged 构建能在隔离目录启动并完成合成聊天；最新 buildId 需要重建后再做安装/升级/卸载验证，不能把历史制品当当前发布包。

## 远端连接故障的单独结论

当前截图对应的地址是 `http://10.219.14.186:12323`，属于非回环地址。Aether Code 的 `src/main/engine/protocol.ts:63-70` 在没有 `AETHER_IDE_REMOTE_INSTANCE_TOKEN` 时会在发起握手前拒绝该地址；这不是引擎 `/health` 失败。现场检查结果是：两个地址的 `/health` 都返回 200，当前引擎 `/api/v1/tools` 不带令牌也返回 200，说明该开发引擎没有设置 `AETHER_INSTANCE_TOKEN`。

同机开发最快的无代码修复是把地址改成 `http://127.0.0.1:12323`（或 `localhost`），保存并重新连接；它命中现有 loopback 开发契约。若确实要通过局域网/另一台机器连接，则必须在引擎启动进程设置 `AETHER_INSTANCE_TOKEN`，并在启动 Aether Code 的主进程设置相同的 `AETHER_IDE_REMOTE_INSTANCE_TOKEN`，然后重启 Aether Code。令牌不能填在 URL、普通 renderer 设置或聊天消息中。

当前远端即使握手成功，也只开放引擎/模型/工具信息；因为没有共享工作区映射，聊天、诊断和本地文件操作会被 `remoteRequestError` 拒绝。这是现阶段明确的产品限制，完整本机工作区应选择“本地内置”。

## 最终判断

与上一版相比，Aether 已从“基础编码执行尚不完整”推进到“流式、精确编辑、后台命令和主要 IDE 路径可用”。现在与 Claude 2.1.266 的主要差距集中在 **MCP/插件/Hooks 生态、OS 级隔离和统一治理、后台会话与子代理通信、fork/worktree/远端工作区、Notebook/REPL/浏览器、结构化 schema 输出**。Aether 在多供应商自托管、本地办公数据、CodeGraph/RAG/记忆和桌面 IDE 集成方面保有明显产品优势。

因此当前结论不是“已经全部对齐”，也不是“基础能力落后很多”：**核心 coding loop 已接近可用，Agent 产品化和生态治理仍有一组明确的 P0/P1 缺口。**

# 当前引擎平台与产品能力审计（2026-09-29）

本分报告审计当前磁盘中的 `D:\dev\ai-agent-engine`，覆盖 API/SDK、会话、记忆、知识库、流程调度、控制台、终端、部署与可观测性。业务代码只读；没有启动服务、调用模型或外部服务。本报告不把过往比较报告、设计文档和注释当成已经实现的能力。Claude 2.1.266 的版本事实由主报告中的实物审计补齐；下文不凭记忆声称竞品拥有或缺少某项能力。

判定口径：**接通**表示实现存在且找到调用入口；**局部接通**表示存在实现，但重要路径、配置、隔离或生命周期尚不完整；**占位**表示入口仅演示或明确抛未实现；**未发现**仅表示在当前仓库审计范围内没有找到。静态接通不等于本次已经动态验收。

## 1. 总体判断

引擎已经是一个面向嵌入式桌面产品和自托管服务的平台：包含 HTTP/SSE、持久会话、可配置 Agent、跨会话图记忆、知识库、后台流程、网页/移动控制台、文件编辑器及 PTY。它的优势是开放模型和产品集成能力，不应该只按命令行编码工具的界面来衡量。

当前最大问题是“能力入口多于完整执行契约”：部分字段被接受却没有生效，部分数据表和面板有读端没有写端，部分安全与租户约束只在特定路由实施。先修复这些断点，比继续扩充能力名称更能提高实际完成率。

静态盘点：`src/api/http/routes` 非测试文件中找到 **150 个 `fastify.get/post/put/delete/patch` 注册点**；`src` 下有 **37 个 `.test.ts` 文件**。这些数字分别是代码注册点和测试文件数，不是独立能力数、经过验收的路由数或已通过测试数。

## 2. 能力清单与实现证据

### API / SDK / 嵌入宿主

| 能力 | 判定 | 证据与边界 |
|---|---|---|
| Fastify HTTP API、统一响应、请求 ID | 接通 | `src/api/http/server.ts:41` 建服，`:86` 注册 `/api/v1`；`src/api/http/middleware.ts:14` 上下文提取。 |
| Chat SSE、取消与继续接口 | 接通 | `src/api/http/routes/chat.ts:244` 活跃请求键；`:266` 取消；`:960` Agent 流。具体协议由核心审计补充。 |
| 会话、Agent、模型、MCP、知识、记忆、工具、工作区、终端、任务、Todo、Cron、配置、诊断、性能 API | 接通/局部接通 | 注册表 `src/api/http/server.ts:87` 起；下列各项单独判定。不能用“路由已注册”证明底层能力完整。 |
| 源码版 TypeScript SDK | 接通 | `sdk/client.ts:665` `AgentClient`；`:771` AsyncIterable chat；`:832` 含 usage 聊天；`:895` 后为 Agent/会话/消息/记忆/工具/任务/模型/设置/Todo/Cron/安全/LSP/性能/DeepSeek/终端/工作区/MCP/知识等 typed 分组。 |
| embedded/remote 发布 SDK 生命周期 | 接通 | `sdk-package/src/index.ts:87` start；`:117` stop；`:142` health；`:179` embedded 启动，配有端口探测、就绪探测和子进程管理。 |
| 发布 SDK 与完整客户端能力一致 | 局部接通 | 发布入口仅导出生命周期与错误类型，`http` 为 private；`sdk-package/src/client/httpClient.ts:149` 仅通用 JSON request。未见发布入口导出源码版 `AgentClient`、完整 typed chat/Flow/subagent API。 |
| OpenAPI 在线入口 | 局部接通 | `src/api/http/routes/metrics.ts:34` 从 `docs/docs/openapi.json` 读静态文件，未见由当前路由 schema 自动生成并校验一致性。 |
| HTTP 业务错误契约 | 实现存在，需客户端适配 | `src/api/http/server.ts:76` 错误统一 HTTP 200 + fail body；发布 HTTP client `httpClient.ts:202` 检查 HTTP status 后直接 parse，未解包业务 code。 |
| 健康检查 | 基础接通 | `src/api/http/routes/metrics.ts:8` 固定返回 ok；没有数据库/模型/队列/存储依赖探测。 |

### 会话与恢复

| 能力 | 判定 | 证据与边界 |
|---|---|---|
| SQLite 和 JSONL 双存储 | 接通 | `src/storage/conversation/factory.ts:14`，默认 JSONL、环境变量可回 SQLite。 |
| SQLite 旧会话懒迁移至 JSONL | 接通 | `src/storage/conversation/jsonl-history.ts:298` 读取 SQLite 历史；旧数据保留。 |
| JSONL 追加写、父消息链、更新/墓碑/摘要折叠 | 接通 | `jsonl-history.ts:102` 同会话写串行化；`:184` 摘要折叠；`:341` append；`:398` clear；`:491` update。 |
| 会话列表/完整历史/轮次查询 | 接通 | `src/api/http/routes/conversation.ts:58`、`:66`、`:145`。 |
| 会话 Token 使用统计 | 接通 | `jsonl-history.ts:596`；`conversation.ts:82` response metadata。此 usage 与 `/metrics` 的 quotas 表不是同一链路。 |
| Agent 首轮绑定与元数据 | 接通 | `src/storage/session/index.ts:17` 查询，`:45` INSERT OR IGNORE；`src/api/http/routes/sessions.ts:20` binding。 |
| 硬删除、清空、按消息/轮删除 | 接通 | `conversation.ts:88`、`:105`、`:164`、`:185`，包含活动请求终止和相关子代理清理。 |
| 重新生成、编辑旧消息、历史截断 | 接通 | `src/api/http/routes/messages.ts:292`、`:337`；`conversation.ts:204` truncate。 |
| 手动压缩及后台压缩 | 接通 | `conversation.ts:16` autoCompact；`:224` 手动压缩，统一 history.compress；保留摘要与近期内容。 |
| 会话 Markdown 导出和选轮导出 | 接通 | `multi-agent-console/src/web/utils/sessionExport.ts:65`、`:159`、`:172`，`web/components/ExportDialog.tsx`。 |
| 一般用户会话 fork / 分支树 | 未发现完整 API | 普通会话路由和 SDK 未见 fork；核心 subagent fork 能力不应当作用户可操作的会话分支功能。 |
| 文件改动记录、keep、revert | 局部接通 | `src/tools/file/change-recorder.ts:35`、`:59`；`src/api/http/routes/changes.ts:41` revert；仅工具写/删的文本快照，超过 100KB 或二进制不保存内容。 |
| 全工作区 checkpoint / restore | 占位 | `src/workspace/manager.ts:56`、`:61` 明确 throw “not implemented yet”。不能把逐文件快照撤回称为完整工作区回滚。 |
| 控制台完整 Diff/变更确认/消息回退 UI | 当前控制台未发现 | 当前 `multi-agent-console/src` 未找到 changes/revert/truncate API 调用；变更后端可供外部 Wuzu 宿主集成，但本仓库前端不能据此算已接通。 |

### 长期记忆与知识库

| 能力 | 判定 | 证据与边界 |
|---|---|---|
| 结构化长期记忆节点 | 接通 | `src/storage/memory/types.ts:3` 六类节点：preference/decision/fact/lesson/narrative/milestone，带重要性、强度、来源、标签和 embedding。 |
| 记忆图边、关联、遍历 | 接通 | `src/storage/memory/memory-manager.ts:325` 建边，`:376` 邻居，`:412` 路径遍历，`:459` 多节点关联。 |
| 记忆手工 CRUD、标签、图谱 API | 接通 | `src/api/http/routes/memory.ts:16`、`:35`、`:48`、`:63`、`:111`、`:120`、`:146`。 |
| 聊天后自动抽取记忆 | 接通 | `src/middleware/memory/extractor.ts:97` LLM 抽取与落库；`src/api/http/routes/chat.ts:1111` 调用。 |
| 语义 + 关键词 + 图扩展召回 | 接通，依赖模型 embedding | `extractor.ts:291` 意图改写；`:308` embedding；`:324` 关键词兜底；`:347` 两跳图扩展；`chat.ts:870` 注入。 |
| 向量存储与余弦相似度 | 接通，依赖运行时数据库扩展 | `memory-manager.ts:97` vector32；`:297` recallSimilar；`:302` vector_distance_cos。没有 embedding 的模型会退化关键词检索。 |
| 记忆“反思/合并/遗忘” | 局部接通 | extractor `:227` 近邻查找、`:234` reinforces；定时 consolidator 主要衰减和打印弱记忆数量，没有完成通用冲突解决/语义合并/删除闭环。 |
| 自动记忆整理守护进程 | 局部接通 | `src/main.ts:73` 仅启动 default 租户；`src/storage/memory/consolidation.ts:44` 工作实现，见下方 P1 缺陷。 |
| 知识文档上传/列表/删除/检索 | 接通 | `src/api/http/routes/knowledge.ts:35` 接受纯文本或 JSON 文本；`:74` 列表、`:82` 删除、`:97` 搜索。此入口本身不是任意 Office/PDF 文件摄取管线。 |
| 文本分块与 BM25 检索 | 接通 | `src/storage/knowledge/kb-repo.ts:41` 约 500 词/50 词重叠分块；`:145` searchChunks；ASCII FTS5、中文 LIKE 回退。 |
| 知识库向量语义检索/重排 | 未发现 | 知识库 repo 中没有 embedding/vector/reranker；不要把长期记忆的向量能力或前端“语义搜索”占位文字当知识库语义检索。 |
| Chat 自动 RAG 注入 | 接通 | `src/api/http/routes/chat.ts:859` 并行召回，`:878` 形成知识上下文。 |
| Agent/请求的知识库白名单 | 接口已声明，执行未生效 | `chat.ts:863`、`:865`、`:867` 两分支调用相同 searchChunks，没有传入 document/KB ID 约束。 |

### Flow / Cron / Todo / 后台任务

| 能力 | 判定 | 证据与边界 |
|---|---|---|
| Flow DAG 分层与同层并发 | 接通 | `src/api/http/routes/flows/flow-executor.ts:34` 拓扑分层；`:257` 层内 Promise.all；环检测存在。 |
| 节点独立模型、系统 prompt、模板变量 | 接通 | `flow-executor.ts:108` 系统 prompt，`:122` 节点 model，`:183` 模板替换。 |
| Flow 节点复用 ReAct 与工具执行 | 接通 | `flow-executor.ts:104` registry、`:123` ReAct、`:129` 流式运行。 |
| Flow SSE 事件/取消 | 接通 | `flow-event-bus.ts:28` 事件；`flow-routes.ts:24` run、`:114` stop。 |
| Flow 参数隔离 | 局部接通 | `flow-types.ts:22` 技能/MCP/知识/agent 参数，`:46` cwd/执行/安全模式都声明，但 executor 未读取；`:114` tenant 固定 flow-tenant。 |
| Flow 持久运行历史/断点恢复/重试 | 未发现 | `flow-routes.ts:20` 仅进程内 Map，完成删除；没有持久 run/node 状态机或 resume API。 |
| Flow 并行末输出确定性 | 有风险 | `flow-executor.ts:281` 并发节点各自覆盖 `context['output']`，未指定终点的汇总取值受完成先后影响。 |
| Todo 状态、优先级、截止时间、会话关联 | 接通 | `src/api/http/routes/todos.ts:9`/`:17` schema；`:29` 列表、`:39` 创建、`:56` 更新、`:74` 删除；有桌面/移动 UI。 |
| Cron 持久配置 CRUD | 接通 | `src/storage/cron/index.ts:60` 创建、`:84` enabled 列表、`:109` 运行时间。 |
| Cron 自动触发模型任务 | 局部接通 | `src/scheduler/cron-scheduler.ts:51` start，`:76` checkAndRun，`:90` fireJob；真实内部 HTTP 执行，但身份与业务成功判断缺失。 |
| 通用持久后台任务队列 | 存储接通、执行未接入 | `src/storage/task-queue/sqlite-queue.ts:57` enqueue、`:95` registerHandler、`:123` 找 handler；全 src 只有 registerHandler 定义与类型，没有生产调用。 |
| 队列重启恢复语义 | 基础接通 | `sqlite-queue.ts:39` 将 running 标记失败，不是继续执行；取消仅 pending。 |

### 控制台 / 开发工作流 / 部署

| 能力 | 判定 | 证据与边界 |
|---|---|---|
| 网页工作台与移动端 | 接通 | `multi-agent-console/src/web/App.tsx:178` 桌面布局；`src/mobile/App.tsx` 移动入口；共享 core。 |
| Agent、MCP、知识、记忆、技能、工具、任务面板 | 接通/取决后端 | `multi-agent-console/src/core/domain/panels.ts:22` 活动面板清单；不能反推任务执行器已经接入。 |
| 资源树、快速打开、文件读写/新建/移动/上传 | 接通 | `src/api/http/routes/workspace.ts:37`、`:232`、`:256`、`:291`、`:308`、`:345`。 |
| Monaco 多标签编辑、保存、格式化、未保存提示 | 接通 | `multi-agent-console/src/web/components/editor/MonacoEditor.tsx:32`，`:85` 快捷键，`:107` 保存；格式化错误回退原文。 |
| 图片/视频/二进制预览 | 接通 | `web/components/editor/ImagePreview.tsx`、`VideoPreview.tsx`、`HexEditor.tsx`，由 `EditorArea.tsx` 分发。 |
| PTY + WebSocket + xterm 终端 | 接通 | `src/terminal/index.ts:22` 管理 Map、`:78` node-pty，系统 shell fallback `:87`；`src/api/http/routes/terminal.ts:17` 创建、`:73` WS、`:126` 删除。 |
| 多工作区路径和 scratch | 接通 | `src/workspace/manager.ts:24` 工作目录、`:28` 多根、`:36` scratch 初始化。 |
| 完整 IDE Language Server | 局部替代能力 | `src/lsp/index.ts:16` 仅注册 TypeScript/ESLint；`typescript.ts:35` 使用 TS API/tsc 做诊断，非完整 JSON-RPC LSP 会话。没有定义/引用/重命名等协议功能证据。 |
| 外部 VS Code / JetBrains 扩展 | 当前仓库未发现 | 本仓库是自有 Monaco 工作台；编辑器依赖名不等于已实现外部 IDE 插件。 |
| Git 图形化工作流 / 原生 worktree 管理 | 当前仓库未发现完整实现 | 存在 shell 可执行 Git 的通用能力和 changes 接口注释；未找到 Git status/diff/stage/commit/worktree 专用工作流。前端 package 含 simple-git 依赖不能作实现证据。 |
| SSH 远程挂载 | 占位 | `web/components/settings/RemoteSettings.tsx:9` 测试按钮只显示“正在测试连接”；保存按钮无 handler，状态硬编码离线。remote SDK 模式连接 HTTP 服务是另一项真实能力。 |
| Docker/Compose、自动重启、健康检查 | 接通，部署需复核 | `Dockerfile` 多阶段构建，`docker-compose.yml:20` restart 与 healthcheck；镜像构建前端硬编码服务器 URL。 |
| CI 类型检查和测试 | 存在 | `.github/workflows/ci.yml:15` Node18/20，npm ci、typecheck、vitest；没有在此分审计中重跑。 |
| E2E / 覆盖率门禁 | 基础/不足 | `multi-agent-console/e2e/explorer.spec.ts` 有浏览器测试；`vitest.config.ts:7` 默认排除 e2e；coverage 有报告配置但未见阈值，CI 未调用 coverage 或 E2E。 |
| 日志、QA 转录、审计日志 | 接通 | `src/observability/logger.ts`；`qa-logger.ts:26` 记录完整 prompt/RAG/历史/工具与 usage，`:85` 由环境开启；安全审计另有 API/UI。 |
| Token / 工具调用统计指标 | 读写组件存在，主链未接通 | `src/observability/metrics.ts:17`/`:32` 记录函数；`instrument-tool.ts:4` 包装器无生产调用；`performance.ts:20` 读 tool_metrics，不能声称已有完整可靠统计。 |
| Prometheus/OpenTelemetry | 未发现完整接入 | `/metrics` 返回聚合对象、路由设 text/plain；没有 Prometheus exposition 编码、OTel span/exporter 或分布式 tracing 的证据。 |

## 3. 优先修复的能力缺口

### P0：先形成一致的部署和权限边界

1. **无凭证降级 default 与广泛管理接口组合。** `src/auth/middleware.ts:27` 对未携带凭证者返回默认身份，即便 AUTH_ENABLED=true；`src/api/http/middleware.ts:53` 只对抛错拒绝；`src/main.ts:44` 默认监听 0.0.0.0。`security.ts:22`/`:95` 可改全局策略和网络策略、`settings.ts:100` 可更新设置且无 requireRoles。应明确定义仅本机零配置模式与需要身份的共享部署模式，并统一应用管理权限。这里是代码可达性结论，未做网络攻击复现。
2. **租户边界只覆盖部分资源。** `tasks.ts:32` getStatus 和 `:41` cancel 只按 jobId；`terminal.ts:79`/`:126` 按 UUID 操作且 TerminalSession 没有租户字段；`flow-routes.ts:116` stop 只按 runId。补齐 owner，并要求每次读写/WS 连接/取消都验证身份。随机 ID 不等于授权。
3. **Flow 参数接受但不执行。** 技能、MCP、知识、agent、cwd、securityMode/executionMode 配置应从经验证的请求身份一路传入节点上下文。当前固定 flow-tenant 与全 registry 的节点执行不能标为安全配置继承成功。

### P1：让已有功能完整而且可验证

4. **知识库白名单未生效。** `chat.ts:863-867` 两分支一致，必须在 SQL 查询层传入许可 document/KB ID，并测试“绑定 A 时不能召回 B”。中文无空格文本当前按空格分块也可能形成过大块；后续再加分词、embedding、混合召回和重排。
5. **任务队列无 handler 接入。** 路由创建并 start 了私有队列实例，却未注册任何 handler；`:124` 最老任务无 handler 就返回，还会挡住后面的类型。应该提供真正执行器、失败/取消/重试状态契约、并发 claim 与恢复测试；否则移除“后台执行已支持”的呈现。
6. **Cron 不能保证正确身份和成功判断。** `cron-scheduler.ts:98` 请求仅携带 Content-Type/X-Request-ID，没有 tenant/auth；默认落 default；`:104` 仅检查 res.ok，统一 HTTP 200 的业务错误也当完成。cron parser 的 `x/y` 只做 value % step，忽略起点/区间；没有每任务时区、幂等领取、重入限制、补跑、重试和 durable run 记录。应调用内部认证执行入口并记录终态，而非只消费 SSE 文本长度。
7. **记忆定时衰减存在重复扣减与多租户遗漏。** `main.ts:73` 仅 default；`consolidation.ts:57` 每轮依据 now-last_accessed 再扣历史总时间，只更新 last_strength_update，下一轮会重复计算旧天数。`memory-manager.ts:531` 手工衰减按 last_strength_update，已有两套不一致逻辑。合并计算并遍历租户；语义合并与遗忘另设可验证策略。
8. **运行观测写端没有接到主链。** `recordTokenUsage` 与 `instrumentTool` 全 src 仅定义/导出；将 metric 写入实际模型/工具生命周期后再展示图表，增加可靠失败统计、P50/P95、取消/重试、模型维度、成本与留存限制。
9. **恢复只到逐条操作，未到完整状态。** 文件回退直接 write oldContent，没有确认磁盘当前内容是否仍等于原 newContent（`changes.ts:52`）；可能覆盖用户之后的编辑。全工作区 snapshot/restore 明确占位；需要原子检查点、冲突检测、会话分支/分叉、工作树与消息状态一致回退。
10. **SDK 分裂。** 对齐发布 sdk-package 和源码 sdk/client；API code 解包、标准 SSE event、abort、Flow/subagent、resume、权限交互都应有一个公开 typed 契约和兼容测试。当前包装 HTTP 客户端 apiKey 使用 Bearer，而服务器 `x-api-key` 才是 API key，Bearer 走 JWT（`httpClient.ts:90`、`auth/middleware.ts:14/21`），需明确配置类型。

另一个存储迁移兼容缺口：`src/api/http/routes/workspace.ts:217` 重命名工作区后仅更新旧 SQLite `conversations` 和 `memories`；默认 JSONL 位于 DATA_DIR 邻接 sessions 目录（`jsonl-history.ts:87/95`），不随 workspace 目录重命名，也没有更新 session binding 等关联表。工作区重命名需要经统一会话存储抽象处理并支持原子失败恢复，不能把旧 SQL 改名当成双后端兼容。

### P2：再补产品竞争力

11. **开发工作流完整度。** 将 Git/worktree、独立 IDE 扩展、项目级 LSP 连接与定义/引用/重命名、Diff 确认 UI、后台终端恢复纳入一条端到端工作流。现有 Monaco+诊断+通用 shell 是基础，并非成熟 IDE 编码协作完整体验。
12. **流程可靠性。** 添加 durable Flow run/node 状态、明确 sink 输出、多 sink 聚合、重试和超时、并发预算、流程版本、断点恢复；现在 `context['output']` 的并发覆盖不具备确定性。
13. **发布质量。** CI 覆盖 Windows、SDK、前端 build、E2E、安装/升级/回滚；校验 OpenAPI 与运行时一致性；移除 Docker 前端 URL 硬编码；健康检查区分 liveness/readiness。上述建议不意味着本次已证明每种部署都会失败。

## 4. 应保留并放大的本引擎价值

- **可嵌入与自托管的产品后端。** 已有本地进程/远程 HTTP 两种集成方式、API 和自有控制台，适合 Wuzu 等宿主复用，而非只能从命令行启动。
- **显式可管理的 Agent + 知识 + 记忆产品模型。** 长期记忆不是只有字符串文件：有来源、标签、重要性、强度、关联图、embedding、召回以及图形界面。应先解决语义与隔离一致性，再扩大场景。
- **确定性 DAG 与自主 Agent 可组合。** Flow 已做到同层并行、节点模型与 prompt 配置，适合明确工序；但尚不能拿完整配置隔离和 durable workflow 作为已交付优势。
- **桌面/移动可视化业务入口。** 文件编辑、PTY、Agent/MCP/知识/记忆/待办管理适合更宽的人群；SSH、任务执行器等占位要明确呈现状态。
- **成本和模型选择的可控空间。** 平台结构可服务多模型/私有服务，此项由模型审计提供具体能力与限制证据。

这些是基于当前引擎的实际价值，不意味着 Claude 2.1.266 没有对应能力。竞争比较必须把其真实 CLI 的入口、运行条件、权限和账户限制逐项对齐。

## 5. 最小验收场景建议

不宜只新增与实现一一对应的单元测试，应优先做跨层验收：

1. 开启鉴权后，无凭证请求无法修改全局策略/设置；租户 B 无法读/取消租户 A 的任务、终端和 Flow。
2. 绑定知识 A 的会话绝不检索 B；指定 cwd/技能/MCP/模型/安全模式的 Flow 节点实际收到并遵守全部字段。
3. Cron 以任务归属租户执行，业务失败写失败终态；进程重启/错过时间/前一轮未完成都有明确行为。
4. 入队实际完成一个任务，未知任务类型不阻塞其他任务；取消及重启不重复副作用。
5. 真实聊天与工具调用后指标增长；取消、异常与重试都反映正确终态；跨租户统计不泄露。
6. 用户在 AI 编辑后又改文件，撤回必须检测冲突；会话分叉/回退与文件状态可联合恢复。
7. 用正式发布 SDK 安装包跑完整聊天、流式输出、取消、恢复和权限交互，不直接 import 仓库源码绕过发布链。

以上跨层验收尚未执行。根代理本轮实际验证：`npm run typecheck` 通过；全量 Vitest 用时 7.66 秒，40 个文件中 36 passed / 2 failed / 2 skipped，359 个测试中 342 passed / 1 failed / 16 skipped。一个失败 suite 是前端 explorer 缺少 `@testing-library/react`；一个失败 test 是 sandbox 拒绝路径的错误消息与断言不匹配，实际仍然拒绝。原始证据见 `docs/research/engine-verification.txt`，不要与旧报告中的测试数混用。


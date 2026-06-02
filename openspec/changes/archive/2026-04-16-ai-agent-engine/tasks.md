## 1. 项目初始化与基础设施

- [x] 1.1 初始化 Node.js + TypeScript 项目（package.json、tsconfig.json、eslint、prettier）
- [x] 1.2 安装核心依赖（fastify、better-sqlite3、openai、@anthropic-ai/sdk、pino、jose、zod）
- [x] 1.3 配置 .env 模板（LLM_PROVIDER、OPENAI_API_KEY、ANTHROPIC_API_KEY、WORKSPACE_ROOT、DATA_DIR）
- [x] 1.4 创建 src/ 目录结构（core/、tools/、storage/、workspace/、security/、api/、skills/、observability/）
- [x] 1.5 配置 vitest 单元测试框架，添加测试脚本
- [x] 1.6 创建 Dockerfile 与 .dockerignore（开发用）

## 2. SQLite 数据层

- [x] 2.1 安装 better-sqlite3 + sqlite-vec，验证 sqlite-vec 原生 addon 加载（Windows 兼容性验证）
- [x] 2.2 实现 SQLite 初始化模块（src/storage/sqlite/db.ts），WAL 模式开启
- [x] 2.3 编写数据库迁移脚本（src/storage/sqlite/migrations/），创建以下表：conversations、memories、cache、jobs、quotas、prompt_templates、documents、document_chunks
- [x] 2.4 实现 npm run db:migrate 命令

## 3. AgentContext 与核心类型

- [x] 3.1 定义 AgentContext 接口（src/core/agent-context/types.ts），包含 tenantId、sessionId、workspaceDir、tools、memory、history、logger、tokenBudget
- [x] 3.2 实现 createAgentContext(options) 工厂函数，默认 tenantId="default"
- [x] 3.3 定义 Tool 接口（name、description、parameters: JSONSchema、execute(args, ctx)）
- [x] 3.4 定义 ToolResult、ToolError 类型
- [x] 3.5 定义 Message 类型（role: user/assistant/tool、content、toolCall?）

## 4. ToolRegistry

- [x] 4.1 实现 ToolRegistry 类（src/core/tool-registry/registry.ts）：register、unregister、list、execute
- [x] 4.2 register 时校验工具名唯一性，重复注册抛出 DuplicateToolError
- [x] 4.3 execute 时工具不存在抛出 ToolNotFoundError
- [x] 4.4 list() 返回所有工具的 JSON Schema 描述数组
- [x] 4.5 编写 ToolRegistry 单元测试

## 5. LLM 适配层

- [x] 5.1 定义 LLMAdapter 接口（src/core/llm-adapter/types.ts）：complete()、stream()、countTokens()
- [x] 5.2 实现 OpenAIAdapter（支持 GPT-4o、GPT-4o-mini，function calling）
- [x] 5.3 实现 AnthropicAdapter（支持 claude-3-5-sonnet，tool use）
- [x] 5.4 实现 OllamaAdapter（HTTP API，ReAct 文本解析降级，不支持 tool calling 时降级）
- [x] 5.5 实现 LLMAdapterFactory（根据配置返回对应适配器）
- [x] 5.6 实现自动重试（指数退避，最多 3 次，5xx 和超时触发）
- [x] 5.7 实现降级策略（primaryModel 失败后切换 fallbackModel，配置优先级列表）
- [x] 5.8 每次调用后记录 promptTokens + completionTokens 到 observability 模块
- [x] 5.9 编写 LLM 适配层单元测试（mock HTTP 调用）

## 6. StreamPipeline

- [x] 6.1 定义 StreamMiddleware 接口（src/core/stream-pipeline/types.ts）：transform(chunk, next)
- [x] 6.2 实现 StreamPipeline 类：createPipeline(middlewares[])，pipe(source) => AsyncIterable
- [x] 6.3 实现 SSE Sink：将 pipeline 输出写入 Fastify reply（text/event-stream）
- [x] 6.4 P0 阶段默认无中间件（直通模式）
- [x] 6.5 编写 StreamPipeline 单元测试

## 7. Agent Loop（ReAct）

- [x] 7.1 定义 LoopStrategy 接口（src/core/agent-loop/strategy.ts）：run(input, ctx) => AsyncIterable<string>
- [x] 7.2 实现 ReActStrategy（src/core/agent-loop/react.ts）：Think→Act→Observe 循环
- [x] 7.3 ReAct 循环中解析 LLM 输出（tool_call JSON 或 final_answer）
- [x] 7.4 实现最大迭代次数限制（maxIterations，默认 10），超出时返回错误标记
- [x] 7.5 实现 tokenBudget 检查，耗尽时停止循环并返回截断标记
- [x] 7.6 每轮 Observation 追加到 ConversationHistory
- [x] 7.7 编写 ReAct Loop 单元测试（mock LLM 和工具）

## 8. 记忆系统

- [x] 8.1 实现 MemoryStore 类（src/storage/memory-store/store.ts），基于 SQLite memories 表
- [x] 8.2 实现 remember(key, value, ctx)，按 tenantId+sessionId 存储
- [x] 8.3 实现 recall(key, ctx)，不存在时返回 null
- [x] 8.4 实现 list(ctx)，返回当前 session 所有 key
- [x] 8.5 实现 forget(key, ctx)
- [x] 8.6 实现 MemoryTool（src/tools/memory/）：包装 remember/recall 为 Tool 接口，供 Agent 调用
- [x] 8.7 编写 MemoryStore + MemoryTool 单元测试

## 9. 对话历史

- [x] 9.1 实现 ConversationHistory 类（src/storage/conversation/history.ts），基于 SQLite conversations 表
- [x] 9.2 实现 append(message, ctx)，按 tenantId+sessionId 存储
- [x] 9.3 实现 getHistory(ctx)，返回消息列表
- [x] 9.4 实现 clear(ctx)
- [x] 9.5 实现滑动窗口截断（超过 maxTokens 时保留最新消息）
- [x] 9.6 实现 summarize(ctx)：调用 LLM 将早期历史压缩为摘要，替换早期消息
- [x] 9.7 编写 ConversationHistory 单元测试

## 10. 工作空间

- [x] 10.1 实现 WorkspaceManager（src/workspace/manager.ts）：init(ctx)、getPath(ctx)
- [x] 10.2 工作空间路径格式：${WORKSPACE_ROOT}/<tenantId>/<sessionId>/
- [x] 10.3 实现路径安全校验（resolveSafePath(baseDir, userPath)，拒绝路径穿越）
- [x] 10.4 预留 snapshot(ctx) 接口（P1 实现）
- [x] 10.5 预留 restore(snapshotPath, ctx) 接口（P1 实现）

## 11. 安全沙箱

- [x] 11.1 实现 CMD 白名单配置（src/security/cmd-whitelist.ts），默认允许：ls、echo、cat、pwd、find、grep
- [x] 11.2 实现 CMDTool（src/tools/cmd/）：验证命令在白名单中，使用 child_process.spawn（shell:false），加执行超时
- [x] 11.3 实现文件路径隔离校验（所有文件操作前调用 resolveSafePath）
- [x] 11.4 实现配额检查中间件（检查 quotas 表中用户剩余配额）
- [x] 11.5 编写安全沙箱单元测试（路径穿越、命令注入场景）

## 12. 文件工具（CRUD）

- [x] 12.1 实现 FileTool（src/tools/file/），包含以下子工具：read_file、write_file、list_files、delete_file、create_dir
- [x] 12.2 所有操作前调用 resolveSafePath 校验路径在 workspaceDir 内
- [x] 12.3 read_file 返回文件内容（文本），超过大小限制时返回错误
- [x] 12.4 write_file 支持创建和覆写
- [x] 12.5 list_files 返回目录下文件列表（递归可选）
- [x] 12.6 编写 FileTool 单元测试

## 13. 任务队列（SQLite 实现）

- [x] 13.1 定义 TaskQueue 接口（src/storage/task-queue/types.ts）：enqueue、getStatus、cancel
- [x] 13.2 实现 SQLiteTaskQueue（src/storage/task-queue/sqlite-queue.ts），基于 jobs 表
- [x] 13.3 实现简单轮询 worker（定时从 jobs 表获取 pending 任务并执行）
- [x] 13.4 任务状态：pending → running → done/failed/cancelled
- [x] 13.5 服务重启后：running 状态任务自动标记为 failed（防止幽灵任务）
- [x] 13.6 编写 SQLiteTaskQueue 单元测试

## 14. 缓存（SQLite 实现）

- [x] 14.1 定义 CacheStore 接口（src/storage/cache-store/types.ts）：get、set(ttlSeconds)
- [x] 14.2 实现 SQLiteCacheStore（src/storage/cache-store/sqlite-cache.ts），基于 cache 表
- [x] 14.3 get 时检查 expires_at，过期返回 null
- [x] 14.4 实现懒清理（每次 get 时顺带删除同 key 的过期条目）
- [x] 14.5 缓存键生成：hash(provider + model + prompt)
- [x] 14.6 编写 SQLiteCacheStore 单元测试

## 15. 可观测性

- [x] 15.1 初始化 Pino logger（src/observability/logger.ts），输出结构化 JSON
- [x] 15.2 实现请求 requestId 中间件（Fastify hook，UUID v4）
- [x] 15.3 每条日志自动附加 tenantId、sessionId、requestId
- [x] 15.4 实现 Token 统计记录（写入 SQLite quotas 表：daily_tokens_used）
- [x] 15.5 实现工具调用耗时记录（工具 execute 包装层，记录 durationMs）
- [x] 15.6 暴露 GET /metrics 接口（返回简单 JSON 指标：总请求数、token 消耗、工具调用耗时 p50/p95）

## 16. 提示词模板库

- [x] 16.1 实现 PromptTemplateStore（src/prompt-template/store.ts），基于 SQLite prompt_templates 表
- [x] 16.2 实现 render(name, variables, ctx)：替换模板中 {{variable}} 占位符
- [x] 16.3 实现内置模板种子数据（assistant、coder、analyst 角色），在 db:migrate 时写入
- [x] 16.4 实现 CRUD API（create/update/delete，按 tenantId 隔离）
- [x] 16.5 编写 PromptTemplateStore 单元测试

## 17. 认证与多租户（P0 最小实现）

- [x] 17.1 实现认证中间件接口（src/auth/middleware.ts），可配置跳过（P0 默认跳过）
- [x] 17.2 实现 API Key 认证（X-API-Key 请求头验证，对比 SQLite users 表）
- [x] 17.3 实现 JWT 认证（Bearer token，jose 库验证签名和有效期）
- [x] 17.4 认证成功后将 tenantId 注入到 AgentContext

## 18. 内置 Skills

- [x] 18.1 实现 MathSkill（src/skills/math.ts）：计算数学表达式（使用安全的 eval 替代）
- [x] 18.2 实现 TimeSkill（src/skills/time.ts）：返回当前时间、时区转换
- [x] 18.3 将 Skills 注册到默认 ToolRegistry

## 19. HTTP API（Fastify）

- [x] 19.1 初始化 Fastify 应用（src/api/http/server.ts），注册 pino logger、schema 校验
- [x] 19.2 实现 POST /api/v1/chat：接收消息，返回 SSE 流（Agent Loop + StreamPipeline）
- [x] 19.3 实现 POST /api/v1/memory/remember、GET /api/v1/memory/recall/:key
- [x] 19.4 实现 GET /api/v1/conversation/history、DELETE /api/v1/conversation/history
- [x] 19.5 实现 POST /api/v1/tasks、GET /api/v1/tasks/:jobId（任务队列 API）
- [x] 19.6 实现 GET /api/v1/tools（列出已注册工具）
- [x] 19.7 实现 GET /health（健康检查）
- [x] 19.8 全局错误处理（统一错误响应格式）
- [x] 19.9 编写 API 集成测试（vitest + supertest）

## 20. MCP 客户端（P1 预留）

- [x] 20.1 定义 MCPClient 接口（src/tools/mcp/types.ts）
- [x] 20.2 实现基础 MCPClient（连接 MCP 服务器，获取工具列表）
- [x] 20.3 实现 MCPTool 适配器（将 MCP 工具包装为统一 Tool 接口）
- [x] 20.4 MCP 连接错误时返回错误，不影响其他工具

## 21. 测试与质量保证

- [x] 21.1 确保单元测试覆盖率 > 60%（vitest --coverage）
- [x] 21.2 编写安全边界测试（路径穿越、命令注入、token 超限）
- [x] 21.3 编写 Agent Loop 集成测试（mock LLM，验证工具调用准确性）
- [x] 21.4 编写 P0 里程碑验收测试：Agent 能回答"列出当前工作空间的文件"并正确执行

## 22. 文档与部署

- [x] 22.1 编写 README.md（快速启动、环境配置、API 示例）
- [x] 22.2 编写 API 文档（Fastify swagger 插件，/docs 端点）
- [x] 22.3 完善 Dockerfile（多阶段构建，生产镜像）
- [x] 22.4 添加 docker-compose.yml（单容器，挂载 workspace 和 db 目录）

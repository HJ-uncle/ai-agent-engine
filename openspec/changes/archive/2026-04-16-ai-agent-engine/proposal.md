## Why

目前缺少一个通用的 AI Agent 运行时引擎。我们需要构建一个基于 Node.js + TypeScript 的 Agent 引擎，支持多模型调用、工具系统、记忆与知识库、规划模式、多租户隔离及可观测性，覆盖从 MVP 到生产级部署的完整能力。

## What Changes

- 全新构建 AI Agent Engine 服务（HTTP API + WebSocket）
- 实现统一工具接口（Tool / ToolRegistry），所有外部能力通过此接口接入
- 接入多 LLM 提供商（OpenAI、Anthropic、Ollama），统一适配层
- 实现 ReAct Agent Loop 及 Plan Mode（多步规划）
- 引入 SQLite + sqlite-vec 作为统一持久化层（替代 Redis），包括任务队列、缓存、向量检索、记忆、对话历史
- TaskQueue / CacheStore 抽象接口，后续可无缝替换为 Redis 实现
- 安全沙箱：命令白名单、工作空间路径隔离
- 多租户：JWT 认证，所有存储以 tenantId + sessionId 为命名空间
- 流输出 StreamPipeline，支持中间件链（P3 扩展点）
- 可观测性：结构化日志（Pino）、Token 统计、工具调用耗时

## Capabilities

### New Capabilities

- `agent-loop`: Agent 核心执行循环（ReAct / Plan Mode），含反思机制
- `tool-registry`: 统一工具注册与调用接口，支持 Skill、函数调用、MCP、CMD、文件操作
- `llm-adapter`: 多模型适配层，统一 stream/non-stream 调用，含重试与降级
- `memory-store`: 持久化记忆系统，key-value + 结构化存储，基于 SQLite
- `knowledge-base`: 知识库文档管理、分块嵌入与向量语义检索（sqlite-vec）
- `conversation-history`: 多轮对话历史，滑动窗口截断与摘要压缩
- `workspace`: 工作空间隔离，每个会话独立目录，支持快照与恢复
- `task-queue`: 异步任务队列抽象（SQLite 实现），含任务状态查询与中断
- `cache-store`: 响应缓存抽象（SQLite 实现），TTL 支持
- `security-sandbox`: 命令执行沙箱，路径隔离，配额管理
- `auth-multitenancy`: JWT/API Key 认证，多租户数据隔离
- `stream-pipeline`: 流输出管道，支持中间件挂载（过滤/改写/记录）
- `observability`: 结构化日志、请求追踪、Token 消耗与工具调用指标
- `prompt-template`: 提示词模板库，支持自定义与版本管理
- `mcp-client`: MCP 标准协议客户端，连接外部工具服务器

### Modified Capabilities

（无，全新项目）

## Impact

- **新增服务**：`agent-engine`（Fastify HTTP API + WebSocket）
- **数据层**：SQLite（单文件，WAL 模式）+ sqlite-vec 扩展
- **无 Redis 依赖**：任务队列与缓存均由 SQLite 实现，通过接口抽象支持后续替换
- **外部依赖**：OpenAI SDK、Anthropic SDK、Ollama HTTP API、Pino、Fastify、better-sqlite3、sqlite-vec、jose（JWT）
- **安全边界**：所有文件操作限定在 `workspace/<tenantId>/<sessionId>/`，CMD 命令白名单校验

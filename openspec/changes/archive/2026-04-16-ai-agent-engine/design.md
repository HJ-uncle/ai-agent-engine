## Context

全新构建的 Node.js + TypeScript AI Agent 引擎。当前项目目录为空，无遗留代码。

核心约束来自探索阶段讨论：
- 去除 Redis 依赖，以 SQLite（WAL 模式）+ sqlite-vec 作为统一持久化层
- 所有外部能力（工具、Skill、MCP、CMD、文件）通过统一 Tool 接口接入
- 从 P0 起就植入 `tenantId` + `sessionId` 命名空间，避免 P2 多租户阶段大规模重构
- 流输出从 P0 起采用 StreamPipeline 结构，为 P3 中间件扩展预留接口

## Goals / Non-Goals

**Goals:**
- 实现可运行的 Agent 引擎 HTTP API 服务（Fastify）
- 覆盖 P0 全部 11 项功能，提供 P1/P2/P3 的清晰扩展点
- 所有持久化通过 SQLite 单文件完成（无 Redis、无独立向量数据库）
- TaskQueue / CacheStore 通过接口抽象，支持后续替换为 Redis
- 安全沙箱：文件路径隔离 + CMD 白名单
- 单元测试覆盖率 > 60%

**Non-Goals:**
- P0 阶段不实现多模态输入输出、外部知识源插件、WebSocket 中断
- P0 阶段不实现真实多租户认证（预留接口即可）
- 不提供前端 UI（仅 HTTP API）

## Decisions

### 决策 1：统一 Tool 接口（最核心）

**选择**：所有工具（Skill、MCP、CMD、文件、函数）实现同一 `Tool` 接口：

```
interface Tool {
  name: string
  description: string
  parameters: JSONSchema
  execute(args: unknown, ctx: AgentContext): Promise<ToolResult>
}
```

**理由**：Agent Loop 无需区分工具类型，统一遍历 ToolRegistry。后续新增任何工具只需实现接口，无需修改 Loop 逻辑。

**放弃**：为每种工具类型分别定义 API（如 `addSkill` / `addMCPServer` / `addFunction`），会导致 Agent Loop 需要特判每种类型。

---

### 决策 2：AgentContext 设计

**选择**：每次 Agent 调用创建一个 `AgentContext` 对象，贯穿整个 Loop：

```
interface AgentContext {
  tenantId: string       // 多租户命名空间（P0 默认 "default"）
  sessionId: string      // 会话 ID
  workspaceDir: string   // workspace/<tenantId>/<sessionId>/
  tools: ToolRegistry
  memory: MemoryStore
  history: ConversationHistory
  logger: Logger
  tokenBudget: number    // 剩余 token 预算
}
```

**理由**：所有能力通过 ctx 注入，便于测试（mock ctx）、便于 P2 多租户扩展（只需替换 tenantId）。

---

### 决策 3：Agent Loop 策略模式

**选择**：Loop 核心为 `LoopStrategy` 接口，P0 实现 `ReActStrategy`，P1 实现 `PlanModeStrategy`：

```
ReAct 执行流：
  用户输入
    → LLM Think（输出 thought + tool_call）
    → ToolRegistry.execute(tool_call)
    → 将 observation 追加到历史
    → 循环，直到 LLM 输出 final_answer
    → StreamPipeline 输出
```

**放弃**：直接在 Loop 中用 if/else 区分 ReAct 和 Plan Mode，会使代码耦合且难以测试。

---

### 决策 4：SQLite 全家桶（无 Redis）

**选择**：

| 职责 | 实现 |
|------|------|
| 对话历史 / 记忆 / Prompt 模板 | SQLite 普通表 |
| 向量检索（知识库） | sqlite-vec 扩展 |
| 任务队列 | SQLite `jobs` 表 + 轮询（better-queue 适配） |
| 响应缓存 | SQLite `cache` 表 + `expires_at` 列 |
| 配额计数 | SQLite `quotas` 表 + 事务原子更新 |

**接口抽象**（未来可换 Redis）：

```
interface TaskQueue { enqueue / getStatus / cancel }
interface CacheStore { get / set(ttlSeconds) }
```

**理由**：AI Agent QPS 远低于传统 Web，SQLite WAL 模式并发写入足够；单文件便于工作空间快照（cp db 文件即可）；减少部署依赖。

**风险**：多实例水平扩展时需替换为 Redis 实现 → 通过接口抽象已预留。

---

### 决策 5：StreamPipeline 结构

**选择**：P0 即引入空中间件链，P3 可插入过滤/改写/记录器：

```
[LLM Stream] → [Middleware[]] → [SSE Sink / WebSocket Sink]

P0：Middleware[] = []（直通）
P3：Middleware[] = [SensitiveWordFilter, ContentLogger]
```

**理由**：P0 改造成本接近零，但避免了 P3 重写整个流输出层。

---

### 决策 6：目录结构

```
src/
  core/
    agent-loop/       # LoopStrategy 接口 + ReActStrategy
    tool-registry/    # Tool 接口 + ToolRegistry
    llm-adapter/      # LLM 提供商适配（OpenAI/Anthropic/Ollama）
    stream-pipeline/  # StreamPipeline + Middleware 接口
    agent-context/    # AgentContext 类型定义
  tools/
    cmd/              # CMDTool（沙箱）
    file/             # FileTool（CRUD）
    memory/           # MemoryTool（remember/recall）
    search/           # SearchTool（P1）
    mcp/              # MCPTool（P1）
  storage/
    sqlite/           # SQLite 初始化、迁移
    memory-store/     # MemoryStore（SQLite 实现）
    conversation/     # ConversationHistory（SQLite 实现）
    task-queue/       # TaskQueue 接口 + SQLiteTaskQueue
    cache-store/      # CacheStore 接口 + SQLiteCacheStore
    knowledge-base/   # KnowledgeBase + sqlite-vec（P1）
  workspace/          # 工作空间管理、路径隔离、快照
  security/           # 路径校验、CMD 白名单、配额
  auth/               # JWT/API Key（P2，P0 预留接口）
  observability/      # Pino logger、Token 统计、耗时记录
  prompt-template/    # 提示词模板库
  api/
    http/             # Fastify 路由
    ws/               # WebSocket（P3）
  skills/             # 内置 Skill 示例（math、time）
```

## Risks / Trade-offs

- **SQLite 并发写入** → WAL 模式 + 事务批量写入缓解；极端并发场景（> 50 并发写）才需考虑 Redis
- **sqlite-vec 成熟度** → 生产环境验证有限；备选方案：lancedb（Node.js 支持好）；接口已抽象可替换
- **ReAct Token 消耗** → 多轮思考累积 token；通过 `tokenBudget` 强制截断 + 对话历史压缩
- **CMD 安全** → 白名单严格校验，子进程加超时限制；禁止 shell 注入（不使用 shell:true）
- **工作空间快照** → P1 实现，P0 预留 `workspace.snapshot()` 接口即可

## Migration Plan

全新项目，无迁移需求。

部署顺序：
1. `npm install` 安装依赖
2. `npm run db:migrate` 初始化 SQLite schema
3. 配置 `.env`（LLM API Key、workspace 根目录）
4. `npm run dev` 启动开发服务器

## Open Questions

- sqlite-vec 在 Windows 环境下的 native addon 兼容性（需验证）
- 是否需要支持 Ollama 的 tool calling（部分本地模型不支持 function calling，需要 ReAct 文本解析降级）
- P2 多实例部署时，TaskQueue 接口何时切换到 BullMQ + Redis 实现

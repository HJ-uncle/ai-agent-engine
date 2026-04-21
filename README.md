# AI Agent Engine

A production-ready AI Agent Engine built with Node.js + TypeScript ESM. Supports multi-tenant, multi-session conversational agents with a ReAct reasoning loop, tool execution, persistent memory, and a Fastify HTTP API.

---

## Features

| # | Feature |
|---|---------|
| 1 | ReAct (Reason + Act) agent loop |
| 2 | Multi-provider LLM support (OpenAI, Anthropic, Ollama) |
| 3 | Automatic LLM retry with exponential backoff |
| 4 | SSE streaming responses |
| 5 | Tool registry with unified `Tool` interface |
| 6 | Built-in file tools (read, write, list, delete) |
| 7 | Shell command tool with whitelist security |
| 8 | Memory tools (remember / recall / forget / list) |
| 9 | HTTP MCP client — import tools from any MCP server |
| 10 | Persistent SQLite memory store (multi-tenant) |
| 11 | Persistent SQLite conversation history |
| 12 | Persistent SQLite task queue with background polling |
| 13 | SQLite result cache store |
| 14 | Prompt template store with variable interpolation |
| 15 | Workspace isolation per tenant/session |
| 16 | JWT + API-key authentication middleware |
| 17 | Observability: structured pino logging + metrics |
| 18 | Tool execution instrumentation (duration, success rate) |
| 19 | Fastify HTTP API (chat, memory, conversation, tasks, tools) |
| 20 | Built-in skills (math, time) |
| 21 | SQLite migration runner |
| 22 | Docker Compose deployment |

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your API keys

# 3. Run database migrations
npm run db:migrate

# 4. Start development server
npm run dev
```

The server starts on `http://localhost:3000` by default.

---

## Linux 快捷访问指令

### Chat 接口 (SSE 流式响应)
```bash
# 标准流式输出 (-N 禁用缓冲)
curl -N -X POST http://localhost:3000/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "你好，请自我介绍一下",
    "sessionId": "test-session"
  }'

# 过滤数据流，只看内容文本 (适合控制台预览)
# 注意：管道连接时需要通过参数禁用各级程序的缓冲区，否则会“一下子弹出”
# macOS 用户 (BSD sed):
curl -N -s -X POST http://localhost:3000/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "讲个笑话", "sessionId": "test-session"}' \
  | grep --line-buffered "data: " \
  | sed -l 's/data: //g' \
  | grep --line-buffered "^{" \
  | jq -j --unbuffered '.content // empty'

# Linux 用户 (GNU sed):
# curl -N -s ... | grep --line-buffered "data: " | sed -u 's/data: //g' | jq -j --unbuffered '.content // empty'

# Windows 用户 (PowerShell):
# 注意：PowerShell 管道处理流式数据较慢，建议使用以下方式或在 Git Bash 中运行
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/v1/chat -Headers @{"Content-Type"="application/json"} -Body '{"message":"你好"}'
```

### Memory 接口 (存储/查询)
```bash
# 存储记忆
curl -X POST http://localhost:3000/api/v1/memory/remember \
  -H "Content-Type: application/json" \
  -d '{
    "key": "user_name",
    "value": "Alice",
    "sessionId": "test-session"
  }'

# 查询记忆
curl "http://localhost:3000/api/v1/memory/recall/user_name?sessionId=test-session"
```

### 系统状态
```bash
# 健康检查
curl http://localhost:3000/health

# 指标统计
curl http://localhost:3000/metrics
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `HOST` | `0.0.0.0` | HTTP server bind address |
| `NODE_ENV` | `development` | Environment (`development` / `production`) |
| `LOG_LEVEL` | `info` | Pino log level (`debug`, `info`, `warn`, `error`) |
| `LLM_PROVIDER` | `openai` | LLM backend (`openai`, `anthropic`, `ollama`) |
| `LLM_PRIMARY_MODEL` | `gpt-4o-mini` | Primary model name |
| `LLM_FALLBACK_MODEL` | _(none)_ | Fallback model name |
| `OPENAI_API_KEY` | _(required for OpenAI)_ | OpenAI API key |
| `ANTHROPIC_API_KEY` | _(required for Anthropic)_ | Anthropic API key |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama base URL |
| `DB_PATH` | `./agent.db` | SQLite database file path |
| `WORKSPACE_ROOT` | `./workspace` | Root directory for per-tenant workspaces |
| `AUTH_ENABLED` | `true` | Enable JWT/API-key authentication (`false` for dev) |
| `JWT_SECRET` | `dev-secret-change-in-production` | JWT signing secret |
| `TOKEN_BUDGET` | `8000` | Max tokens per agent context |
| `MAX_ITERATIONS` | `10` | Max ReAct loop iterations |

---

## API Endpoints

### Chat

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/chat` | Send a message; streams SSE response |

**Request body:**
```json
{
  "message": "What is 2 + 2?",
  "sessionId": "optional-uuid",
  "systemPrompt": "You are a helpful assistant.",
  "maxIterations": 10 
}
```

**Response:** `text/event-stream`
```
data: {"content":"The answer is 4."}

data: [DONE]
```

### Memory

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/memory/remember` | Store a key-value pair |
| `GET` | `/api/v1/memory/recall/:key?sessionId=` | Retrieve a value by key |
| `GET` | `/api/v1/memory/list?sessionId=` | List all stored keys |

### Conversation History

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/conversation/history?sessionId=` | Fetch message history |
| `DELETE` | `/api/v1/conversation/history?sessionId=` | Clear message history |

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/tasks` | Enqueue a background job |
| `GET` | `/api/v1/tasks/:jobId` | Check job status |
| `DELETE` | `/api/v1/tasks/:jobId` | Cancel a pending job |

### Tools

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/tools` | List all registered tools |

### System

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (`{"status":"ok"}`) |
| `GET` | `/metrics` | Token usage and tool call metrics |

---

## Architecture

```
src/
├── main.ts                    # Entry point
├── api/http/                  # Fastify HTTP server + routes
│   ├── server.ts
│   ├── index.ts
│   └── routes/
│       ├── chat.ts            # POST /api/v1/chat (SSE)
│       ├── memory.ts          # Memory CRUD
│       ├── conversation.ts    # History CRUD
│       ├── tasks.ts           # Task queue
│       ├── tools.ts           # Tool listing
│       └── metrics.ts         # Health + metrics
├── core/
│   ├── agent-context/         # AgentContext, Tool interfaces
│   ├── agent-loop/            # ReActStrategy
│   ├── llm-adapter/           # OpenAI / Anthropic / Ollama
│   ├── stream-pipeline/       # Async pipeline + SSE sink
│   └── tool-registry/         # ToolRegistry
├── storage/
│   ├── sqlite/                # DB connection + migrations
│   ├── memory-store/          # SQLiteMemoryStore
│   ├── conversation/          # SQLiteConversationHistory
│   ├── task-queue/            # SQLiteTaskQueue
│   └── cache-store/           # SQLiteCacheStore
├── tools/
│   ├── file/                  # File read/write/list/delete
│   ├── cmd/                   # Shell command execution
│   ├── memory/                # remember/recall/forget tools
│   └── mcp/                   # HTTP MCP client
├── skills/                    # Built-in skills (math, time)
├── auth/                      # JWT + API key middleware
├── observability/             # Logger + metrics
├── prompt-template/           # Template store
├── workspace/                 # Workspace manager
└── security/                  # Command whitelist
```

**Key design decisions:**
- **SQLite for everything** — no Redis, no external services required
- **Unified `Tool` interface** — file tools, shell tools, memory tools, MCP tools all share the same interface
- **Multi-tenant isolation** — tenantId + sessionId scope all storage reads/writes
- **Auth optional** — set `AUTH_ENABLED=false` during development

---

## Development

```bash
# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Type-check + build
npm run build

# Lint
npm run lint
```

### Adding a Custom Tool

```typescript
import type { Tool } from './src/core/agent-context/index.js'

const myTool: Tool = {
  name: 'my_tool',
  description: 'Does something useful',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Input value' },
    },
    required: ['input'],
  },
  async execute(args, ctx) {
    const { input } = args as { input: string }
    return { success: true, output: `Processed: ${input}` }
  },
}
```

### Using the MCP Client

```typescript
import { HTTPMCPClient } from './src/tools/mcp/index.js'
import { ToolRegistry } from './src/core/tool-registry/index.js'

const client = new HTTPMCPClient({
  name: 'my-mcp-server',
  url: 'http://localhost:8080',
  headers: { 'X-API-Key': 'secret' },
})

const registry = new ToolRegistry()
const mcpTools = await client.toTools()
mcpTools.forEach((t) => registry.register(t))
```

---

## Docker

```bash
# Build and run with Docker Compose
docker-compose up --build

# Run in background
docker-compose up -d
```

See `docker-compose.yml` for full configuration options.

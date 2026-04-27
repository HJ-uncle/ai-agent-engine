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
| 6 | Built-in file tools (read, write, list, delete, create_dir) |
| 7 | **Image reading tool** (`read_image`) — Vision-capable base64 injection |
| 8 | Shell command tool with whitelist security |
| 9 | Memory tools (remember / recall / forget / list) |
| 10 | HTTP MCP client — import tools from any MCP server |
| 11 | Persistent SQLite memory store (multi-tenant) |
| 12 | Persistent SQLite conversation history |
| 13 | Persistent SQLite task queue with background polling |
| 14 | SQLite result cache store |
| 15 | Prompt template store with variable interpolation |
| 16 | Workspace isolation per tenant/session |
| 17 | JWT + API-key authentication middleware |
| 18 | Observability: structured pino logging + metrics |
| 19 | Tool execution instrumentation (duration, success rate) |
| 20 | Fastify HTTP API (chat, memory, conversation, tasks, tools) |
| 21 | Built-in skills (math, time) |
| 22 | SQLite migration runner |
| 23 | Docker Compose deployment |
| 24 | **Thinking Mode** — DeepSeek R1 / Claude 3.7 Sonnet / Qwen3 reasoning support |
| 25 | **Model Management** — Multi-model configuration with encrypted API key storage |
| 26 | **Ask User** — Interactive tool that pauses agent loop for user input |
| 27 | **AbortSignal** — Client disconnect cancels LLM requests gracefully |
| 28 | **i18n** — Multi-language UI (Chinese / English) |
| 29 | **Settings API** — Runtime environment variable management |
| 30 | **Multi-modal Input** — Image & file attachments via workspace reference (no base64 in history) |
| 31 | **Context Compression** — Extractive + keyword compression with accuracy validation |
| 32 | **Unified Tool Registry Factory** — Single source of truth for all tool registration |
| 33 | **QA Logger** — Structured Q&A audit log for every conversation turn |
| 34 | **Workspace File Upload** — Upload images/files up to 100 MB directly to session workspace |
| 35 | **Context Memory Switch** — Per-session toggle for conversation history injection |

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

The server starts on `http://localhost:12323` by default.

---

## Linux 快捷访问指令

### Chat 接口 (SSE 流式响应)
```bash
# 标准流式输出 (-N 禁用缓冲)
curl -N -X POST http://localhost:12323/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "你好，请自我介绍一下",
    "sessionId": "test-session"
  }'

# 带附件（上传文件后按文件名引用，AI 自动调用 read_file/read_image 读取）
curl -N -X POST http://localhost:12323/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "分析这张图",
    "sessionId": "test-session",
    "attachments": [{ "name": "screenshot.png", "content": "", "type": "image/png" }]
  }'

# 过滤数据流，只看内容文本 (适合控制台预览)
# macOS 用户 (BSD sed):
curl -N -s -X POST http://localhost:12323/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "讲个笑话", "sessionId": "test-session"}' \
  | grep --line-buffered "data: " \
  | sed -l 's/data: //g' \
  | grep --line-buffered "^{" \
  | jq -j --unbuffered '.content // empty'

# Linux 用户 (GNU sed):
# curl -N -s ... | grep --line-buffered "data: " | sed -u 's/data: //g' | jq -j --unbuffered '.content // empty'

# Windows 用户 (PowerShell):
Invoke-RestMethod -Method Post -Uri http://localhost:12323/api/v1/chat -Headers @{"Content-Type"="application/json"} -Body '{"message":"你好"}'
```

### Memory 接口 (存储/查询)
```bash
# 存储记忆
curl -X POST http://localhost:12323/api/v1/memory/remember \
  -H "Content-Type: application/json" \
  -d '{
    "key": "user_name",
    "value": "Alice",
    "sessionId": "test-session"
  }'

# 查询记忆
curl "http://localhost:12323/api/v1/memory/recall/user_name?sessionId=test-session"
```

### 系统状态
```bash
# 健康检查
curl http://localhost:12323/health

# 指标统计
curl http://localhost:12323/metrics
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `12323` | HTTP server port |
| `HOST` | `0.0.0.0` | HTTP server bind address |
| `NODE_ENV` | `development` | Environment (`development` / `production`) |
| `LOG_LEVEL` | `info` | Pino log level (`debug`, `info`, `warn`, `error`) |
| `LLM_PROVIDER` | `openai` | LLM backend (`openai`, `anthropic`, `ollama`) |
| `LLM_PRIMARY_MODEL` | `gpt-4o-mini` | Primary model name |
| `LLM_FALLBACK_MODEL` | _(none)_ | Fallback model name |
| `OPENAI_API_KEY` | _(required for OpenAI)_ | OpenAI API key |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base URL |
| `ANTHROPIC_API_KEY` | _(required for Anthropic)_ | Anthropic API key |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama base URL |
| `DB_PATH` | `./agent.db` | SQLite database file path |
| `WORKSPACE_ROOT` | `./workspace` | Root directory for per-tenant workspaces |
| `AUTH_ENABLED` | `true` | Enable JWT/API-key authentication (`false` for dev) |
| `JWT_SECRET` | `dev-secret-change-in-production` | JWT signing secret |
| `TOKEN_BUDGET` | `8000` | Max tokens per agent context window |
| `MAX_ITERATIONS` | `50` | Max ReAct loop iterations |
| `ENCRYPTION_KEY` | _(auto-generated)_ | AES-256-GCM key for API key encryption (32 hex chars) |

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
  "agentId": "optional-agent-id",
  "systemPrompt": "You are a helpful assistant.",
  "maxAskUserCount": 5,
  "thinkingMode": false,
  "inheritContext": true,
  "workspacePaths": [],
  "attachments": [
    { "name": "image.png", "content": "", "type": "image/png", "encoding": "base64" }
  ],
  "toolResponse": {
    "toolCallId": "call_xxx",
    "name": "ask_user",
    "output": "user input"
  }
}
```

**Response:** `text/event-stream`
```
data: {"content":"The answer is 4."}
data: {"thinking":"Let me think about this..."}
data: {"toolStart":{"name":"calculator","args":{"expr":"2+2"},"toolCallId":"call_1"}}
data: {"toolEnd":{"name":"calculator","toolCallId":"call_1","success":true,"outputPreview":"4"}}
data: {"ask_user":{"question":"...","options":["A","B"],"toolCallId":"call_2"}}
data: {"usage":{"systemPromptTokens":50,"completionTokens":10,"totalTokens":60}}

### Workspace

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/workspace/files?sessionId=` | Get workspace files tree |
| `GET` | `/api/v1/workspace/recent` | Get recently used workspaces |
| `GET` | `/api/v1/workspace/file/content?sessionId=&path=` | Read file content |
| `GET` | `/api/v1/workspace/image?sessionId=&path=` | Get image as data URL (for UI preview) |
| `POST` | `/api/v1/workspace/file` | Upload a file to session workspace (multipart, max 100 MB) |
| `DELETE` | `/api/v1/workspace/recent/:sessionId` | Physically delete workspace directory |
| `POST` | `/api/v1/workspace/rename` | Rename workspace and its associated sessionId |

### Memory

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/memory/remember` | Store a key-value pair |
| `GET` | `/api/v1/memory/recall/:key?sessionId=` | Retrieve a value by key |
| `GET` | `/api/v1/memory/list?sessionId=` | List all stored keys |
| `DELETE` | `/api/v1/memory/:id` | Delete a memory entry |

### Conversation History

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/conversation/sessions` | List all sessions with conversations |
| `GET` | `/api/v1/conversation/history?sessionId=` | Fetch message history |
| `DELETE` | `/api/v1/conversation/history?sessionId=` | Clear message history |
| `GET` | `/api/v1/conversations/:conversationId` | Get single conversation messages |
| `DELETE` | `/api/v1/sessions/:sessionId` | Delete entire session (optional `?keepWorkspace=true`) |

### Messages

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/messages/:messageId/tokens` | Get token usage for a message |
| `GET` | `/api/v1/sessions/:sessionId/tokens` | Get total token usage for a session |
| `DELETE` | `/api/v1/messages/:messageId` | Delete a single message |
| `PUT` | `/api/v1/messages/:messageId` | Edit message and trigger regeneration (Stream) |
| `POST` | `/api/v1/messages/:messageId/regenerate` | Regenerate AI response (Stream) |

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/tasks` | Enqueue a background job |
| `GET` | `/api/v1/tasks` | List all tasks |
| `GET` | `/api/v1/tasks/:jobId` | Check job status |
| `PUT` | `/api/v1/tasks/:jobId` | Update task |
| `DELETE` | `/api/v1/tasks/:jobId` | Cancel a pending job |

### Tools

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/tools` | List all registered tools |

### Agents

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/agents` | Create a new agent |
| `GET` | `/api/v1/agents` | List agents |
| `GET` | `/api/v1/agents/:id` | Get agent detail |
| `PUT` | `/api/v1/agents/:id` | Update agent |
| `DELETE` | `/api/v1/agents/:id` | Delete agent |

### Models

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/models/whitelist` | Get model whitelist with thinking config |
| `GET` | `/api/v1/models` | Get configured models (API keys masked) |
| `POST` | `/api/v1/models` | Add a new model configuration |
| `PUT` | `/api/v1/models/:id` | Update model configuration |
| `DELETE` | `/api/v1/models/:id` | Delete model configuration |
| `POST` | `/api/v1/models/:id/test` | Test model connection |

### Settings

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/settings` | Get system environment settings |
| `PUT` | `/api/v1/settings` | Update system settings (writes to `.env`) |

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
│       ├── workspace.ts       # Workspace management + file upload
│       ├── messages.ts        # Message edit/regenerate/tokens
│       ├── agents.ts          # Agent CRUD
│       ├── models.ts          # Model management
│       ├── settings.ts        # System settings
│       └── metrics.ts         # Health + metrics
├── core/
│   ├── agent-context/         # AgentContext, Tool interfaces
│   ├── agent-loop/            # ReActStrategy
│   ├── compression/           # Context compression (extractive + keyword)
│   ├── llm-adapter/           # OpenAI / Anthropic / Ollama (multi-modal)
│   ├── stream-pipeline/       # Async pipeline + SSE sink
│   ├── tool-registry/         # ToolRegistry
│   └── utils/                 # Token estimation utilities
├── storage/
│   ├── sqlite/                # DB connection + migrations
│   ├── memory-store/          # SQLiteMemoryStore
│   ├── conversation/          # SQLiteConversationHistory (sliding window)
│   ├── task-queue/            # SQLiteTaskQueue
│   ├── cache-store/           # SQLiteCacheStore
│   ├── agent/                 # SQLiteAgentStore
│   └── knowledge/             # Knowledge base + RAG
├── tools/
│   ├── file/                  # read_file / write_file / list_files / delete_file / create_dir / read_image
│   ├── cmd/                   # Shell command execution
│   ├── memory/                # remember / recall / forget tools
│   ├── ask-user/              # Interactive ask_user tool
│   ├── skill/                 # External skill runner
│   ├── mcp/                   # HTTP MCP client
│   └── registry-factory.ts   # ★ Unified tool registry factory (single source of truth)
├── skills/                    # Built-in skills (math, time) + external skill loader
├── auth/                      # JWT + API key middleware
├── observability/             # Logger + metrics + QA logger
├── prompt-template/           # Template store
├── workspace/                 # Workspace manager (multi-path support)
├── security/                  # Command whitelist
└── utils/                     # Encryption utilities
```

**Key design decisions:**
- **SQLite for everything** — no Redis, no external services required
- **Unified `Tool` interface** — file tools, shell tools, memory tools, MCP tools all share the same interface
- **`registry-factory.ts`** — single place to add/remove tools; all routes (chat / messages / tools) call `createToolRegistry()` for a consistent, complete toolset
- **Multi-tenant isolation** — tenantId + sessionId scope all storage reads/writes
- **Auth optional** — set `AUTH_ENABLED=false` during development
- **Thinking Mode** — reasoning content extracted from model-specific fields (`reasoning_content` for Qwen/DeepSeek, `thinking` blocks for Claude; auto-detected by model name)
- **Encrypted API keys** — model API keys encrypted with AES-256-GCM before storage
- **Multi-modal via workspace reference** — images/files uploaded to workspace; AI receives text instruction to call `read_image` / `read_file`; base64 is never stored in chat history, preventing token budget explosion
- **Sliding window history** — conversation history capped at `TOKEN_BUDGET` tokens; oldest messages dropped first; tool results kept intact (no mid-content truncation)
- **Context compression** — optional extractive/keyword summarization for long histories

---

## Multi-modal Usage

When uploading images or files, the workflow is:

1. **Upload** the file via `POST /api/v1/workspace/file` (multipart form)
2. **Send chat** with `attachments` referencing the uploaded filename (no base64 in body)
3. **AI calls `read_image` / `read_file`** tool automatically
4. **LLM adapter** intercepts the `read_image` result and injects a vision-capable `user` message with the actual image data — enabling true OCR and image analysis

```json
// Chat request with attachment
{
  "message": "请分析这张截图",
  "sessionId": "my-session",
  "attachments": [
    { "name": "screenshot.png", "content": "", "type": "image/png" }
  ]
}
```

The user message UI shows a **file card** (name + size + date), not raw binary content.

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

Then register it in `src/tools/registry-factory.ts`:

```typescript
// registry-factory.ts — 唯一需要修改的地方
registry.register(myTool)
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
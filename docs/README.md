# AI Agent Engine

A production-ready AI Agent Engine built with Node.js + TypeScript ESM. Supports multi-tenant, multi-session conversational agents with a ReAct reasoning loop, tool execution, persistent memory, and a Fastify HTTP API.

---

## Features

| # | Feature |
|---|---------|
| 1 | ReAct (Reason + Act) agent loop |
| 2 | Multi-provider LLM support (OpenAI, Anthropic, Ollama, DeepSeek, Qwen, Kimi, Moonshot) |
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
| 17 | **OIDC Authentication** — Email OTP + PKCE 授权码流程，支持 JWKS 验证 |
| 18 | JWT + API-key authentication middleware |
| 19 | Observability: structured pino logging + metrics |
| 20 | Tool execution instrumentation (duration, success rate) |
| 21 | Fastify HTTP API (chat, memory, conversation, tasks, tools) |
| 22 | Built-in skills (math, time) |
| 23 | SQLite migration runner |
| 24 | Docker Compose deployment |
| 25 | **Thinking Mode** — DeepSeek R1 / Claude 3.7 Sonnet / Qwen3 reasoning support |
| 26 | **Model Management** — Multi-model configuration with encrypted API key storage |
| 27 | **Ask User** — Interactive tool that pauses agent loop for user input |
| 28 | **AbortSignal** — Client disconnect cancels LLM requests gracefully |
| 29 | **i18n** — Multi-language UI (Chinese / English) |
| 30 | **Settings API** — Runtime environment variable management |
| 31 | **Multi-modal Input** — Image & file attachments via workspace reference (no base64 in history) |
| 32 | **Context Compression** — Extractive + keyword compression with accuracy validation |
| 33 | **Unified Tool Registry Factory** — Single source of truth for all tool registration |
| 34 | **QA Logger** — Structured Q&A audit log for every conversation turn |
| 35 | **Workspace File Upload** — Upload images/files up to 100 MB directly to session workspace |
| 36 | **Context Memory Switch** — Per-session toggle for conversation history injection |
| 37 | **Todo Management** — Task CRUD with REST API + AI tools (`todo_list/create/update/delete`) + UI panel |
| 38 | **Cron Jobs** — Scheduled AI actions via standard 5-field cron expressions; loopback triggers full ReAct loop |
| 39 | **Glob Search** — File pattern matching tool (`glob_search`) with wildcard support (`**`, `*`, `?`) |
| 40 | **Grep Search** — Full-text / regex search tool (`grep_search`); uses ripgrep when available, falls back to Node.js |
| 41 | **Task Control** — Agent tools to list, cancel and inspect background queue jobs (`task_list/cancel/status`) |
| 42 | **Web Fetch** — `web_fetch` tool with security domain filtering via `config/security.json` |
| 43 | **HTTP Request** — `http_request` tool for external API calls |
| 44 | **Agent Tools** — `agent` / `subagent` tools for sub-agent creation and management |
| 45 | **Get Context** — `get_context` tool for runtime context inspection |
| 46 | **Install Package** — `install_package` tool for npm package installation |
| 47 | **Fine-grained Tool Control** — Per-agent `allowedTools` configuration via `agent_allowed_tools` table |
| 48 | **Session Agent Lock** — Once a session starts, the Agent is locked and cannot be switched mid-session; cleared on history delete |
| 49 | **Granular Token Breakdown** — 8-category Token usage: system prompt, RAG, skill prompt, builtin tools, MCP tools, history messages, tool results, completion |
| 50 | **Tool Output Truncation** — Oversized tool outputs auto-truncated (head + tail) to prevent token budget explosion |
| 51 | **OpenAI Base URL Auto-fix** — Automatically strips `/chat/completions` or other endpoint suffixes from `OPENAI_BASE_URL` |
| 52 | **Third-Party Proxy Detection** — Auto-detects OpenRouter/Groq/Together/etc. and disables incompatible `stream_options.include_usage` |
| 53 | **Streaming Tool Args** — Tool call parameters stream incrementally (`tool_arg` events); compatible with Qwen/vLLM XML `<tool_call>` fallback parsing |
| 54 | **DeepSeek V4 Flash/Pro** — Support for latest DeepSeek V4 models with dynamic discount-aware pricing |
| 55 | **Kimi & Moonshot** — Support for kimi-k2.6/k2.5/k2-0905 and moonshot via DeepSeek-compatible layer |
| 56 | **OSM 方法论 i18n** — Four-tier mode switch (off/balanced/methodology/max) with Chinese labels in enhanced mode dropdown |
| 57 | **Resizable Chat Input** — Drag-to-resize chat input area for longer text composition |
| 58 | **Dynamic Pricing Module** — DeepSeek model pricing persisted in `~/.agent-engine/deepseek-prices.json` with smart merge on upgrade and API-driven updates |
| 59 | **SDK Package** — `agent-engine` npm package with Embedded/Remote dual modes covering 22 API namespaces |

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

## OIDC 认证系统

本项目包含一个完整的 OIDC (OpenID Connect) 认证系统，支持邮箱验证码登录。

### 架构概览

```
├── email-otp-oidc-auth-portal/    # OIDC 认证服务提供商
│   └── 提供邮箱 OTP 登录 + PKCE 授权码流程
├── multi-agent-console/            # 前端控制台（已集成 OIDC 登录）
└── 主引擎/                          # 后端 API（支持 JWKS 验证）
```

### 快速启动完整系统

```bash
# 1. 安装所有依赖
npm install
cd email-otp-oidc-auth-portal && npm install && cd ../multi-agent-console && npm install && cd ..

# 2. 配置环境变量
cp .env.example .env
cd email-otp-oidc-auth-portal && cp .env.example .env && cd ..
# 编辑各 .env 文件配置相关参数

# 3. 启动 OIDC 认证服务（终端 1）
cd email-otp-oidc-auth-portal && npm run dev

# 4. 注册 OIDC 客户端（终端 2）
cd .. && bash scripts/register-oidc-client.sh

# 5. 启动后端引擎（终端 2）
npm run dev

# 6. 启动前端控制台（终端 3）
cd multi-agent-console && npm start
```

访问 `http://localhost:3001` 即可使用 OIDC 登录。

### OIDC 认证流程

1. **用户访问前端** → 跳转到 OIDC 授权页面
2. **输入邮箱** → 发送验证码
3. **输入验证码** → 验证成功，重定向回前端
4. **前端获取授权码** → 交换 Access Token + ID Token
5. **后端验证 Token** → 通过 JWKS 验证 JWT 签名

详细文档请参考 `email-otp-oidc-auth-portal/README.md`。

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
| `DATA_DIR` | `./agent.db` | SQLite database file path |
| `WORKSPACE_ROOT` | `./workspace` | Root directory for per-tenant workspaces |
| `AUTH_ENABLED` | `true` | Enable JWT/API-key authentication (`false` for dev) |
| `JWT_SECRET` | `dev-secret-change-in-production` | JWT signing secret (向后兼容，启用 OIDC 时不需要) |
| `OIDC_ISSUER_URL` | _(none)_ | OIDC 认证服务的 Issuer URL（例如 `http://localhost:3000`），启用后通过 JWKS 验证 Token |
| `TOKEN_BUDGET` | `100000` | Max tokens per agent context window |
| `MAX_ITERATIONS` | `100` | Max ReAct loop iterations |
| `HISTORY_MAX_TOKENS` | `20000` | Max tokens kept in conversation history window (older messages dropped first) |
| `TOOL_OUTPUT_MAX_CHARS` | `4000` | Max characters of tool output before head+tail truncation |
| `COMPRESS_THRESHOLD_RATIO` | `0.5` | Compression trigger ratio of `TOKEN_BUDGET`; lower = compress earlier |
| `ENCRYPTION_KEY` | _(required)_ | 64 hex characters (32 bytes) AES-256-GCM key for encrypting API keys |

---

## API Endpoints

### Chat

> On the **first** `POST /api/v1/chat` of a session, the supplied `agentId` is automatically locked to that session. Subsequent requests for the same session will always use the bound agent regardless of the `agentId` field in the body. The lock is cleared automatically when conversation history is deleted.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/chat` | Send a message; streams SSE response |
| `GET` | `/api/v1/sessions/:sessionId/binding` | Get session Agent binding (`started`, `agentId`, `agent`); `started: false` = not yet locked |

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
data: {"usage":{"systemPromptTokens":50,"ragTokens":0,"skillTokens":0,"builtinToolsTokens":120,"mcpToolsTokens":0,"messagesTokens":300,"toolResultsTokens":80,"completionTokens":10,"promptTokens":550,"totalTokens":560,"systemToolsTokens":120}}

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
| `GET` | `/api/v1/tools` | List all registered tools (builtin + skill) |
| `GET` | `/api/v1/tools/system-tools` | List all system builtin tools (excluding skills) |
| `GET` | `/api/v1/tools/external-skills` | List all custom skills from SKILLs directory |

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

### Todos

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/todos` | Create a todo item |
| `GET` | `/api/v1/todos?sessionId=&status=` | List todos (filterable by session / status) |
| `PUT` | `/api/v1/todos/:id` | Update title, description, priority, status or due date |
| `DELETE` | `/api/v1/todos/:id` | Delete a todo item |

**Todo status values:** `pending` · `in_progress` · `done` · `cancelled`  
**Priority values:** `low` · `medium` · `high`

**Create body:**
```json
{
  "title": "Review PR #42",
  "description": "optional details",
  "priority": "high",
  "dueAt": "2026-05-01T18:00:00",
  "sessionId": "my-session"
}
```

### Cron Jobs

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/cron` | Create a cron job |
| `GET` | `/api/v1/cron` | List all cron jobs |
| `PUT` | `/api/v1/cron/:id` | Update cron job |
| `DELETE` | `/api/v1/cron/:id` | Delete cron job |
| `POST` | `/api/v1/cron/:id/enable` | Enable a cron job |
| `POST` | `/api/v1/cron/:id/disable` | Disable a cron job |

**Create body:**
```json
{
  "name": "Daily standup reminder",
  "cronExpr": "0 9 * * 1-5",
  "message": "请总结今日工作进展并列出明日计划",
  "sessionId": "my-session",
  "agentId": "optional-agent-id",
  "description": "Weekday 9 AM standup",
  "enabled": true
}
```

The scheduler fires a loopback `POST /api/v1/chat` request at the matched minute, triggering the full ReAct agent loop.

### Settings

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/settings` | Get system environment settings (includes `webFetch` security config) |
| `PUT` | `/api/v1/settings` | Update system settings (writes to `.env`; supports `webFetch` config) |

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
│       ├── todos.ts           # Todo CRUD
│       ├── cron.ts            # Cron Job CRUD + enable/disable
│       ├── sessions.ts        # Session Agent binding (lock/query/reset)
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
├── scheduler/
│   └── cron-scheduler.ts      # ★ Minute-level cron ticker; loopback triggers full ReAct loop
├── storage/
│   ├── sqlite/                # DB connection + migrations (006: todos + cron_jobs)
│   ├── memory-store/          # SQLiteMemoryStore
│   ├── conversation/          # SQLiteConversationHistory (sliding window)
│   ├── task-queue/            # SQLiteTaskQueue
│   ├── cache-store/           # SQLiteCacheStore
│   ├── agent/                 # SQLiteAgentStore
│   ├── todo/                  # TodoStore (CRUD, status/priority filters)
│   ├── cron/                  # CronStore (CRUD, enable/disable, lastRunAt)
│   ├── session/               # SessionStore (Agent binding lock per session)
│   └── knowledge/             # Knowledge base + RAG
├── tools/
│   ├── file/                  # read_file / write_file / list_files / delete_file / create_dir / read_image
│   ├── cmd/                   # Shell command execution
│   ├── memory/                # remember / recall / forget tools
│   ├── ask-user/              # Interactive ask_user tool
│   ├── skill/                 # External skill runner
│   ├── mcp/                   # HTTP MCP client
│   ├── search/                # glob_search (glob) + grep_search (ripgrep / Node.js fallback)
│   ├── todo/                  # todo_list / todo_create / todo_update / todo_delete
│   ├── cron/                  # cron_list / cron_create / cron_update / cron_delete
│   ├── task/                  # task_list / task_cancel / task_status
│   ├── web-fetch/             # web_fetch tool with domain security filtering
│   ├── http-request/          # http_request tool for external API calls
│   ├── agent/                 # agent / subagent tools for sub-agent management
│   ├── get-context/           # get_context tool for runtime context inspection
│   ├── install-package/       # install_package tool for npm package installation
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
- **`registry-factory.ts`** — single place to add/remove tools; all routes (chat / messages / tools) call `createToolRegistry()` for a consistent, complete toolset; supports `allowedTools` parameter for per-agent tool restrictions
- **Fine-grained tool control** — each agent can have an `agent_allowed_tools` entry in SQLite restricting which tools it can use; `createToolRegistry({ allowedTools: [...] })` filters at registration time
- **Multi-tenant isolation** — tenantId + sessionId scope all storage reads/writes
- **Auth optional** — set `AUTH_ENABLED=false` during development
- **Thinking Mode** — reasoning content extracted from model-specific fields (`reasoning_content` for Qwen/DeepSeek, `thinking` blocks for Claude; auto-detected by model name)
- **Encrypted API keys** — model API keys encrypted with AES-256-GCM before storage
- **Vision auto-detection** — LLM adapter automatically detects non-vision models (DeepSeek, Ollama, Qwen, Moonshot, Zhipu) and gracefully falls back to text-only mode or OCR
- **Multi-modal via workspace reference** — images/files uploaded to workspace; AI receives text instruction to call `read_image` / `read_file`; base64 is never stored in chat history, preventing token budget explosion
- **Sliding window history** — conversation history capped at `TOKEN_BUDGET` tokens; oldest messages dropped first; tool results kept intact (no mid-content truncation)
- **Context compression** — optional extractive/keyword summarization for long histories
- **Cron loopback** — `CronScheduler` runs a minute-level ticker aligned to clock boundaries; on match it calls `POST /api/v1/chat` (loopback HTTP) so cron jobs go through the full ReAct loop including tool use; no external cron daemon required
- **Todo + Cron as first-class tools** — agents can create, read, update and delete todos/cron jobs via `todo_*` / `cron_*` tools, enabling self-scheduling autonomous workflows
- **grep_search ripgrep fallback** — `grep_search` detects `rg` at startup; if absent it falls back to a recursive Node.js `fs` traversal so the tool works on every machine without extra dependencies
- **TodoPanel UI** — a React side panel above the chat input renders live todo items; the agent can drive it by calling `todo_create` / `todo_update` and the UI reacts in real-time
- **Session Agent Lock** — on the first `POST /api/v1/chat`, the chosen `agentId` is permanently written to the `sessions` table; subsequent requests for the same session ignore `agentId` in the body and always use the bound value; the binding is **not** cleared by `DELETE /conversation/history` — it persists for the lifetime of the session and is only removed when the entire session is hard-deleted (`DELETE /sessions/:sessionId`); to use a different Agent, start a new session
- **Granular Token Breakdown** — Token usage is split into 8 categories (`systemPromptTokens`, `ragTokens`, `skillTokens`, `builtinToolsTokens`, `mcpToolsTokens`, `messagesTokens`, `toolResultsTokens`, `completionTokens`); backward-compatible `systemToolsTokens` is retained as the sum of builtin + MCP
- **Tool Output Truncation** — `truncateToolOutput()` in `react.ts` keeps head + tail of oversized tool results (default 4000 chars), preventing unbounded history growth in long-running agents
- **OpenAI Base URL normalisation** — `normalizeBaseURL()` in `openai.ts` automatically strips `/chat/completions`, `/embeddings` and other SDK-appended suffixes so users can paste any endpoint URL
- **`allowedTools` empty-array semantics** — an empty `allowedTools: []` on an Agent now means "no tools allowed" (previously treated as "all tools"); only a `null` / absent value means "all tools"

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
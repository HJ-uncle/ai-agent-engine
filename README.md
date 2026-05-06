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
| 34 | **Workspace File Upload** — Upload images/files up to 100 MB directly to session workspace via multipart binary upload |
| 35 | **Smart Read** — `smart_read` tool auto-detects file type (Excel/CSV/JSON/Code) and returns structured preview; memory-cached with mtime validation |
| 36 | **Binary File Handling** — Frontend uploads xlsx/pdf/zip and other binary files as base64; multipart upload preserves byte integrity |
| 37 | **Context Memory Switch** — Per-session toggle for conversation history injection |
| 38 | **Todo Management** — Task CRUD with REST API + AI tools (`todo_list/create/update/delete`) + UI panel |
| 39 | **Cron Jobs** — Scheduled AI actions via standard 5-field cron expressions; loopback triggers full ReAct loop |
| 40 | **Glob Search** — File pattern matching tool (`glob_search`) with wildcard support (`**`, `*`, `?`) |
| 41 | **Grep Search** — Full-text / regex search tool (`grep_search`); uses ripgrep when available, falls back to Node.js |
| 42 | **Task Control** — Agent tools to list, cancel and inspect background queue jobs (`task_list/cancel/status`) |
| 43 | **Web Fetch** — `web_fetch` tool with security domain filtering via `config/security.json` |
| 44 | **HTTP Request** — `http_request` tool for external API calls |
| 45 | **Agent Tools** — `agent` / `subagent` tools for sub-agent creation and management |
| 46 | **Get Context** — `get_context` tool for runtime context inspection |
| 47 | **Install Package** — `install_package` tool for npm package installation |
| 48 | **Fine-grained Tool Control** — Per-agent `allowedTools` configuration via `agent_allowed_tools` table |
| 49 | **Session Agent Lock** — Once a session starts, the Agent is locked and cannot be switched mid-session; cleared on history delete |
| 50 | **Granular Token Breakdown** — 8-category Token usage: system prompt, RAG, skill prompt, builtin tools, MCP tools, history messages, tool results, completion |
| 51 | **Tool Output Truncation** — Oversized tool outputs auto-truncated (head + tail) to prevent token budget explosion |
| 52 | **OpenAI Base URL Auto-fix** — Automatically strips `/chat/completions` or other endpoint suffixes from `OPENAI_BASE_URL` |
| 53 | **DB-backed Settings** — Runtime settings (LLM, agent params, skills, tools, workspace) stored in SQLite `system_config` table; sensitive keys (API keys) encrypted with AES-256-GCM; synced to `process.env` on startup |
| 54 | **Integrated Terminal** — Browser-based PTY terminal (`node-pty` + `xterm.js`) locked to session workspace; multi-tab support; `POST /terminal/create` + `WS /terminal/ws/:id` |
| 55 | **VS Code–style Explorer** — File tree with context menu (create / rename / delete / move), Monaco editor tabs, image/video preview, hex viewer, Quick Open (`Ctrl+P`), undo log |
| 56 | **Workspace Extended API** — New REST endpoints: `POST /workspace/file/create`, `POST /workspace/folder/create`, `POST /workspace/file/move`, `POST /workspace/file/trash`, `POST /workspace/file/format`, `GET /workspace/file/stream`, `POST /workspace/upload` |
| 57 | **Split Layout** — Three-mode main area: `chat-only`, `horizontal` (top/bottom), `vertical` (left/right); draggable divider (15–85%); layout ratio persisted to `localStorage` |
| 58 | **macOS Sonoma Design Tokens** — `macos-sonoma-tokens.css` — full CSS custom-property set covering materials (title bar / sidebar / content), typography, colors, spacing, shadows, border-radius, traffic-light buttons, hover states, dark-mode overrides, and utility classes |
| 59 | **Security Policy Engine** — Command injection detection with regex pattern matching; per-policy enable/disable; audit trail for every blocked command (`src/security/policy-engine.ts`) |
| 60 | **SSRF Protection** — `network-policy.ts` performs DNS pre-lookup and blocks requests to RFC-1918 private IPs (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x); domain whitelist / blacklist support; applied to both `web_fetch` and `http_request` tools |
| 61 | **Audit Log** — Structured per-tool audit entries (`toolName`, `args`, `result`, `blocked`, `tenantId`, `sessionId`) written to `audit_log` SQLite table; queryable via `GET /api/v1/security/audit-log` with filters |
| 62 | **LSP Diagnostics** — `code_diagnose` agent tool runs TypeScript compiler (`tsc --noEmit`) and ESLint on workspace files; results are cached by file-content hash; exposed as `GET /api/v1/lsp/diagnostics`; enables AI self-correction of code errors |
| 63 | **SQLite Performance Tuning** — WAL journal mode, `synchronous=NORMAL`, 20 MB page cache, 256 MB mmap, 5 s busy-timeout applied at startup via `applyPerformancePragmas()`; all thresholds configurable via env vars; expected 30-50 % query speed improvement |
| 64 | **Concurrency Pool** — `src/core/utils/concurrency-pool.ts` provides a generic async semaphore limiting parallel tool / LSP invocations to prevent DB lock contention |
| 65 | **Idempotent Message Delete** — Backend DELETE `/api/v1/messages/:id` uses a 3-branch strategy: (a) find by `message_id` → cascade-delete entire conversation round; (b) find by `conversation_id` → delete round; (c) already gone → return success; frontend cancels running stream before delete to prevent race-condition resurrection |
| 66 | **User Message Backend ID Sync** — After persisting user message to DB, backend yields `__user_msg_id__` SSE frame; frontend intercepts it and writes `backendMessageId` onto the user message object, enabling accurate delete / regenerate targeting even for messages created mid-stream |
| 67 | **Orphan Row Auto-Cleanup** — `getHistory()` detects sessions whose first rows have no `user` message (e.g. interrupted `ask_user` sub-sessions) and asynchronously deletes them, preventing ghost tool-call blocks from appearing in the UI after page refresh |

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
| `TOKEN_BUDGET` | `100000` | Max tokens per agent context window |
| `MAX_ITERATIONS` | `100` | Max ReAct loop iterations |
| `HISTORY_MAX_TOKENS` | `20000` | Max tokens kept in conversation history window (older messages dropped first) |
| `TOOL_OUTPUT_MAX_CHARS` | `4000` | Max characters of tool output before head+tail truncation |
| `COMPRESS_THRESHOLD_RATIO` | `0.5` | Compression trigger ratio of `TOKEN_BUDGET`; lower = compress earlier |
| `BASH_PATH` | _(none)_ | Path to bash executable for shell tools (e.g. `C:/Program Files/Git/bin/bash.exe` on Windows) |
| `CMD_TIMEOUT_MS` | `5000` | Shell command execution timeout in milliseconds |
| `MAX_FILE_SIZE_BYTES` | `10485760` | Maximum file size (bytes) for file read tool (default 10 MB) |
| `WEB_SEARCH_SERVER` | `http://127.0.0.1:8923` | Backend URL for web search integration |
| `MCP_CONFIG_PATH` | `./mcp.config.json` | Path to MCP server configuration file |
| `QA_LOG_DIR` | `./logs/qa` | Directory for Q&A audit log files (when `QA_LOG_ENABLED=true`) |
| `ENCRYPTION_KEY` | _(required)_ | 64 hex characters (32 bytes) AES-256-GCM key for encrypting API keys |
| `SQLITE_CACHE_KB` | `20000` | SQLite page cache size in KB (default 20 MB) |
| `SQLITE_MMAP_BYTES` | `268435456` | SQLite memory-mapped I/O size in bytes (default 256 MB) |
| `SQLITE_BUSY_TIMEOUT_MS` | `5000` | SQLite busy timeout in milliseconds |

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

### Security

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/security/policies` | List all command security policies |
| `POST` | `/api/v1/security/policies` | Create a policy (body: `name`, `pattern`, `description`, `enabled`) |
| `PUT` | `/api/v1/security/policies/:id` | Update a policy |
| `DELETE` | `/api/v1/security/policies/:id` | Delete a policy |
| `GET` | `/api/v1/security/network-policy` | Get SSRF network policy (whitelist / blacklist) |
| `PUT` | `/api/v1/security/network-policy` | Update SSRF network policy |
| `GET` | `/api/v1/security/audit-log` | Query audit log (params: `limit`, `offset`, `tenantId`, `toolName`, `blocked`) |

### LSP Diagnostics

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/lsp/diagnostics` | Get LSP configuration |
| `PUT` | `/api/v1/lsp/diagnostics` | Update LSP config (enable/disable, language settings) |
| `POST` | `/api/v1/lsp/diagnostics/run` | Run diagnostics on a file (body: `sessionId`, `path`) |

### Performance

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/performance/stats` | Get SQLite runtime pragma stats (`journal_mode`, `cache_size`, `mmap_size`, etc.) |

### Terminal

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/terminal/create` | Create a PTY session; returns `terminalId` and `cwd` |
| `WS` | `/api/v1/terminal/ws/:id` | WebSocket duplex bridge: PTY ↔ xterm.js |
| `DELETE` | `/api/v1/terminal/:id` | Kill a terminal session |

**Create body:**
```json
{ "sessionId": "my-session", "cwd": "optional/subdir", "cols": 120, "rows": 30 }
```

**WebSocket message types (client → server):**

| Type | Fields | Description |
|------|--------|-------------|
| `input` | `data: string` | Keystrokes / stdin |
| `resize` | `cols, rows` | Terminal resize |
| `kill` | — | Terminate PTY |

**WebSocket message types (server → client):**

| Type | Fields | Description |
|------|--------|-------------|
| `output` | `data: string` | PTY stdout/stderr |
| `exit` | `code: number` | Process exited |
| `error` | `message: string` | Session not found |

### Workspace (Extended)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/workspace/file/create` | Create an empty file (body: `sessionId`, `path`) |
| `POST` | `/api/v1/workspace/folder/create` | Create a directory (body: `sessionId`, `path`) |
| `POST` | `/api/v1/workspace/file/move` | Move / rename a file (body: `sessionId`, `srcPath`, `destPath`) |
| `POST` | `/api/v1/workspace/file/trash` | Move file to system trash (falls back to permanent delete) |
| `POST` | `/api/v1/workspace/file/format` | Format file content via prettier (body: `sessionId`, `path`, `content`) |
| `GET` | `/api/v1/workspace/file/stream` | Range-aware video/binary streaming (`?sessionId=&path=`) |

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
│       ├── settings.ts        # System settings (DB-backed; reads/writes system_config table)
│       ├── todos.ts           # Todo CRUD
│       ├── cron.ts            # Cron Job CRUD + enable/disable
│       ├── lsp.ts             # ★ GET /api/v1/lsp/diagnostics — LSP config
│       ├── performance.ts     # ★ GET /api/v1/performance/stats — SQLite pragma stats
│       ├── security.ts        # ★ Security policy CRUD + audit log query
│       ├── sessions.ts        # Session Agent binding (lock/query/reset)
│       ├── terminal.ts        # ★ PTY terminal (create / ws / kill)
│       └── metrics.ts         # Health + metrics
├── core/
│   ├── agent-context/         # AgentContext, Tool interfaces
│   ├── agent-loop/            # ReActStrategy
│   ├── compression/           # Context compression (extractive + keyword)
│   ├── llm-adapter/           # OpenAI / Anthropic / Ollama (multi-modal)
│   ├── stream-pipeline/       # Async pipeline + SSE sink (incl. __user_msg_id__ frame)
│   ├── tool-registry/         # ToolRegistry
│   └── utils/                 # Token estimation + concurrency-pool.ts
├── storage/
│   ├── sqlite/                # DB connection + migrations
│   ├── memory-store/          # SQLiteMemoryStore
│   ├── conversation/          # SQLiteConversationHistory (sliding window)
│   ├── task-queue/            # SQLiteTaskQueue
│   ├── cache-store/           # SQLiteCacheStore
│   ├── agent/                 # SQLiteAgentStore
│   └── knowledge/             # Knowledge base + RAG
├── lsp/                       # ★ LSP diagnostic adapters
│   ├── index.ts               # DiagnosticService: run + hash-cache
│   ├── types.ts               # DiagnosticResult interface
│   └── adapters/
│       ├── typescript.ts      # tsc --noEmit runner
│       └── eslint.ts          # ESLint programmatic API
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
│   ├── system-config/         # SystemConfigStore (SQLite KV for runtime settings, encrypted secrets)
│   └── knowledge/             # Knowledge base + RAG
├── tools/
│   ├── file/                  # read_file / write_file / list_files / delete_file / create_dir / read_image
│   ├── cmd/                   # Shell command execution
│   ├── memory/                # remember / recall / forget tools
│   ├── ask-user/              # Interactive ask_user tool
│   ├── skill/                 # External skill runner
│   ├── mcp/                   # HTTP MCP client
│   ├── search/                # glob_search (glob) + grep_search (ripgrep / Node.js fallback)
│   ├── lsp/                   # ★ code_diagnose tool (TypeScript tsc + ESLint, hash-cached)
│   ├── todo/                  # todo_list / todo_create / todo_update / todo_delete
│   ├── cron/                  # cron_list / cron_create / cron_update / cron_delete
│   ├── task/                  # task_list / task_cancel / task_status
│   ├── web-fetch/             # web_fetch tool with domain security filtering
│   ├── http-request/          # http_request tool for external API calls
│   ├── agent/                 # agent / subagent tools for sub-agent management
│   ├── get-context/           # get_context tool for runtime context inspection
│   ├── install-package/       # install_package tool for npm package installation
│   └── registry-factory.ts   # ★ Unified tool registry factory (single source of truth)
├── terminal/
│   ├── index.ts               # ★ TerminalManager — node-pty session CRUD (create/write/resize/kill)
│   └── workspace-shell.mjs    # ★ Sandboxed workspace shell (cd jail, built-in ls/cat/grep/find …)
├── skills/                    # Built-in skills (math, time) + external skill loader
├── auth/                      # JWT + API key middleware
├── observability/             # Logger + metrics + QA logger
├── prompt-template/           # Template store
├── workspace/                 # Workspace manager (multi-path support)
├── security/                  # Command whitelist + policy engine + SSRF guard
│   ├── policy-engine.ts       # ★ Regex-based command injection detection; per-policy CRUD
│   ├── network-policy.ts      # ★ SSRF protection: DNS pre-lookup + private IP blocking
│   ├── audit-log.ts           # ★ Structured audit entries → audit_log SQLite table
│   └── __tests__/             # Unit tests for policy engine
└── utils/                     # Encryption utilities
```

**Key design decisions:**
- **SQLite for everything** — no Redis, no external services required
- **Security-in-depth** — policy engine + SSRF guard + audit log form a three-layer defense; all tool executions pass through `checkPolicy()` before running; network requests pre-resolve DNS to block SSRF via private IPs
- **Idempotent deletes** — `DELETE /messages/:id` never returns 404; uses a 3-branch fallback (message_id → conversation_id → already-gone) so frontend store and DB stay in sync even after partial failures
- **Stream-cancel-then-delete** — deleting a message while a stream is running first cancels the agent loop (via the global `AbortController` registry), waits 400 ms, deletes, then waits another 600 ms and deletes again; this prevents the "resurrection" bug where the agent loop writes new DB rows after the DELETE
- **Orphan row self-healing** — every `getHistory()` call checks whether the session starts with non-user rows; if so, those rows are asynchronously deleted, preventing ghost tool-call blocks in the UI
- **Unified `Tool` interface** — file tools, shell tools, memory tools, MCP tools all share the same interface
- **`registry-factory.ts`** — single place to add/remove tools; all routes (chat / messages / tools) call `createToolRegistry()` for a consistent, complete toolset; supports `allowedTools` parameter for per-agent tool restrictions
- **Split Layout** — `MainArea` component in `App.tsx` supports three modes (`chat-only` / `horizontal` / `vertical`) switchable from a toolbar; a draggable divider resizes panes between 15 % and 85 %; the active mode and ratio are persisted to `localStorage` via a `usePersist` hook so the layout survives page reloads
- **macOS Sonoma Design Tokens** — `macos-sonoma-tokens.css` at the project root provides a comprehensive CSS custom-property library aligned with Apple HIG: materials (title bar, sidebar, content), typography (SF Pro stack), system colors & accents, spacing (4 px grid), shadow system, border-radius scale, traffic-light button sizes/colors, hover/interaction states, and dark-mode overrides via `@media (prefers-color-scheme: dark)`
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
- **DB-backed Settings** — `PUT /api/v1/settings` no longer writes to `.env`; all runtime settings are stored in the `system_config` SQLite table (key-value, UPSERT); sensitive keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) are encrypted with AES-256-GCM using `ENCRYPTION_KEY`; on startup, `main.ts` syncs all rows to `process.env` so every module reads the correct value transparently; `.env` now only contains bootstrap params (`PORT`, `HOST`, `DB_PATH`, `ENCRYPTION_KEY`, `AUTH_ENABLED`, `LOG_LEVEL`) that must be known before the database is available
- **Integrated Terminal** — `TerminalManager` (`src/terminal/index.ts`) manages `node-pty` PTY instances keyed by UUID; `workspace-shell.mjs` is a sandboxed Node.js shell that physically jails the cwd inside the session workspace (all `cd` attempts outside are rejected); built-in commands: `ls`, `ll`, `cat`, `mkdir`, `touch`, `rm`, `cp`, `mv`, `find`, `grep`, `tree`, `echo`, `env`, `clear`, `help`; external commands transparently delegated to the OS; multi-workspace support via `WORKSPACE_ROOTS` env var
- **VS Code–style Explorer** — `multi-agent-console` ships a full IDE-like sidebar: `FileTree` component with right-click context menu (create file/folder, rename, delete to trash, copy path), `EditorTabs` with dirty-state tracking via module-level `dirtyContentCache` (no re-render on every keystroke), Monaco editor for text, `ImagePreview` for images, `VideoPreview` with Range-request streaming, `HexEditor` for binary, `UnsavedDialog` on close, `QuickOpenPanel` (`Ctrl+P`) with fuzzy search backed by a `fileIndex.worker.ts` Web Worker; undo log persisted to `localStorage`
- **Workspace Extended API** — six new REST endpoints added to `workspace.ts`: create-file, create-folder, move/rename (atomic `fs.rename`), trash (uses `trash` npm package with permanent-delete fallback), format (delegates to `npx prettier` if config present in workspace root), and video stream with HTTP Range request support (206 Partial Content)

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
# Agent Engine 第三方 AI 工具集成指南

> **版本**：v1.0 | **最后更新**：2026-05-09  
> 本文档面向第三方 AI 工具（如 wuzu-client、桌面客户端等），介绍如何通过标准 HTTP + SSE 协议调用 Agent Engine 的完整能力。

---

## 目录

1. [概览](#1-概览)
2. [快速开始](#2-快速开始)
3. [认证与请求头](#3-认证与请求头)
4. [核心接口：Chat（SSE 流式）](#4-核心接口chatssr-流式)
5. [SSE 事件类型详解](#5-sse-事件类型详解)
6. [请求体完整参数](#6-请求体完整参数)
7. [资源透传（wuzu 集成）](#7-资源透传wuzu-集成)
8. [会话管理](#8-会话管理)
9. [工具与技能系统](#9-工具与技能系统)
10. [知识库（RAG）](#10-知识库rag)
11. [流取消与会话中断](#11-流取消与会话中断)
12. [其他 API 接口速查](#12-其他-api-接口速查)
13. [错误处理](#13-错误处理)
14. [最佳实践](#14-最佳实践)

---

## 1. 概览

Agent Engine 是一个 **LLM Agent 运行时引擎**，提供 ReAct 循环、工具调用、知识检索、MCP 协议支持等完整能力。第三方 AI 工具通过标准 HTTP/SSE 协议即可直接驱动引擎完成复杂任务。

### 核心能力

| 能力 | 说明 |
|------|------|
| **多模型支持** | OpenAI / Anthropic / DeepSeek / Ollama / Qwen 等，请求级可切换 |
| **ReAct 循环** | 思考 → 工具调用 → 观察 → 反思的完整代理循环 |
| **工具系统** | 内置文件操作、Shell 命令、Web 搜索、代码编辑 + MCP 外部工具 |
| **RAG 知识库** | 文档上传 → 向量检索 → 上下文注入，请求级 KB 白名单 |
| **会话管理** | 完整历史持久化、Token 统计、消息重生成 |
| **工作区** | 隔离的物理工作目录，支持 VS Code 风格文件操作 |
| **安全防护** | 命令注入检测 + SSRF 防护 + 审计日志三层防御 |
| **Superpower 模式** | 四档能力档位（off/balanced/methodology/max），控制工具集、预算倍率和系统提示词注入 |

---

## 2. 快速开始

### 最小可用示例

```bash
curl -X POST http://localhost:3000/api/v1/chat \
  -H "Content-Type: application/json" \
  -H "X-Request-ID: $(uuidgen)" \
  -H "X-Client-Version: 1.0.0" \
  -d '{
    "message": "列出当前目录下的所有文件",
    "sessionId": "my-first-session"
  }' \
  --no-buffer
```

返回 SSE 流：

```
data: {"userMsgId":"msg_abc123"}

data: {"thinking":"我来帮用户列出目录..."}

data: {"toolCall":{"toolName":"list_files","args":{"path":"."},"toolCallId":"tc-1","messageId":"msg_abc123"}}

data: {"toolResult":{"toolName":"list_files","toolCallId":"tc-1","success":true,"output":"file1.ts\nfile2.ts\ndir/","durationMs":45}}

data: {"content":"当前目录包含以下文件..."}

data: {"usage":{"promptTokens":1200,"completionTokens":300,"totalTokens":1500}}

data: [DONE]
```

### 协议版本选择

引擎**同时**发送新旧两种命名格式的 envelope，第三方工具可任选其一消费：

| 事件场景 | 旧版字段名 | 新版字段名（推荐） |
|---------|-----------|-------------------|
| 工具调用开始 | `toolStart` | `toolCall` |
| 工具调用结束 | `toolEnd` | `toolResult` |
| 用户交互请求 | `ask_user` | `permissionRequest` |
| 用户消息 ID | `user_msg_id` | `userMsgId`（两方同字段名） |

**推荐使用新版字段**：遵循 camelCase 命名，携带更丰富的元数据（`sessionId`、`messageId`、`durationMs` 等）。

---

## 3. 认证与请求头

### 必需请求头

所有 `/api/v1/*` 接口（白名单除外）必须携带：

```
X-Request-ID: <uuid>          # 请求唯一追踪标识，建议 UUID v4
X-Client-Version: <semver>    # 客户端版本号，如 "1.0.0"
```

### 白名单接口（无需以上头）

- `GET /health`
- `GET /openapi.json`
- `GET /metrics`

### 多租户

引擎支持多租户隔离（可选）。若启用认证中间件，租户 ID 从认证上下文中自动提取；否则默认为 `"default"`。

---

## 4. 核心接口：Chat（SSE 流式）

```
POST /api/v1/chat
Content-Type: application/json
```

这是第三方工具与引擎交互的**核心入口**。所有对话、工具调用、知识检索均通过此接口流式返回。

### 请求体（最小）

```json
{
  "message": "你好，请帮我分析这段代码",
  "sessionId": "optional-session-id",
  "agentId": "optional-agent-id"
}
```

### 响应格式

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `Connection: keep-alive`
- `X-Accel-Buffering: no`（禁用 Nginx 缓冲）

每条数据帧格式：`data: <JSON>\n\n`

### 流生命周期

```
[连接建立] → userMsgId → thinking/toolCall/toolResult/content... → usage → [DONE] → [连接关闭]
```

---

## 5. SSE 事件类型详解

### 5.1 用户消息 ID — `userMsgId`

**时序**：流的**首帧**，标识用户消息已持久化到数据库。

```json
{ "userMsgId": "msg_abc123" }
```

> 后端内部使用 `__user_msg_id__` 和 `__userMsgId__` 两个控制帧，客户端收到的 envelope 字段均为 `userMsgId`。

---

### 5.2 思考过程 — `thinking`

**时序**：流中任意位置，展示模型推理过程（DeepSeek R1 / Claude thinking）。

```json
{ "thinking": "让我分析用户的需求...首先需要理解代码结构..." }
```

---

### 5.3 工具调用开始 — `toolCall`（新版推荐） / `toolStart`（旧版兼容）

```json
// 新版（推荐）
{
  "toolCall": {
    "toolName": "read_file",
    "args": { "path": "src/index.ts" },
    "toolCallId": "tc_abc123",
    "messageId": "msg_abc123"
  }
}

// 旧版（兼容）
{
  "toolStart": {
    "name": "read_file",
    "args": { "path": "src/index.ts" },
    "toolCallId": "tc_abc123"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `toolCallId` | string | 工具调用唯一 ID，与 `toolResult` 配对去重 |
| `toolName` / `name` | string | 工具名称 |
| `args` | object | 工具参数 |
| `messageId` | string | ⭐ 关联的用户消息 ID（仅新版） |

---

### 5.4 工具调用结束 — `toolResult`（新版推荐） / `toolEnd`（旧版兼容）

```json
// 新版（推荐）
{
  "toolResult": {
    "toolName": "read_file",
    "toolCallId": "tc_abc123",
    "success": true,
    "output": "import React from 'react'\n...",
    "durationMs": 45
  }
}

// 旧版（兼容）
{
  "toolEnd": {
    "name": "read_file",
    "toolCallId": "tc_abc123",
    "success": true,
    "outputPreview": "import React from 'react'\n..."
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `toolCallId` | string | 配对 `toolCall` 的 ID |
| `success` | boolean | 工具执行是否成功 |
| `output` / `outputPreview` | string | 工具输出（新版返回完整输出，旧版可能截断） |
| `durationMs` | number | ⭐ 工具执行耗时（毫秒，仅新版） |

---

### 5.5 用户交互请求 — `permissionRequest`（新版推荐） / `ask_user`（旧版兼容）

当 Agent 需要向用户确认或提问时触发。

```json
// 新版（推荐）
{
  "permissionRequest": {
    "requestId": "tc_abc123",
    "toolName": "ask_user",
    "args": {
      "question": "是否继续执行删除操作？",
      "options": ["继续", "取消", "预览影响"]
    },
    "sessionId": "sess_xyz",
    "messageId": "msg_abc123",
    "description": "用户需要确认是否继续执行删除操作"
  }
}

// 旧版（兼容）
{
  "ask_user": {
    "question": "是否继续执行删除操作？",
    "options": ["继续", "取消", "预览影响"],
    "toolCallId": "tc_abc123"
  }
}
```

**如何回复**：客户端收集用户选择后，通过 `toolResponse` 字段发送下一条 Chat 请求：

```json
{
  "message": "继续",
  "sessionId": "sess_xyz",
  "toolResponse": {
    "toolCallId": "tc_abc123",
    "name": "ask_user",
    "output": "继续"
  }
}
```

---

### 5.6 Token 用量 — `usage`

```json
{
  "usage": {
    "systemPromptTokens": 450,
    "ragTokens": 120,
    "skillTokens": 80,
    "builtinToolsTokens": 200,
    "mcpToolsTokens": 0,
    "messagesTokens": 1800,
    "toolResultsTokens": 500,
    "completionTokens": 300,
    "promptTokens": 3150,
    "totalTokens": 3450,
    "systemToolsTokens": 120,
    "cacheHitTokens": 800,
    "cacheMissTokens": 0,
    "reasoningTokens": 50
  }
}
```

| 字段 | 说明 |
|------|------|
| `promptTokens` | 总 prompt token（含 system / rag / skills / tools / messages 各分项） |
| `completionTokens` | 模型输出 token |
| `totalTokens` | prompt + completion |
| `cacheHitTokens` | ⭐ DeepSeek KV Cache 命中 token 数 |
| `cacheMissTokens` | ⭐ DeepSeek KV Cache 未命中 token 数 |
| `reasoningTokens` | ⭐ DeepSeek R1 reasoning_content token 数 |

> 带 ⭐ 的字段仅在 DeepSeek 模型下出现，不存在时为 `undefined`。
> **注意**：从 v1.1.0 开始，历史记录中的 `assistant` 消息会包含 `modelId` 字段，记录实际产生该响应的模型 ID。

---

### 5.7 文本内容 — `content`

**时序**：流的主体，每次输出一个文本增量。

```json
{ "content": "这段代码实现了..." }
```

---

### 5.8 消息块边界 — `messageBlock`

**时序**：可选，标记单条 AI 消息的边界，用于流中持久化锚点。

```json
{
  "messageBlock": {
    "messageId": "msg_abc123",
    "role": "assistant",
    "content": "整条消息完整内容..."
  }
}
```

> ⚠️ 当前生产端（react.ts）尚未 yield 此帧，为前向兼容预留。

---

### 5.9 流终止 — `[DONE]`

```
data: [DONE]
```

**语义**：流式响应完成，连接可关闭。引擎发送此帧后会自动 `reply.raw.end()`。

---

## 6. 请求体完整参数

```typescript
interface ChatRequest {
  // ── 核心 ──
  message: string                           // 用户消息内容（必填）
  sessionId?: string                        // 会话 ID，不传则自动生成 UUID
  agentId?: string                          // 使用的 Agent ID

  // ── 提示词 ──
  systemPrompt?: string                     // 自定义系统提示词（优先级最高）
  thinkingMode?: boolean                    // 启用思考模式（DeepSeek R1 / Claude thinking）
  inheritContext?: boolean                  // 是否继承历史上下文（默认 true）

  // ── 控制 ──
  maxAskUserCount?: number                  // 最大向用户提问次数（默认 5）
  toolResponse?: {                          // 回应用户交互
    toolCallId: string
    name: string
    output: string
  }

  // ── 附件 ──
  attachments?: Array<{
    name: string
    content: string
    type: string                            // MIME type
    encoding?: 'utf-8' | 'base64'
  }>

  // ── 工作区 ──
  workspacePaths?: string[]                 // 工作区目录，供 Agent 读写

  // ── RAG ──
  ragTopK?: number                          // RAG 检索 Top K（默认 3）

  // ── 模型覆盖（请求级，最高优先级） ──
  model?: string                            // 模型名
  modelApiKey?: string                      // API Key
  modelBaseUrl?: string                     // Base URL
  modelProvider?: string                    // 提供商：openai | anthropic | deepseek | qwen | ...

  // ── 资源白名单（wuzu 集成） ──
  skills?: string[]                         // Skill ID 白名单
  mcpServers?: string[]                     // MCP Server ID 白名单
  knowledgeBases?: string[]                 // 知识库 ID 白名单
  allowedTools?: string[]                   // 工具白名单

  // ── 内联资源（wuzu 客户端透传） ──
  inlineSkills?: Array<{...}>               // Skill 内联 payload
  inlineMcpServers?: Array<{...}>           // MCP 内联配置
  inlineAgent?: {                           // Agent 内联配置
    name: string
    systemPrompt?: string
    knowledgeBaseIds?: string[]
    // ...
  }
  inlineKnowledgeBases?: Array<{...}>       // KB 元数据列表
  inlineMemoriesXml?: string                // 用户长期记忆 XML
}
```

---

## 7. 资源透传（wuzu 集成）

当第三方客户端（如 wuzu-client）需要在请求中透传自己的本地资源时，使用 `inline*` 系列字段：

### 优先级链（由高到低）

```
请求级字段 > Agent 配置 > 环境变量
```

### 工作流程

```
┌──────────────────┐
│  wuzu-client     │
│  本地 skill/mcp   │──── inlineSkills / inlineMcpServers / inlineKnowledgeBases ────┐
│  本地 model 凭证  │──── modelApiKey / modelBaseUrl / modelProvider ──────────────┐│
│  用户记忆 XML     │──── inlineMemoriesXml ──────────────────────────────────────┐││
└──────────────────┘                                                               │││
                                                                                   ▼▼▼
                             ┌──────────────────────────────────────────────────────┐
                             │              Agent Engine                            │
                             │  1. 注册内联 Skill/MCP 到工具注册表                    │
                             │  2. 用请求级凭证覆盖 DB/env 配置                       │
                             │  3. 注入 KB 目录到 system prompt                       │
                             │  4. 注入用户记忆到 system prompt                       │
                             │  5. 执行 ReAct 循环                                   │
                             └──────────────────────────────────────────────────────┘
```

### inlineSkills

客户端本地 Skill 的完整定义（含 SKILL.md 内容），引擎会将其注册到工具注册表，使 Agent 可通过 `list_skills` / `get_skill` 发现和调用。

```json
{
  "inlineSkills": [
    {
      "id": "my-custom-skill",
      "name": "自定义代码审查",
      "description": "对 PR 进行安全审查",
      "promptContent": "# 代码审查 Skill\n\n你是一个代码安全审查专家..."
    }
  ]
}
```

### inlineKnowledgeBases

客户端项目的知识库文档元数据（仅标题/ID/标签等，不包含正文），引擎注入到 system prompt 让 LLM 感知可用知识库。

```json
{
  "inlineKnowledgeBases": [
    {
      "id": "kb-001",
      "title": "项目架构文档",
      "sourceType": "markdown",
      "chunkCount": 15,
      "scope": "project",
      "tags": ["architecture", "backend"]
    }
  ]
}
```

### inlineMemoriesXml

客户端持久化的用户长期记忆（lobster-core 格式），整段注入到 system prompt 末尾：

```json
{
  "inlineMemoriesXml": "<userMemories><memory key='pref_lang'>用户偏好 TypeScript</memory></userMemories>"
}
```

---

## 8. 会话管理

### 会话绑定机制

会话首次发送消息时，`agentId` 会被**永久锁定**到该会话。后续请求无论传入什么 `agentId` 都会被忽略。

- ✅ 新建会话 → 传入新的 `agentId` 生效
- ❌ 已有会话 → 传入不同 `agentId` 被忽略
- ✅ 查询绑定状态：`GET /api/v1/sessions/:sessionId/binding`

### 查询会话历史

```
GET /api/v1/conversation/history?sessionId=xxx&current=1&pageSize=20
```

### 删除会话

```
DELETE /api/v1/sessions/:sessionId?keepWorkspace=true   # 保留工作区文件
DELETE /api/v1/sessions/:sessionId                       # 物理删除全部
```

### 消息操作

```
DELETE /api/v1/messages/:messageId          # 删除单条消息
PUT    /api/v1/messages/:messageId          # 编辑消息 + 触发重新生成（SSE）
POST   /api/v1/messages/:messageId/regenerate  # 重新生成 AI 响应（SSE）
```

---

## 9. 工具与技能系统

### 工具层次

```
┌─────────────────────────────────────┐
│        MCP 外部工具（动态加载）        │  ← mcpServers 白名单控制
├─────────────────────────────────────┤
│       自定义 Skills（SKILLS 目录）     │  ← skills 白名单控制
├─────────────────────────────────────┤
│       系统内置工具（文件/Shell/Web）    │  ← allowedTools 白名单控制
└─────────────────────────────────────┘
```

### 查询可用工具

```
GET /api/v1/tools                # 所有工具
GET /api/v1/tools/system-tools   # 系统内置工具
GET /api/v1/tools/external-skills # 自定义技能
```

---

## 10. 知识库（RAG）

### 工作方式

1. 管理员通过 `POST /api/v1/knowledge/documents` 上传文档
2. 引擎自动解析、分块、向量化存储
3. 每次 Chat 请求时，引擎根据 `message` 内容自动检索相关 chunk
4. 检索结果作为 `ragPrompt` 注入 system prompt

### 请求级控制

```json
{
  "message": "...",
  "knowledgeBases": ["kb-001", "kb-002"],  // 白名单过滤
  "ragTopK": 5                              // 检索数量
}
```

---

## 11. 流取消与会话中断

### 方式一：客户端断开连接

断开 SSE 连接（如 `fetch.abort()` 或关闭 EventSource），引擎自动检测 `close` / `aborted` 事件并终止 Agent 执行。

### 方式二：主动取消

```
POST /api/v1/chat/cancel
Content-Type: application/json

{ "sessionId": "sess_xyz" }
```

**返回：**
```json
{
  "code": 200,
  "message": "OK",
  "data": { "sessionId": "sess_xyz", "cancelled": true },
  "timestamp": 1745222400000
}
```

### 注意

- 同一会话同时只允许有一个活跃流
- 新流开始前会自动 abort 同会话的旧流
- 取消行为将触发 `AbortController.abort()`，ReAct 循环在下一次 `signal.throwIfAborted()` 处终止

---

## 12. 其他 API 接口速查

### Agent 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/agents` | 创建 Agent |
| GET | `/api/v1/agents` | Agent 列表 |
| GET | `/api/v1/agents/:id` | Agent 详情 |
| PUT | `/api/v1/agents/:id` | 更新 Agent |
| DELETE | `/api/v1/agents/:id` | 删除 Agent |

### MCP 服务器

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/mcp/servers` | 注册 MCP 服务器 |
| GET | `/api/v1/mcp/servers` | MCP 服务器列表 |
| POST | `/api/v1/mcp/servers/:id/enable` | 启用 |
| POST | `/api/v1/mcp/servers/:id/disable` | 禁用 |
| POST | `/api/v1/mcp/servers/:id/test` | 测试连接 |

### 知识库

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/knowledge/documents` | 上传文档 |
| GET | `/api/v1/knowledge/documents` | 文档列表 |
| POST | `/api/v1/knowledge/search` | 语义搜索 |

### 工作区

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/workspace/files` | 文件树 |
| GET | `/api/v1/workspace/file/content` | 读取文件内容 |
| POST | `/api/v1/workspace/file/create` | 创建文件 |
| POST | `/api/v1/workspace/folder/create` | 创建目录 |
| POST | `/api/v1/workspace/file/move` | 移动/重命名 |
| POST | `/api/v1/workspace/file/trash` | 移入回收站 |
| POST | `/api/v1/workspace/upload` | 二进制上传 |

### Token 查询

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/messages/:messageId/tokens` | 单条消息 Token |
| GET | `/api/v1/sessions/:sessionId/tokens` | 会话总 Token |

### 模型管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/models/whitelist` | 模型白名单（含思考模式支持） |
| GET | `/api/v1/models` | 已配置模型列表 |

### 系统设置

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/settings` | 运行时配置 |
| PUT | `/api/v1/settings` | 更新配置 |

---

## 13. 错误处理

### 标准错误响应

```json
{
  "code": 40001,
  "message": "参数验证失败：用户ID不能为空",
  "data": null,
  "timestamp": 1745222400000
}
```

### 错误码表

| Code | 说明 |
|------|------|
| `200` | 成功 |
| `40000` | 业务逻辑错误 |
| `40001` | 参数缺失/格式错误 |
| `40002` | 请求头校验失败 |
| `40100` | 未授权/Token 无效 |
| `40300` | 权限不足 |
| `40400` | 资源不存在 |
| `40900` | 资源冲突 |
| `50000` | 服务器内部错误 |

### SSE 流中错误

引擎不会在 SSE 流中发送错误 envelope。如果流异常中断（无 `[DONE]`），客户端应：
1. 等待超时（建议 120 秒）
2. 主动调用 `POST /api/v1/chat/cancel` 确保后端终止
3. 重试或提示用户

---

## 14. 最佳实践

### 1. 去重工具调用

由于新旧协议同时发送，同一工具调用会收到两条 envelope（`toolStart` + `toolCall`）。建议：

```typescript
// 使用 toolCallId 去重
const seenToolCalls = new Set<string>()

function handleSSEEvent(event: SSEEvent) {
  if (event.toolCall) {
    if (seenToolCalls.has(event.toolCall.toolCallId)) return
    seenToolCalls.add(event.toolCall.toolCallId)
    // 处理工具调用开始
  }
  if (event.toolResult) {
    // toolResult 不需要去重，仅新版发送完整 output
    // 若同时收到 toolEnd，优先使用 toolResult 的 output
  }
}
```

### 2. 优先使用新版 envelope

```typescript
// 推荐的事件消费优先级
function getToolOutput(event: SSEEvent): string | null {
  // 优先取新版完整 output
  if (event.toolResult?.output) return event.toolResult.output
  // 回退旧版 outputPreview
  if (event.toolEnd?.outputPreview) return event.toolEnd.outputPreview
  return null
}
```

### 3. 流式 UI 推荐渲染顺序

```
1. userMsgId         → 确认消息已保存
2. thinking          → 显示"思考中"动画
3. toolCall          → 显示"正在执行 XXX 工具..."
4. toolResult        → 显示工具执行结果
5. content           → 增量渲染 Markdown 文本
6. usage             → 更新 Token 计数器
7. [DONE]            → 标记完成，停止加载动画
```

### 4. 连接健壮性

```typescript
// 实现自动重连（需维护 sessionId）
async function chatWithRetry(request: ChatRequest, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 120_000)

      const response = await fetch('/api/v1/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-ID': crypto.randomUUID(),
          'X-Client-Version': '1.0.0',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      })

      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response  // 返回 ReadableStream 供 SSE 解析
    } catch (err) {
      if (i === maxRetries - 1) throw err
      await new Promise(r => setTimeout(r, 1000 * (i + 1)))
    }
  }
}
```

### 5. 会话 ID 持久化

```typescript
// 首次请求不传 sessionId，从 SSE 首帧获取后端生成的 ID
let sessionId: string | null = null

function handleFirstFrame(event: { userMsgId?: string }) {
  if (!sessionId) {
    // 从响应头或首帧获取（实际需从请求参数 / 历史中恢复）
    sessionId = localStorage.getItem('currentSessionId')
  }
}

// 新会话
async function newSession() {
  sessionId = null
  localStorage.removeItem('currentSessionId')
  // 发送请求后从 userMsgId 事件关联 session
}
```

### 6. 请求级模型切换

桌面客户端可在每次请求中动态切换模型，无需修改服务端配置：

```json
{
  "message": "...",
  "model": "claude-sonnet-4-20250514",
  "modelApiKey": "sk-ant-...",
  "modelBaseUrl": "https://api.anthropic.com",
  "modelProvider": "anthropic"
}
```

> 请求级凭证**完全覆盖** DB 和环境变量配置，优先级最高。

---

## 附录 A：完整 SSE 解析器示例（TypeScript）

```typescript
interface SSEControlFrame {
  type: 'userMsgId' | 'thinking' | 'content' | 'usage'
       | 'toolStart' | 'toolEnd'           // 旧版
       | 'toolCall' | 'toolResult'         // 新版
       | 'ask_user' | 'permissionRequest'  // 用户交互
       | 'messageBlock' | 'done'
  data: unknown
}

async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<SSEControlFrame> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += value
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()

      if (payload === '[DONE]') {
        yield { type: 'done', data: null }
        return
      }

      try {
        const obj = JSON.parse(payload)
        if ('userMsgId' in obj)       yield { type: 'userMsgId', data: obj.userMsgId }
        else if ('thinking' in obj)    yield { type: 'thinking', data: obj.thinking }
        else if ('content' in obj)     yield { type: 'content', data: obj.content }
        else if ('usage' in obj)       yield { type: 'usage', data: obj.usage }
        else if ('toolCall' in obj)    yield { type: 'toolCall', data: obj.toolCall }
        else if ('toolResult' in obj)  yield { type: 'toolResult', data: obj.toolResult }
        else if ('toolStart' in obj)   yield { type: 'toolStart', data: obj.toolStart }
        else if ('toolEnd' in obj)     yield { type: 'toolEnd', data: obj.toolEnd }
        else if ('permissionRequest' in obj) yield { type: 'permissionRequest', data: obj.permissionRequest }
        else if ('ask_user' in obj)    yield { type: 'ask_user', data: obj.ask_user }
        else if ('messageBlock' in obj) yield { type: 'messageBlock', data: obj.messageBlock }
      } catch {
        // 忽略非法 JSON
      }
    }
  }
}
```

---

## 附录 B：事件去重与状态机参考

```typescript
class ChatStateMachine {
  private seenToolCalls = new Set<string>()
  private currentToolCall: { id: string; name: string } | null = null

  handle(event: SSEControlFrame) {
    switch (event.type) {
      case 'userMsgId':
        // 会话已持久化
        break

      case 'thinking':
        // 展示思考动画
        break

      case 'toolCall': {
        const tc = event.data as { toolCallId: string; toolName: string }
        if (this.seenToolCalls.has(tc.toolCallId)) return  // 去重
        this.seenToolCalls.add(tc.toolCallId)
        this.currentToolCall = { id: tc.toolCallId, name: tc.toolName }
        // 显示 "正在执行 {toolName}..."
        break
      }

      case 'toolStart': {
        // 旧版兼容：如果已通过 toolCall 处理过，跳过
        const ts = event.data as { toolCallId: string; name: string }
        if (this.seenToolCalls.has(ts.toolCallId)) return
        this.seenToolCalls.add(ts.toolCallId)
        this.currentToolCall = { id: ts.toolCallId, name: ts.name }
        break
      }

      case 'toolResult': {
        const tr = event.data as { toolCallId: string; success: boolean; output: string; durationMs: number }
        // 显示工具执行结果
        break
      }

      case 'toolEnd': {
        // 如果已有 toolResult，可跳过（toolResult output 更完整）
        break
      }

      case 'permissionRequest': {
        const pr = event.data as { requestId: string; description: string; args: { options?: string[] } }
        // 弹出用户确认对话框
        break
      }

      case 'content':
        // 增量追加 Markdown 文本
        break

      case 'usage':
        // 更新 Token 计数器
        break

      case 'done':
        // 流结束，清理状态
        break
    }
  }
}
```

---

> 📧 如有疑问，请联系 Agent Engine 团队获取技术支持。

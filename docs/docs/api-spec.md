# 核心引擎 API 接口文档

## 统一响应格式说明

为保持全平台接口风格一致性，所有 HTTP 响应统一使用 JSON 结构返回。
无论业务是否成功，HTTP 状态码原则上均为 `200 OK`，实际的业务状态由 JSON 中的 `code` 字段决定。

### 成功响应（单条/对象）
```json
{
  "code": 200,
  "message": "操作成功",
  "data": { ... },
  "timestamp": 1745222400000
}
```

### 成功响应（列表+分页）
当请求参数中携带 `current` 和 `pageSize` 字段时，返回分页格式：
```json
{
  "code": 200,
  "message": "查询成功",
  "data": [...],
  "pagination": {
    "current": 1,
    "pageSize": 10,
    "total": 25,
    "totalPages": 3
  },
  "timestamp": 1745222400000
}
```

### 失败响应
```json
{
  "code": 40001,
  "message": "参数验证失败：用户ID不能为空",
  "data": null,
  "timestamp": 1745222400000
}
```

> **注意：** 在 `production` 环境下，为了系统安全，500 类的内部错误信息会被自动脱敏，统一返回 `"Internal server error"`，避免泄露后端路径或数据库结构等敏感信息。

---

## 多租户隔离策略

系统通过 `X-Tenant-ID` 请求头（可选，默认 `default`）实现逻辑和物理隔离。
- **数据库级别**：所有 SQL 查询均强制包含 `tenant_id` 过滤条件。
- **文件系统级别**：每个租户拥有独立的 `workspace` 根目录。
- **统一助手**：后端路由统一使用 `getTenantId(request)` 助手函数获取当前上下文租户，确保了隔离逻辑在全模块的一致性。

---

## 业务错误码表

| Code | 说明 |
| :--- | :--- |
| `200` | 请求成功 |
| `40000` | 业务限制或逻辑错误 |
| `40001` | 缺少必填参数或参数格式错误 |
| `40002` | 请求头校验失败（如 `X-Client-Version`） |
| `40100` | 未授权或 Token 无效 |
| `40300` | 权限不足（如非管理员操作） |
| `40400` | 资源不存在 |
| `40900` | 资源冲突（例如重复创建） |
| `50000` | 服务器内部错误 / 数据库异常 |

---

## 接口访问策略与白名单

所有接口（除白名单外）在请求 Header 中必须携带以下字段：
- `X-Request-ID`: 请求唯一追踪标识
- `X-Client-Version`: 客户端版本号

**白名单接口**（无需以上校验）：
- `/health`
- `/openapi.json`
- `/metrics`

---

## 核心接口说明
> 注：`chat` 接口因具有特殊流式响应不受标准响应格式管辖。

### 1. 智能体 Agent (`/api/v1/agents`)
- `POST /api/v1/agents`: 创建自定义 Agent
- `GET /api/v1/agents`: 获取 Agent 列表 (支持分页 `?current=1&pageSize=10`)
- `GET /api/v1/agents/:id`: 获取 Agent 详情
- `PUT /api/v1/agents/:id`: 更新 Agent
- `DELETE /api/v1/agents/:id`: 删除 Agent

### 2. 会话与历史 Conversation (`/api/v1/conversation` & `/api/v1/sessions`)
- `GET /api/v1/conversation/sessions`: 获取有对话的会话列表 (支持分页)
- `GET /api/v1/conversation/history?sessionId=xxx`: 查询指定会话的所有历史消息 (支持分页)。返回的 `Message` 对象包含 `id`, `role`, `content`, `tokens`, `usage`, `modelId` 等字段。
- `DELETE /api/v1/conversation/history?sessionId=xxx`: 清空指定会话的历史消息记录（**不**解除 Agent 绑定，绑定与会话生命周期一致）
- `GET /api/v1/conversations/:conversationId`: 按 conversationId 查询单轮对话消息 (支持分页)
- `DELETE /api/v1/sessions/:sessionId`: 硬删除整个会话记录及关联 (可选参数 `?keepWorkspace=true` 仅删除记录保留物理工作区文件)

### 3. 用户消息管理 Messages (`/api/v1/messages`)
- `GET /api/v1/messages/:messageId/tokens`: 获取单条消息的 Token 使用量
- `GET /api/v1/sessions/:sessionId/tokens`: 获取指定会话的总 Token 消耗 (包含已删除消息)
- `DELETE /api/v1/messages/:messageId`: 硬删除单条消息 (不影响全局 Token 统计)
- `PUT /api/v1/messages/:messageId`: 编辑用户消息内容并触发重新生成响应 (Stream)

  **请求体：**
  ```json
  {
    "content": "修改后的消息内容",
    "systemPrompt": "可选，自定义系统提示词",
    "maxAskUserCount": 5,
    "thinkingMode": false
  }
  ```

- `POST /api/v1/messages/:messageId/regenerate`: 对指定 AI 响应进行重新生成 (Stream)

  **请求体：**
  ```json
  {
    "systemPrompt": "可选，自定义系统提示词",
    "maxAskUserCount": 5,
    "thinkingMode": false
  }
  ```

### 4. 知识库 Knowledge (`/api/v1/knowledge`)
- `POST /api/v1/knowledge/documents`: 上传并解析知识库文档内容
- `GET /api/v1/knowledge/documents`: 知识库文档列表查询 (支持分页)
- `DELETE /api/v1/knowledge/documents/:id`: 删除指定知识库文档
- `POST /api/v1/knowledge/search`: 知识库语义相似度搜索检索

### 5. 模型上下文协议 MCP (`/api/v1/mcp`)
- `GET /api/v1/mcp/servers`: 获取所有 MCP 服务器状态及信息 (支持分页)
- `POST /api/v1/mcp/servers`: 注册/创建一个新的 MCP 服务器
- `GET /api/v1/mcp/servers/:id`: 获取单个 MCP 服务器详情
- `PUT /api/v1/mcp/servers/:id`: 全量更新指定的 MCP 服务器配置
- `PATCH /api/v1/mcp/servers/:id`: 部分更新指定的 MCP 服务器配置
- `DELETE /api/v1/mcp/servers/:id`: 删除指定的 MCP 服务器
- `POST /api/v1/mcp/servers/:id/enable`: 启用指定的 MCP 服务器
- `POST /api/v1/mcp/servers/:id/disable`: 禁用指定的 MCP 服务器
- `POST /api/v1/mcp/servers/:id/test`: 测试指定 MCP 服务器的连接情况及获取支持的工具
- `POST /api/v1/mcp/servers/:name/restart`: 重启指定运行中的 MCP 服务器

### 6. 记忆存储 Memory (`/api/v1/memory`)
- `POST /api/v1/memory/remember`: 保存新的记忆节点（支持 `key`/`value` 兼容格式或 `content`/`type` 完整格式）
- `GET /api/v1/memory/recall/:key?sessionId=xxx`: 根据标签/关键字回忆记忆
- `GET /api/v1/memory/list`: 获取记忆节点列表 (支持分页和 `?sessionId=xxx`)
- `GET /api/v1/memory/graph?sessionId=xxx`: 获取记忆图谱数据（包含节点和边，用于可视化）
- `DELETE /api/v1/memory/:id`: 删除指定的记忆节点
- `PUT /api/v1/memory/:id`: 更新记忆节点内容、类型或重要度
- `POST /api/v1/memory/link`: 手动建立两个记忆节点之间的关联边
- `POST /api/v1/memory/consolidate`: 手动触发记忆反思、整理与衰减模拟

### 7. 任务调度 Tasks (`/api/v1/tasks`)
- `POST /api/v1/tasks`: 创建新的异步任务或工作流
- `GET /api/v1/tasks`: 获取系统内的任务列表 (支持分页)
- `GET /api/v1/tasks/:id`: 根据任务 ID 查询任务当前状态与详情
- `PUT /api/v1/tasks/:id`: 更新任务状态或参数
- `DELETE /api/v1/tasks/:id`: 删除/取消任务

### 8. 工具与插件 Tools (`/api/v1/tools`)
- `GET /api/v1/tools`: 获取当前系统加载的所有可用工具和技能列表 (支持分页)
- `GET /api/v1/tools/system-tools`: 获取所有系统内置工具列表（排除技能工具，支持分页）
- `GET /api/v1/tools/external-skills`: 获取所有自定义技能（SKILLs 目录）列表（支持分页）

### 9. 工作区 Workspace (`/api/v1/workspace`)
- `GET /api/v1/workspace/files`: 获取工作区文件和目录树结构 (支持可选参数 `?sessionId=xxx`)
- `GET /api/v1/workspace/recent`: 获取最近使用的工作区列表 (包含名称、路径和是否活跃状态)
- `GET /api/v1/workspace/file/content`: 获取工作区文件内容 (需参数 `?sessionId=xxx&path=yyy`)
- `GET /api/v1/workspace/image`: 获取工作区图片并以 data URL 格式返回，供前端预览 (需参数 `?sessionId=xxx&path=yyy`)
- `POST /api/v1/workspace/file`: 上传文件到指定 session 的工作区 (multipart/form-data，支持最大 100MB，字段名 `file` + `sessionId`)
- `DELETE /api/v1/workspace/recent/:sessionId`: 物理删除指定的工作区目录
- `POST /api/v1/workspace/rename`: 重命名工作区目录及关联的 `sessionId` (自动更新对话记录和记忆中的关联)

  **扩展文件操作接口（VS Code Explorer 支持）：**

- `POST /api/v1/workspace/file/create`: 在工作区中创建空文件

  **请求体：** `{ "sessionId": "xxx", "path": "subdir/newfile.ts" }`

- `POST /api/v1/workspace/folder/create`: 在工作区中创建目录（自动递归创建父目录）

  **请求体：** `{ "sessionId": "xxx", "path": "subdir/newfolder" }`

- `POST /api/v1/workspace/file/move`: 移动或重命名文件/目录（原子操作，目标已存在时报错）

  **请求体：** `{ "sessionId": "xxx", "srcPath": "old/path.ts", "destPath": "new/path.ts" }`

- `POST /api/v1/workspace/file/trash`: 将文件/目录移入系统回收站（依赖 `trash` 包，不可用时降级为永久删除）

  **请求体：** `{ "sessionId": "xxx", "path": "subdir/file.ts" }`

- `POST /api/v1/workspace/file/format`: 使用 prettier 格式化文件内容（工作区根目录存在 prettier 配置时生效，否则原样返回）

  **请求体：** `{ "sessionId": "xxx", "path": "src/index.ts", "content": "..." }`

  **返回：** `{ "content": "格式化后的内容" }`

- `GET /api/v1/workspace/file/stream`: 视频/二进制流媒体，支持 HTTP Range 分片（206 Partial Content）

  **参数：** `?sessionId=xxx&path=video.mp4`

- `POST /api/v1/workspace/upload`: **multipart 二进制文件上传**（保留原始字节流，适用于 xlsx、图片等二进制文件，避免 UTF-8 编码污染）

  **请求方式：** `multipart/form-data`

  **表单字段：**

  | 字段 | 类型 | 必填 | 说明 |
  |------|------|------|------|
  | `file` | File | ✅ | 二进制文件 |
  | `sessionId` | string | ✅ | 目标会话 ID |
  | `path` | string | ✅ | 上传路径（相对于工作区根目录） |

  **返回：**
  ```json
  { "path": "uploads/report.xlsx", "size": 45678, "filename": "report.xlsx" }
  ```

### 15. 终端 Terminal (`/api/v1/terminal`)

> 基于 `node-pty` 的服务器端 PTY 终端，工作目录物理锁定在会话工作空间内，通过 WebSocket 与前端 `xterm.js` 双向通信。

- `POST /api/v1/terminal/create`: 创建 PTY 会话，返回 `terminalId` 和实际 `cwd`

  **请求体：**
  ```json
  { "sessionId": "my-session", "cwd": "optional/subdir", "cols": 120, "rows": 30 }
  ```
  **返回：** `{ "terminalId": "uuid", "cwd": "/abs/path/to/workspace" }`

- `WS /api/v1/terminal/ws/:id`: WebSocket 双向桥接，将 PTY 输入输出与 xterm.js 互联

  **客户端 → 服务器消息类型：**

  | type | 字段 | 说明 |
  |------|------|------|
  | `input` | `data: string` | 按键 / stdin 字符串 |
  | `resize` | `cols, rows` | 终端尺寸调整 |
  | `kill` | — | 终止 PTY 进程 |

  **服务器 → 客户端消息类型：**

  | type | 字段 | 说明 |
  |------|------|------|
  | `output` | `data: string` | PTY stdout/stderr 输出 |
  | `exit` | `code: number` | 进程已退出 |
  | `error` | `message: string` | 会话不存在 |

- `DELETE /api/v1/terminal/:id`: 手动终止并销毁指定 PTY 会话

### 10. 模型管理 Models (`/api/v1/models`)
- `GET /api/v1/models/whitelist`: 获取模型白名单列表（包含思考模式配置）
- `GET /api/v1/models`: 获取当前租户已配置的模型列表（API Key 脱敏显示）
- `POST /api/v1/models`: 添加新的模型配置（需要 admin 角色）

  **请求体：**
  ```json
  {
    "provider": "openai",
    "modelId": "gpt-4o",
    "apiKey": "sk-xxxxxxxxxxxxxxxx",
    "baseUrl": "https://api.openai.com/v1",
    "displayName": "GPT-4o",
    "version": "2024-08-06"
  }
  ```

- `PUT /api/v1/models/:id`: 更新指定模型配置（需要 admin 角色）
- `DELETE /api/v1/models/:id`: 删除指定模型配置（需要 admin 角色）
- `POST /api/v1/models/:id/test`: 测试模型连接（支持传入临时参数测试未保存的配置）

### 10a. DeepSeek 动态定价 (`/api/deepseek/prices`)

> 管理 DeepSeek 模型价格配置，支持折扣期自动切换。定价数据持久化于 `~/.agent-engine/deepseek-prices.json`，可通过 API 动态更新。

- `GET /api/deepseek/prices`: 获取当前价格配置（含所有模型的原价、折扣价、折扣截止时间）
- `PUT /api/deepseek/prices`: 更新价格配置（全量覆盖，自动计算 `updatedAt`）

**GET 返回示例：**

```json
{
  "code": 200,
  "data": {
    "lowBalanceThreshold": 10,
    "updatedAt": "2026-05-20T00:00:00+08:00",
    "models": [
      {
        "modelId": "deepseek-v4-flash",
        "normalPrice": { "input": 1, "output": 2, "cacheHit": 0.02 },
        "discountPrice": { "input": 1, "output": 2, "cacheHit": 0.02 },
        "discountUntil": null
      },
      {
        "modelId": "deepseek-v4-pro",
        "normalPrice": { "input": 12, "output": 24, "cacheHit": 0.1 },
        "discountPrice": { "input": 3, "output": 6, "cacheHit": 0.025 },
        "discountUntil": "2026-05-31T23:59:00+08:00"
      }
    ]
  }
}
```

> 单位：元人民币 / 百万 tokens。`discountUntil` 为 `null` 时表示无折扣或永久折扣。

### 11. 系统设置 Settings (`/api/v1/settings`)

> **存储机制变更**：`PUT /api/v1/settings` 不再写入 `.env` 文件，所有运行时配置均存储在 SQLite `system_config` 表（key-value UPSERT）。敏感字段（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`）使用 AES-256-GCM 加密存储。服务启动时会自动将数据库配置同步到 `process.env`，所有模块无需感知变化。`.env` 文件仅保留启动前必须确定的引导参数（`PORT`、`HOST`、`DATA_DIR`、`ENCRYPTION_KEY`、`AUTH_ENABLED`、`LOG_LEVEL`）。

- `GET /api/v1/settings`: 获取当前系统运行时配置（从数据库读取，fallback 到 `process.env`，含 `webFetch` 安全配置）

  **返回字段说明：**

  | 字段 | 类型 | 分类 | 说明 |
  |------|------|------|------|
  | `LLM_PROVIDER` | string | LLM | 当前 LLM 提供商 (`openai` / `anthropic` / `deepseek` / `ollama` / `qwen` / `custom`，未知值自动降级为 OpenAI 兼容接口） |
  | `LLM_PRIMARY_MODEL` | string | LLM | 主模型名称 |
  | `OPENAI_API_KEY` | string | LLM | OpenAI 兼容 API Key（已加密存储，返回明文） |
  | `OPENAI_BASE_URL` | string | LLM | OpenAI 兼容 Base URL |
  | `ANTHROPIC_API_KEY` | string | LLM | Anthropic API Key（已加密存储，返回明文） |
  | `ANTHROPIC_BASE_URL` | string | LLM | Anthropic 自定义 Base URL（代理/私有部署时使用） |
  | `OLLAMA_BASE_URL` | string | LLM | Ollama 服务地址 |
  | `MAX_ITERATIONS` | number | Agent | ReAct 循环最大迭代次数 |
  | `TOKEN_BUDGET` | number | Agent | Agent 上下文窗口 Token 预算 |
  | `HISTORY_MAX_TOKENS` | number | Agent | 历史消息最大 Token 窗口（超出则丢弃旧消息） |
  | `TOOL_OUTPUT_MAX_CHARS` | number | Agent | 工具输出最大字符数（超出则头尾截断） |
  | `COMPRESS_THRESHOLD_RATIO` | number | Agent | 压缩触发阈值（占 `TOKEN_BUDGET` 的比例） |
  | `SUPERPOWER_MODE` | string | Agent | 增强模式档位：`off` / `balanced` / `methodology` / `max`（从 `process.env` 实时读取） |
  | `SUPERPOWER_ENABLED` | boolean | Agent | ⚠️ 已废弃：旧版布尔开关（`true`→Methodology，`false`→Off）；下个 minor 移除 |
  | `SKILLS_ROOT` | string | Skills | 自定义技能目录路径 |
  | `BASH_PATH` | string | Skills | Bash 可执行文件路径（Windows 需配置） |
  | `CMD_TIMEOUT_MS` | number | Tools | Shell 命令执行超时时间（毫秒） |
  | `MAX_FILE_SIZE_BYTES` | number | Tools | 文件读取工具最大文件大小（字节） |
  | `WEB_SEARCH_SERVER` | string | Tools | Web 搜索后端服务地址 |
  | `WORKSPACE_ROOT` | string | Workspace | 工作区根目录路径 |
  | `MCP_CONFIG_PATH` | string | Workspace | MCP 服务器配置文件路径 |
  | `QA_LOG_ENABLED` | boolean | Observability | 是否启用 Q&A 审计日志 |
  | `QA_LOG_DIR` | string | Observability | Q&A 审计日志输出目录 |
  | `webFetch` | object | Security | Web 获取工具安全策略（见下方说明） |

- `PUT /api/v1/settings`: 更新系统运行时配置（写入 SQLite `system_config` 表，并同步到 `process.env` 立即生效）

  **Superpower 模式更新：**

  使用 `SUPERPOWER_MODE` 字段设置增强档位，可选值为 `off` / `balanced` / `methodology` / `max`。⚠️ **不可同时传入 `SUPERPOWER_MODE` 和 `SUPERPOWER_ENABLED`**（旧版字段），同时写入会返回 `400` 错误。推荐仅使用 `SUPERPOWER_MODE`，旧版 `SUPERPOWER_ENABLED` 将在下个 minor 版本移除。

  ```json
  { "SUPERPOWER_MODE": "methodology" }
  ```

  **webFetch 安全配置说明**（仍存储于 `config/security.json` 文件，因结构较复杂不适合 KV 存储）

  通过 `webFetch` 字段可配置 Web 获取工具的安全策略：

  ```json
  {
    "settings": {
      "webFetch": {
        "enabled": true,
        "allowedDomains": ["example.com", "*.trusted.org"],
        "blockedDomains": ["malicious.com"]
      }
    }
  }
  ```

### 12. 监控与健康 Metrics (`/health`, `/metrics`)
- `GET /health`: 存活探针检查
- `GET /metrics`: 获取 Prometheus 格式的监控指标

### 13. 待办任务 Todos (`/api/v1/todos`)
- `POST /api/v1/todos`: 创建新的待办任务

  **请求体：**
  ```json
  {
    "title": "Review PR #42",
    "description": "可选描述",
    "priority": "high",
    "dueAt": "2026-05-01T18:00:00",
    "sessionId": "my-session"
  }
  ```

- `GET /api/v1/todos?sessionId=&status=&current=&pageSize=`: 获取待办列表，支持按 sessionId、status 过滤和分页
- `PUT /api/v1/todos/:id`: 更新待办任务（title、description、priority、status、dueAt 均可选）
- `DELETE /api/v1/todos/:id`: 删除待办任务

  **枚举值**
  - `status`: `pending` · `in_progress` · `done` · `cancelled`
  - `priority`: `low` · `medium` · `high`

### 14. 定时任务 Cron (`/api/v1/cron`)
- `POST /api/v1/cron`: 创建定时任务

  **请求体：**
  ```json
  {
    "name": "每日日报",
    "cronExpr": "0 9 * * 1-5",
    "message": "请总结昨日工作进展，列出今日计划",
    "sessionId": "my-session",
    "agentId": "可选",
    "description": "工作日每天9点提醒",
    "enabled": true
  }
  ```

- `GET /api/v1/cron?current=&pageSize=`: 获取定时任务列表（支持分页）
- `PUT /api/v1/cron/:id`: 更新定时任务（name、cronExpr、message、description、enabled 均可选）
- `DELETE /api/v1/cron/:id`: 删除定时任务
- `POST /api/v1/cron/:id/enable`: 启用定时任务
- `POST /api/v1/cron/:id/disable`: 禁用定时任务

  > `CronScheduler` 每分钟整点轮询，匹配到表达式后通过 loopback HTTP `POST /api/v1/chat` 触发完整 ReAct 循环，并更新 `lastRunAt` 字段。

### 16. 安全策略 Security (`/api/v1/security`)

> 三层纵深防御：命令注入检测（policy-engine）+ SSRF 防护（network-policy）+ 审计日志（audit-log）。
> 支持三种安全模式会话级切换：`safe`（安全）、`standard`（标准）、`full-access`（完全访问）。

- `GET /api/v1/security/mode?sessionId=xxx`: 获取当前会话安全模式

  **返回：**
  ```json
  { "code": 200, "data": { "sessionId": "abc", "mode": "safe" } }
  ```

- `PUT /api/v1/security/mode`: 切换会话安全模式

  **请求体：**
  ```json
  { "sessionId": "abc", "mode": "standard" }
  ```

  **模式说明：**
  | 模式 | 行为 |
  |------|------|
  | `safe` | 默认。白名单 + 完整策略检查，高危命令需确认 |
  | `standard` | 仅 deny 规则拦截，ask 规则自动放行，跳过白名单 |
  | `full-access` | 跳过所有检查，命令/网络直接放行。审计日志仍记录 |

- `GET /api/v1/security/policies`: 获取所有命令安全策略列表

  **返回字段：** `id`, `name`, `pattern`（正则），`description`, `enabled`, `createdAt`

- `POST /api/v1/security/policies`: 创建新的命令安全策略

  **请求体：**
  ```json
  {
    "name": "禁止删除根目录",
    "pattern": "rm\\s+-rf\\s+/",
    "description": "防止误删根目录",
    "enabled": true
  }
  ```

- `PUT /api/v1/security/policies/:id`: 更新策略（name、pattern、description、enabled 均可选）
- `DELETE /api/v1/security/policies/:id`: 删除指定策略

- `GET /api/v1/security/network-policy`: 获取当前 SSRF 网络策略配置

  **返回字段：**
  ```json
  {
    "enabled": true,
    "blockPrivateIPs": true,
    "whitelist": ["example.com"],
    "blacklist": ["malicious.io"]
  }
  ```

- `PUT /api/v1/security/network-policy`: 更新 SSRF 网络策略

- `GET /api/v1/security/audit-log`: 查询审计日志

  **查询参数：** `limit`（默认100）, `offset`, `tenantId`, `toolName`, `blocked`（true/false）

  **返回字段：** `id`, `tenantId`, `sessionId`, `toolName`, `args`, `result`, `blocked`, `reason`, `createdAt`

### 17. LSP 诊断 LSP (`/api/v1/lsp`)

> 让 AI 具备代码自检能力：运行 TypeScript 编译器 + ESLint，结果按文件内容哈希缓存，避免重复分析。

- `GET /api/v1/lsp/diagnostics`: 获取 LSP 诊断配置（启用状态、支持的语言）
- `PUT /api/v1/lsp/diagnostics`: 更新 LSP 诊断配置

  **请求体：**
  ```json
  {
    "enabled": true,
    "languages": ["typescript", "javascript"]
  }
  ```

- `POST /api/v1/lsp/diagnostics/run`: 对工作区指定文件执行诊断

  **请求体：** `{ "sessionId": "xxx", "path": "src/index.ts" }`

  **返回：**
  ```json
  {
    "file": "src/index.ts",
    "diagnostics": [
      {
        "severity": "error",
        "message": "Type 'string' is not assignable to type 'number'",
        "line": 42,
        "column": 5,
        "source": "typescript"
      }
    ]
  }
  ```

### 18. 性能统计 Performance (`/api/v1/performance`)

- `GET /api/v1/performance/stats`: 获取 SQLite 运行时 pragma 配置与统计

  **返回字段：**

  | 字段 | 说明 |
  |------|------|
  | `journal_mode` | 当前日志模式（应为 `wal`） |
  | `synchronous` | 同步策略（`1` = NORMAL） |
  | `cache_size` | 页缓存大小（负数为 KB） |
  | `temp_store` | 临时存储位置（`2` = MEMORY） |
  | `mmap_size` | 内存映射大小（字节） |
  | `busy_timeout` | 写锁等待超时（毫秒） |
  | `foreign_keys` | 外键约束开关 |

---

## Chat 接口详细说明

### POST `/api/v1/chat` — 发送消息（SSE 流式响应）

> **Agent 绑定机制：** 会话首次发送消息时，请求体中的 `agentId` 会被自动写入 `sessions` 表，永久锁定该会话使用的 Agent。后续同一 `sessionId` 的请求无论传入什么 `agentId` 均会被忽略，始终使用绑定值。
>
> - 绑定**不会**因清空对话历史（`DELETE /api/v1/conversation/history`）而解除
> - 绑定**仅在**硬删除整个会话（`DELETE /api/v1/sessions/:sessionId`）时随会话一起删除
> - 如需更换 Agent，请新建一个会话
> - `GET /api/v1/sessions/:sessionId/binding` — 查询绑定状态（`started: false` 未锁定 / `started: true` 已锁定，返回 `agentId` 和 `agent` 信息）

**请求体：**
```json
{
  "message": "你好，请自我介绍一下",
  "sessionId": "可选，不传则自动生成",
  "agentId": "可选，指定使用的 Agent",
  "systemPrompt": "可选，自定义系统提示词",
  "maxAskUserCount": 5,
  "includeStreamUsage": false,
  "thinkingMode": false,
  "toolResponse": {
    "toolCallId": "工具调用 ID",
    "name": "工具名称",
    "output": "用户选择/输入的内容"
  }
}
```

**SSE 事件类型：**

| 事件字段 | 类型 | 说明 |
|---------|------|------|
| `{ "content": "..." }` | text_delta | 普通文本内容块 |
| `{ "thinking": "..." }` | thinking | 模型思考过程（DeepSeek R1 / Claude 3.7 Sonnet） |
| `{ "toolStart": { "name": "...", "args": {...}, "toolCallId": "..." } }` | tool_start | 工具调用开始（旧版命名） |
| `{ "toolEnd": { "name": "...", "toolCallId": "...", "success": true, "outputPreview": "..." } }` | tool_end | 工具调用结束（旧版命名） |
| `{ "toolCall": { "toolName": "...", "args": {...}, "toolCallId": "...", "messageId": "..." } }` | tool_call | 工具调用开始（新版命名） |
| `{ "toolResult": { "toolName": "...", "toolCallId": "...", "success": true, "output": "...", "durationMs": 12 } }` | tool_result | 工具调用结束（新版命名，含完整 output） |
| `{ "toolArg": { "toolCallId": "...", "toolName": "...", "argsDelta": { "key": "value" } } }` | tool_arg | ⭐ 工具参数流式增量（流中逐 delta 输出，前端可实时渲染参数填写动画） |
| `{ "usage": { "systemPromptTokens": ..., "ragTokens": ..., "skillTokens": ..., "builtinToolsTokens": ..., "mcpToolsTokens": ..., "messagesTokens": ..., "toolResultsTokens": ..., "completionTokens": ..., "promptTokens": ..., "totalTokens": ..., "systemToolsTokens": ..., "cacheHitTokens": ..., "cacheMissTokens": ..., "reasoningTokens": ..., "model": "deepseek-chat" } }` | usage | Token 使用量统计（8 类精细分项 + 汇总 + DeepSeek 专有指标 + model ID） |
| `{ "ask_user": { "question": "...", "options": [...], "toolCallId": "..." } }` | ask_user | 向用户提问卡片（旧版命名） |
| `{ "permissionRequest": { "requestId": "...", "toolName": "ask_user", "args": {...}, "sessionId": "...", "messageId": "...", "description": "..." } }` | permission_request | 权限/交互请求（新版命名，含 sessionId/requestId） |
| `{ "userMsgId": "..." }` | user_msg_id | 用户消息已落库的后端 ID（首帧；同时支持 `__user_msg_id__` 与 `__userMsgId__` 两个后端别名） |
| `{ "messageBlock": { "messageId": "...", "role": "assistant", "content": "..." } }` | message_block | 单条消息边界标记（可选；用于流中持久化锚点） |
| `[DONE]` | done | 流式响应结束 |

> **协议版本说明**：旧版字段（`toolStart` / `toolEnd` / `ask_user`）与新版字段（`toolCall` / `toolResult` / `permissionRequest`）会**同时**发送。前端可任选其一消费，二者携带的 `toolCallId` 相同，可去重。新版 envelope 命名遵循 camelCase，并补充 `sessionId` / `messageId` / `durationMs` 等元数据。

---

## 前端 UI 说明

### 分屏布局（Split Layout）

`multi-agent-console` 主区域（`MainArea` 组件）支持三种显示模式，可在顶部工具栏一键切换：

| 模式 | 说明 |
|------|------|
| `chat-only` | 仅显示聊天区域（默认） |
| `horizontal` | 上下分割：文件管理器/编辑器（上）+ 聊天（下） |
| `vertical` | 左右分割：文件管理器/编辑器（左）+ 聊天（右，最小宽度 420 px） |

- 分隔线可用鼠标拖拽，比例范围 15 %–85 %
- 当前模式和分割比例自动持久化到 `localStorage`（key：`ui.splitMode` / `ui.splitRatio`），刷新页面后恢复
- 拖拽期间自动覆盖透明遮罩，防止 iframe/iframe 内容捕获鼠标事件

### macOS Sonoma 设计 Token（`macos-sonoma-tokens.css`）

项目根目录提供符合 Apple HIG 规范的 CSS 自定义属性集，可供 Web / Electron 应用复用：

| 分类 | 前缀 | 说明 |
|------|------|------|
| 材质 — 标题栏 | `--macos-titlebar-*` | 半透明毛玻璃效果，含失焦变体 |
| 材质 — 侧边栏 | `--macos-sidebar-*` | 轻量级半透明，含宽度预设 |
| 材质 — 内容区 | `--macos-content-*` | 纯色背景，含 elevated / sunken 层次 |
| 排版 | `--macos-font-*` | SF Pro 字体栈，含各层级字号、字重 |
| 系统颜色 | `--macos-label-*` / `--macos-text-*` | 主/次/三/四级文字颜色 |
| 强调色 | `--macos-accent-*` | 蓝色强调（含 hover / pressed / subtle 变体） |
| 语义色 | `--macos-color-*` | 红/绿/橙/紫/粉/青/灰及其柔和背景 |
| 填充色 | `--macos-fill-*` | 控件背景三级填充 |
| 间距 | `--macos-space-*` / `--macos-padding-*` | 4 px 基准格栅 |
| 阴影 | `--macos-shadow-*` | 窗口/菜单/卡片/内阴影/Sheet 五级 |
| 圆角 | `--macos-radius-*` | 窗口/面板/卡片/控件/按钮/标签/全圆 |
| 交通灯按钮 | `--macos-traffic-light-*` | 尺寸、间距及红/黄/绿颜色含 hover 态 |
| 交互状态 | `--macos-list-row-*` / `--macos-icon-*` | 列表行悬停/选中/非聚焦三态 |
| 控件 | `--macos-input-*` / `--macos-btn-*` | 输入框、主/次按钮样式 |
| 动画 | `--macos-transition-*` | fast(80ms) / base(150ms) / slow(250ms) / spring |

深色模式通过 `@media (prefers-color-scheme: dark)` 自动覆盖所有 Token，无需额外 class。

工具类（可选）：`.mac-titlebar`、`.mac-sidebar`、`.mac-content`、`.mac-window`、`.mac-sidebar-label`、`.mac-list-row`、`.mac-traffic-lights`。

---

## DeepSeek 专有通道接口 (`/api/v1/deepseek`)

> 仅在配置了 DeepSeek API Key（`DEEPSEEK_API_KEY` 或 `OPENAI_API_KEY`）时可用。所有接口复用已配置的密钥，不需要前端额外传递。

### 19. DeepSeek 通道 (`/api/v1/deepseek`)

- `GET /api/v1/deepseek/status`: 通道探针，返回当前 DeepSeek 通道状态

  **返回示例：**
  ```json
  {
    "enabled": true,
    "hasApiKey": true,
    "baseUrl": "https://api.deepseek.com",
    "currentModel": "deepseek-chat",
    "isReasoner": false,
    "features": {
      "kvCache": "enabled",
      "thinkingMode": "auto",
      "fim": "beta"
    }
  }
  ```

- `POST /api/v1/deepseek/fim`: Fill-in-Middle 代码补全（Beta）

  **请求体：**
  ```json
  {
    "prompt": "def hello(",
    "suffix": "\n    print(msg)",
    "maxTokens": 128,
    "model": "deepseek-chat"
  }
  ```
  **返回：** `{ "content": "msg: str):", "promptTokens": 12, "completionTokens": 5 }`

- `POST /api/v1/deepseek/json`: 强制 JSON Mode 调用

  **请求体：** `{ "prompt": "提取以下文本中的日期", "systemPrompt": "可选", "model": "deepseek-chat" }`

- `POST /api/v1/deepseek/prefix`: Chat Prefix Completion 续写

  **请求体：** `{ "prompt": "生成一份会议纪要", "prefix": "# 会议纪要\n\n## 时间：", "model": "deepseek-chat" }`

- `GET /api/v1/deepseek/prices`: 读取当前有效价格配置

  **返回示例（含折扣状态）：**
  ```json
  {
    "models": [
      {
        "modelId": "deepseek-chat",
        "normalPrice": { "input": 2, "output": 8, "cacheHit": 0.5 },
        "discountPrice": { "input": 1, "output": 4, "cacheHit": 0.1 },
        "discountUntil": "2026-05-31T23:59:59+08:00",
        "effectivePrice": { "input": 1, "output": 4, "cacheHit": 0.1, "isDiscounted": true }
      }
    ],
    "lowBalanceThreshold": 10,
    "updatedAt": "2026-05-07T00:00:00.000Z"
  }
  ```

- `PUT /api/v1/deepseek/prices`: 持久化价格配置（写入 `~/.agent-engine/deepseek-prices.json`）

  **请求体：** 与上方 GET 返回格式相同的 JSON 对象

- `GET /api/v1/deepseek/balance`: 代理查询 DeepSeek 账户余额

  **返回示例：**
  ```json
  {
    "balance": 67.48,
    "currency": "CNY",
    "isAvailable": true,
    "lowBalance": false,
    "lowBalanceThreshold": 10,
    "updatedAt": "2026-05-07T07:21:22.000Z"
  }
  ```
  > Key 读取优先级：`DEEPSEEK_API_KEY` → `OPENAI_API_KEY`；未配置时返回错误码 `40003`

- `GET /api/v1/deepseek/models`: 动态拉取可用模型列表（5 分钟内存缓存）

  **返回示例：**
  ```json
  { "models": ["deepseek-chat", "deepseek-reasoner"], "fallback": false, "cached": true }
  ```
  > 拉取失败时 `fallback: true`，返回内置列表 `["deepseek-chat", "deepseek-reasoner"]`

---

## DeepSeek Token 指标说明

使用 DeepSeek 模型时，`usage` 事件中会额外携带以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `cacheHitTokens` | number? | KV Cache 命中的 token 数，按 0.1元/百万计费（折扣期）|
| `cacheMissTokens` | number? | KV Cache 未命中的 token 数，按正常输入价计费 |
| `reasoningTokens` | number? | R1/V3 thinking 模式下 `reasoning_content` 消耗的 token 数 |

**KV Cache 节省估算（UI 显示）：**
```
节省金额（元）= cacheHitTokens × (原价缓存命中 − 折扣价缓存命中) / 1_000_000
```
例：命中 42 万 token，原价 0.5元/M，折扣价 0.1元/M → 节省 ¥0.168

> 所有三个字段仅在 DeepSeek 模型下存在（值为 `undefined` 时不携带），不影响其他 Provider。
> 多轮工具调用时这三个值会跨轮次累加，反映整次对话的总计值。



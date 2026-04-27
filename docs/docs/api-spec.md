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

### 2. 会话与历史 Conversation (`/api/v1/conversation`)
- `GET /api/v1/conversation/sessions`: 获取有对话的会话列表 (支持分页)
- `GET /api/v1/conversation/history?sessionId=xxx`: 查询指定会话的所有历史消息 (支持分页)
- `DELETE /api/v1/conversation/history?sessionId=xxx`: 清空指定会话的历史消息记录
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
- `POST /api/v1/memory/remember`: 保存新的键值对记忆条目
- `GET /api/v1/memory/recall?sessionId=xxx`: 根据 Key 回忆/读取记忆
- `GET /api/v1/memory/list`: 获取所有的记忆 Key 列表 (支持可选参数 `?sessionId=xxx` 和分页)
- `DELETE /api/v1/memory/:id`: 删除指定的记忆条目

### 7. 任务调度 Tasks (`/api/v1/tasks`)
- `POST /api/v1/tasks`: 创建新的异步任务或工作流
- `GET /api/v1/tasks`: 获取系统内的任务列表 (支持分页)
- `GET /api/v1/tasks/:id`: 根据任务 ID 查询任务当前状态与详情
- `PUT /api/v1/tasks/:id`: 更新任务状态或参数
- `DELETE /api/v1/tasks/:id`: 删除/取消任务

### 8. 工具与插件 Tools (`/api/v1/tools`)
- `GET /api/v1/tools`: 获取当前系统加载的所有可用工具和技能列表 (支持分页)

### 9. 工作区 Workspace (`/api/v1/workspace`)
- `GET /api/v1/workspace/files`: 获取工作区文件和目录树结构 (支持可选参数 `?sessionId=xxx`)
- `GET /api/v1/workspace/recent`: 获取最近使用的工作区列表 (包含名称、路径和是否活跃状态)
- `GET /api/v1/workspace/file/content`: 获取工作区文件内容 (需参数 `?sessionId=xxx&path=yyy`)
- `GET /api/v1/workspace/image`: 获取工作区图片并以 data URL 格式返回，供前端预览 (需参数 `?sessionId=xxx&path=yyy`)
- `POST /api/v1/workspace/file`: 上传文件到指定 session 的工作区 (multipart/form-data，支持最大 100MB，字段名 `file` + `sessionId`)
- `DELETE /api/v1/workspace/recent/:sessionId`: 物理删除指定的工作区目录
- `POST /api/v1/workspace/rename`: 重命名工作区目录及关联的 `sessionId` (自动更新对话记录和记忆中的关联)

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

### 11. 系统设置 Settings (`/api/v1/settings`)
- `GET /api/v1/settings`: 获取当前系统环境变量配置
- `PUT /api/v1/settings`: 更新系统环境变量配置（写入 `.env` 文件）

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

---

## Chat 接口详细说明

### POST `/api/v1/chat` — 发送消息（SSE 流式响应）

**请求体：**
```json
{
  "message": "你好，请自我介绍一下",
  "sessionId": "可选，不传则自动生成",
  "agentId": "可选，指定使用的 Agent",
  "systemPrompt": "可选，自定义系统提示词",
  "maxAskUserCount": 5,
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
| `{ "toolStart": { "name": "...", "args": {...}, "toolCallId": "..." } }` | tool_start | 工具调用开始 |
| `{ "toolEnd": { "name": "...", "toolCallId": "...", "success": true, "outputPreview": "..." } }` | tool_end | 工具调用结束 |
| `{ "usage": { "systemPromptTokens": ..., "completionTokens": ..., "totalTokens": ... } }` | usage | Token 使用量统计 |
| `{ "ask_user": { "question": "...", "options": [...], "toolCallId": "..." } }` | ask_user | 向用户提问卡片 |
| `[DONE]` | done | 流式响应结束 |

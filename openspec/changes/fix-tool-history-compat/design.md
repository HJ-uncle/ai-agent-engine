## Context

AI Agent Engine 支持多个 LLM 后端（OpenAI/Qwen 兼容、Anthropic Claude、本地模型）。对话历史通过 SQLite 的 `conversations` 表持久化，但 `assistant` 消息中 `toolCall.name` 字段未被存储。

当切换模型（如从 Qwen 切换到 Claude）时，历史回放器尝试重建 Anthropic 格式的 `tool_use` 消息块，因 `name` 字段缺失导致 Claude API 返回 400 错误。

受影响模块：
- `src/storage/conversation/history.ts` — 读写历史
- `src/storage/sqlite/migrations/001_initial.ts` — 表结构
- `src/storage/sqlite/db.ts` — DB 初始化
- `src/core/llm-adapter/anthropic.ts` — Anthropic 格式转换
- `src/core/llm-adapter/openai.ts` — OpenAI 格式转换

## Goals / Non-Goals

**Goals:**
- 修复 `assistant` 消息的 `toolCall.name` 丢失问题
- 兼容已有数据库（无需用户手动操作）
- Anthropic / OpenAI 适配器对残缺历史消息均有防御性处理
- 修复后 Qwen XML 解析生成的工具调用 ID 也能被 Claude 安全回放

**Non-Goals:**
- 不修改对外 API 接口
- 不迁移历史数据中已丢失的 `name`（历史数据仍以 `''` 填充，但有防御兜底）
- 不引入新的外部依赖

## Decisions

### 决策 1：新增 `tool_call_name` 列而非复用 `tool_name`

`tool_name` 列语义是工具执行结果（`role=tool`）的工具名称，用于显示。
`tool_call_name` 专指 `role=assistant` 消息中发起调用的工具名称，用于历史重建。
两者共存，职责清晰，不破坏现有查询。

备选：复用 `tool_name` 列 → 被否，会破坏现有 tool result 消息的语义。

### 决策 2：运行时 ALTER TABLE，不创建新 migration 版本

项目当前无 migration 版本追踪机制（只有 `001_initial.ts`）。
采用启动时幂等 `ALTER TABLE IF NOT EXISTS` 方式补列，对已有 DB 无侵入，失败静默跳过。

```sql
-- 启动时执行（幂等）
ALTER TABLE conversations ADD COLUMN tool_call_name TEXT;
```

备选：新建 `002_add_tool_call_name.ts` → 被否，无版本追踪时重复执行会报错。

### 决策 3：Anthropic 适配器过滤非法 tool_use 块

当 `msg.toolCall.id` 为空或 `msg.toolCall.name` 为空时：
- 不生成 `tool_use` 块（跳过该 assistant 消息中的工具调用）
- 仍保留 `text` 内容（如有）
- 配套的 `tool_result` 也跳过（无 `tool_use` 就无 `tool_result`）

备选：生成 `id: uuid()` 占位 → 被否，Claude 会因找不到对应 `tool_result` 而报错。

### 决策 4：OpenAI 适配器对空 tool_call_id 生成占位

```typescript
id: msg.toolCall.id || `call_${Date.now()}`
```
OpenAI 兼容端点对 `id` 格式要求宽松，占位 ID 不影响功能。

## Risks / Trade-offs

- **已有历史数据中的 tool_call_name 为空** → Anthropic 适配器过滤这些块，历史中的工具调用上下文丢失，但不崩溃。这是已有数据不可挽回的代价，新数据不受影响。
- **ALTER TABLE 在高并发启动时** → libsql 单文件 SQLite 在并发场景下本身有写锁，风险极低。

## Migration Plan

1. 部署新代码，服务启动时自动执行 `ALTER TABLE`
2. 新写入的历史消息自动带 `tool_call_name`
3. 已有历史消息在 Anthropic 模式下 tool_use 块被过滤，不报错
4. 回滚：删除新列即可（`ALTER TABLE DROP COLUMN tool_call_name`，SQLite 3.35+）

## Open Questions

- 是否需要对已有历史数据做一次性补数据（从 `tool_name` 中尝试恢复）？目前决定不做，因为 `tool_name` 语义不同，可能误填。

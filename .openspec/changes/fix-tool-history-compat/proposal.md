## Why

当前对话历史存储未能完整保留 `assistant` 消息中 `tool_call` 的 `name` 字段。当切换到 Anthropic Claude 模型时，重建历史消息需要 `tool_use.id` 和 `tool_use.name` 同时存在（Claude API 强制校验），导致 `400: messages.1.content.0.tool_use.id: Field required` 错误，多模型切换场景完全不可用。

## What Changes

- **新增 `tool_call_name` 列**：在 `conversations` 表中为 `assistant` 消息存储 `toolCall.name`
- **修复 `rowToMessage`**：从新列正确恢复 `toolCall.name`，不再返回 `undefined`
- **修复 `append`**：写入时保存 `message.toolCall.name`
- **运行时 ALTER TABLE**：启动时检测并补列，兼容已有数据库（无需重建 DB）
- **修复 Anthropic 适配器**：`messageToAnthropic` 对 `id`/`name` 缺失做防御，过滤无效 `tool_use` 块
- **修复 OpenAI 适配器**：`tool_call_id` 空值生成合法占位 ID

## Capabilities

### New Capabilities
- `tool-call-history-compat`: 跨 LLM 适配器的工具调用历史兼容性——历史消息在 OpenAI / Anthropic / Qwen 间安全回放

### Modified Capabilities
（无 spec 层需求变更，均为实现层 bug 修复）

## Impact

- `src/storage/sqlite/migrations/001_initial.ts` — 新增列定义
- `src/storage/sqlite/db.ts` — 启动时 ALTER TABLE 补列
- `src/storage/conversation/history.ts` — append + rowToMessage 修复
- `src/core/llm-adapter/anthropic.ts` — 防御性校验
- `src/core/llm-adapter/openai.ts` — 空值兜底
- 无 API 接口变更，无破坏性改动

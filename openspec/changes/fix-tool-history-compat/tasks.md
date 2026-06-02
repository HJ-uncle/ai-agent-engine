## 1. 数据库 Schema 修复

- [x] 1.1 在 `src/storage/sqlite/migrations/001_initial.ts` 的 `up()` 中为 `conversations` 表添加 `tool_call_name TEXT` 列定义
- [x] 1.2 在 `src/storage/sqlite/db.ts`（或启动初始化逻辑）中添加幂等的运行时 `ALTER TABLE conversations ADD COLUMN tool_call_name TEXT` 语句，用 `try/catch` 静默跳过已存在的情况

## 2. 历史读写修复

- [x] 2.1 修改 `src/storage/conversation/history.ts` 的 `append()` 方法：在 SQL `INSERT` 语句中新增 `tool_call_name` 列，写入 `message.toolCall?.name ?? null`
- [x] 2.2 修改 `src/storage/conversation/history.ts` 的 `rowToMessage()` 函数：从 `tool_call_name` 列读取值，赋给 `msg.toolCall.name`（目前 `toolCall.name` 未被赋值）
- [x] 2.3 更新 `getHistory` 中的 SELECT 语句：添加 `tool_call_name` 到 SELECT 字段列表

## 3. Anthropic 适配器防御

- [x] 3.1 修改 `src/core/llm-adapter/anthropic.ts` 的 `messageToAnthropic()` 函数：当 `msg.toolCall.id` 为空或 `msg.toolCall.name` 为空时，跳过 `tool_use` 块的生成，只保留 `text` 块
- [x] 3.2 在 `anthropic.ts` 中实现 `tool_result` 过滤逻辑：构建 valid `tool_use` ID 集合，对于 `role=tool` 消息，若 `toolCallId` 不在集合中则整条消息跳过（不发往 Claude）
- [x] 3.3 在 `anthropic.ts` 的 `complete()` 中确保过滤后的消息数组仍然满足 Anthropic 的轮次交替规则（user/assistant 交替），合并相邻同角色消息

## 4. OpenAI 适配器兜底

- [x] 4.1 修改 `src/core/llm-adapter/openai.ts` 的 `messageToOpenAI()` 函数：当 `msg.toolCall.id` 为空时，使用 `call_${Date.now()}_${Math.random().toString(36).slice(2)}` 作为占位 ID

## 5. 验证

- [ ] 5.1 手动测试：使用 Claude 模型（`claude-sonnet-4-6`）发送对话，确认含工具调用历史的 session 不再报 400
- [ ] 5.2 手动测试：确认 Qwen → Claude 跨模型切换同一 sessionId 时不崩溃
- [ ] 5.3 手动测试：新写入的工具调用消息再次以 Claude 读取，`tool_call_name` 正确恢复

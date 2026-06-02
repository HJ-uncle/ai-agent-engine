## ADDED Requirements

### Requirement: tool_call_name 持久化
`assistant` 消息中的工具调用名称（`toolCall.name`）SHALL 被持久化到 `conversations` 表的 `tool_call_name` 列，并在历史回放时完整恢复。

#### Scenario: 新写入 assistant tool_call 消息
- **WHEN** `history.append()` 接收 `role=assistant` 且 `message.toolCall` 非空
- **THEN** `tool_call_name` 列写入 `message.toolCall.name` 的值

#### Scenario: 从 DB 读取 assistant tool_call 消息
- **WHEN** `rowToMessage()` 处理含 `tool_args` 的 assistant 行
- **THEN** 返回的 `Message.toolCall.name` 等于 `tool_call_name` 列的值（不为 `undefined`）

### Requirement: 已有数据库自动补列
系统 SHALL 在启动时检测 `conversations` 表是否缺少 `tool_call_name` 列，若缺少则自动执行 `ALTER TABLE ADD COLUMN`，无需人工干预。

#### Scenario: 首次以新代码启动旧数据库
- **WHEN** 服务启动且 `conversations` 表不含 `tool_call_name` 列
- **THEN** 自动添加该列，服务正常启动，不抛出异常

#### Scenario: 已含新列的数据库启动
- **WHEN** 服务启动且 `conversations` 表已含 `tool_call_name` 列
- **THEN** ALTER TABLE 被静默跳过，服务正常启动

### Requirement: Anthropic 适配器对残缺 tool_use 的防御
当历史消息中 `toolCall.id` 或 `toolCall.name` 为空时，Anthropic 适配器 SHALL 跳过生成该 `tool_use` 块，不发出 Claude API 无法接受的非法消息。

#### Scenario: toolCall.name 为空的 assistant 消息
- **WHEN** `messageToAnthropic()` 处理含 `toolCall` 但 `toolCall.name` 为空的 assistant 消息
- **THEN** 输出消息不含 `tool_use` 块，只含 `text` 块（若有内容）

#### Scenario: 配套的 tool_result 消息（对应已过滤的 tool_use）
- **WHEN** `tool_use` 块已被过滤，后续 `role=tool` 消息的 `toolCallId` 无匹配
- **THEN** 该 `tool_result` 块也被过滤，不发往 Claude API

#### Scenario: 正常完整的 tool_use
- **WHEN** `toolCall.id` 和 `toolCall.name` 均非空
- **THEN** 生成标准 `tool_use` 块，行为与修改前一致

### Requirement: OpenAI 适配器对空 tool_call_id 的兜底
OpenAI/Qwen 兼容适配器 SHALL 在 `toolCall.id` 为空时自动生成合法占位 ID，不传递空字符串。

#### Scenario: tool_call_id 为空
- **WHEN** `messageToOpenAI()` 处理 `toolCall.id` 为空字符串或 `undefined` 的 assistant 消息
- **THEN** 使用 `call_<timestamp>` 格式的占位 ID 代替

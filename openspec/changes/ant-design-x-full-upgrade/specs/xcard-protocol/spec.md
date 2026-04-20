## ADDED Requirements

### Requirement: 后端 A2UI 卡片帧生成
后端 SSE sink SHALL 处理 `\x00__card__` 前缀的 chunk，将其解析为 A2UI JSON 并以 `{"card": {...}}` 格式推送给前端。

#### Scenario: 工具结果转卡片
- **WHEN** 工具执行结果包含 `__xcard__` 前缀的 JSON 字符串
- **THEN** SSE sink 提取 JSON 内容，发送 `data: {"card": <json>}` 事件帧

#### Scenario: 无效卡片 JSON 降级
- **WHEN** `__xcard__` 后的内容不是合法 JSON
- **THEN** 作为普通文本内容推送，不丢弃

### Requirement: 前端动态卡片渲染
前端 SHALL 识别 SSE 流中的 `card` 字段，使用 `@ant-design/x-card` 渲染为交互式卡片。

#### Scenario: 表格卡片渲染
- **WHEN** AI 消息包含 `card.type === 'table'` 的卡片数据
- **THEN** 前端渲染为可排序的数据表格，支持分页

#### Scenario: 信息摘要卡片
- **WHEN** AI 消息包含 `card.type === 'info'` 的卡片数据
- **THEN** 前端渲染为结构化信息卡片，包含标题、字段列表

#### Scenario: 卡片与文本混合
- **WHEN** 同一条 AI 消息既有 `content` 又有 `card`
- **THEN** 先显示卡片，下方显示文本内容

#### Scenario: 卡片操作回调
- **WHEN** 用户点击卡片中的 Action 按钮
- **THEN** 前端将按钮 `value` 作为新消息发送给后端

### Requirement: ChatMessage 卡片字段
`ChatMessage` 数据结构 SHALL 包含可选的 `card` 字段，存储解析后的 A2UI 卡片对象。

#### Scenario: 卡片数据持久化
- **WHEN** AI 回复包含卡片数据
- **THEN** `ChatMessage.card` 字段保存该卡片，切换 session 再切回后卡片仍可展示

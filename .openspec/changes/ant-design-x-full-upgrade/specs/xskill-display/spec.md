## ADDED Requirements

### Requirement: 技能结果结构化输出
后端工具/技能执行结果 SHALL 支持在输出字符串前添加 `__xcard__` 前缀，声明返回内容为 A2UI 卡片 JSON。

#### Scenario: 技能卡片输出
- **WHEN** 技能执行函数返回 `__xcard__{"type":"info","title":"...","fields":[...]}`
- **THEN** SSE sink 将其解析为 card 帧推送给前端，而不是作为普通文本

#### Scenario: 前端技能卡片显示
- **WHEN** AI 消息中包含来自技能的卡片数据
- **THEN** 前端在消息气泡中渲染技能卡片，包含技能名称、输出内容

### Requirement: 技能卡片 UI 组件
前端 SHALL 提供 `SkillCard` 组件，展示技能执行的结构化结果。

#### Scenario: 技能信息卡片
- **WHEN** `card.type === 'skill-result'` 且包含 `skillName`、`summary`、`details` 字段
- **THEN** 渲染专属技能结果卡片：顶部显示技能名和执行状态，下方展示摘要和详情折叠块

#### Scenario: 代码技能结果
- **WHEN** `card.type === 'skill-result'` 且 `details.format === 'code'`
- **THEN** details 内容使用代码高亮渲染，语言由 `details.lang` 指定

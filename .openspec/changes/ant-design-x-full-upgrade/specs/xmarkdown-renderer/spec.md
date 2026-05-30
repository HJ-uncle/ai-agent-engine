## ADDED Requirements

### Requirement: 流式 Markdown 渲染
系统 SHALL 使用 `@ant-design/x-markdown` 的 `Markdown` 组件渲染 AI 回复内容，在流式输出过程中实时增量更新。

#### Scenario: 流式文本渲染
- **WHEN** AI 正在输出内容（status === 'loading'）
- **THEN** `Markdown` 组件随每个 chunk 实时重新渲染，用户可见内容逐渐增长

#### Scenario: Mermaid 图表渲染
- **WHEN** AI 回复中包含 ` ```mermaid ` 代码块
- **THEN** 前端自动将其渲染为 Mermaid SVG 流程图或序列图

#### Scenario: KaTeX 公式渲染
- **WHEN** AI 回复中包含 `$...$`（行内）或 `$$...$$`（块级）公式
- **THEN** 前端使用 KaTeX 渲染为数学符号，而非显示原始 LaTeX 文本

#### Scenario: 代码高亮
- **WHEN** AI 回复中包含带语言标识的代码块（如 ` ```python `）
- **THEN** 代码块使用对应语言的语法高亮规则显示，并提供一键复制按钮

#### Scenario: 降级处理
- **WHEN** `@ant-design/x-markdown` 渲染抛出异常
- **THEN** 降级为纯文本显示，不显示错误信息给用户

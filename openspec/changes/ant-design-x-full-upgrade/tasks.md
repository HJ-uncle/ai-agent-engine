## 1. 依赖安装与版本确认

- [ ] 1.1 检查 `@ant-design/x-markdown` 当前版本并安装：`cd desktop && npm install @ant-design/x-markdown`
- [ ] 1.2 检查并安装 `@ant-design/x-sdk`：`npm install @ant-design/x-sdk`
- [ ] 1.3 检查并安装 `@ant-design/x-card`（若已发布稳定版）：`npm install @ant-design/x-card`
- [ ] 1.4 安装 Mermaid 和 KaTeX 支持包：`npm install mermaid katex`
- [ ] 1.5 更新 `desktop/package.json` 锁定版本，确认无冲突

## 2. xmarkdown-renderer：替换渲染引擎

- [ ] 2.1 在 `App.tsx` 中将 `import ReactMarkdown from 'react-markdown'` 替换为 `@ant-design/x-markdown` 的 `Markdown` 组件
- [ ] 2.2 更新 `MarkdownBubble` 函数，使用 `<Markdown>` 组件，传入 `enableMermaid`、`enableLatex`、`enableHighlight` 配置
- [ ] 2.3 配置代码高亮主题（与当前深色主题一致，如 `github-dark`）
- [ ] 2.4 添加 Mermaid 懒加载逻辑（`React.lazy` + `Suspense`），避免首屏 bundle 过大
- [ ] 2.5 测试：输入含 Mermaid/KaTeX/代码块的 Markdown 内容，验证渲染正确
- [ ] 2.6 测试流式渲染：发送触发长文回复的问题，验证逐字显示无闪烁

## 3. xsdk-chat-hook：封装 useXAgentChat

- [ ] 3.1 新建 `desktop/src/renderer/hooks/useXAgentChat.ts`
- [ ] 3.2 在 hook 内使用 `useXAgent`（或降级为原生 fetch）初始化 agent 实例，`request` 方法调用 `BASE_URL/api/v1/chat`
- [ ] 3.3 实现 `send(content, sessionId)` 方法：调用 agent、读取 SSE 流、解析 6 种帧（content/card/thinking/toolStart/toolEnd/usage）
- [ ] 3.4 实现 `cancel()` 方法：终止当前请求并调用 `finishStreaming`
- [ ] 3.5 在 `App.tsx` 中用 `useXAgentChat` 替换原有的 `sendMessage` 中的 inline SSE 逻辑
- [ ] 3.6 在 store `session.ts` 中新增 `appendStreamCard(card)` action
- [ ] 3.7 测试：发送消息，验证流式回复正常写入 store，多 session 切换无串流

## 4. xcard-protocol：A2UI 动态卡片

- [ ] 4.1 在 `src/core/stream-pipeline/sse-sink.ts` 新增 `__card__` 帧处理：提取 JSON 并发送 `{"card": {...}}`
- [ ] 4.2 在 `src/core/agent-loop/react.ts` 工具结果处理处：检测 `__xcard__` 前缀并 yield `\x00__card__<json>` 帧
- [ ] 4.3 在 `ChatMessage` 类型中添加 `card?: XCardData | null` 字段（定义 `XCardData` 类型）
- [ ] 4.4 新建 `desktop/src/renderer/components/XCardRenderer.tsx`，根据 `card.type` 分发到不同卡片组件
- [ ] 4.5 实现 `InfoCard`：标题 + 字段列表（key/value 布局）
- [ ] 4.6 实现 `TableCard`：Ant Design Table，支持 columns/dataSource 自动映射
- [ ] 4.7 实现 `ListCard`：列表展示，支持图标和描述
- [ ] 4.8 在 `Bubble.List` 的消息渲染逻辑中：若 `msg.card` 存在，在文本上方渲染 `<XCardRenderer card={msg.card} />`
- [ ] 4.9 测试：手动构造含 `__xcard__` 输出的 mock 工具，验证前端卡片渲染正确

## 5. xskill-display：技能结构化结果

- [ ] 5.1 新建 `desktop/src/renderer/components/SkillCard.tsx`，支持 `skill-result` 类型卡片
- [ ] 5.2 `SkillCard` 组件：顶部技能名称 + 执行状态徽章，中间摘要文字，底部可折叠详情
- [ ] 5.3 详情区域：`details.format === 'code'` 时使用 `@ant-design/x-markdown` 的代码块渲染
- [ ] 5.4 在 `XCardRenderer` 中注册 `skill-result` 类型 → `SkillCard`
- [ ] 5.5 测试：触发包含结构化 skill 输出的对话，验证技能卡片正确显示

## 6. 样式与 UX 打磨

- [ ] 6.1 为 `@ant-design/x-markdown` 配置深色主题样式，覆盖 `.md-body` CSS
- [ ] 6.2 卡片组件统一使用当前深色设计语言（`token.colorBgContainer`、圆角 8px 等）
- [ ] 6.3 Mermaid 图表支持深色模式（`mermaid.initialize({ theme: 'dark' })`）
- [ ] 6.4 KaTeX 公式字体颜色适配深色背景
- [ ] 6.5 卡片内 Action 按钮点击后发送消息，添加加载状态防止重复点击

## 7. 测试与验收

- [ ] 7.1 端到端测试：Mermaid 流程图渲染
- [ ] 7.2 端到端测试：KaTeX 数学公式渲染
- [ ] 7.3 端到端测试：代码块语法高亮 + 复制按钮
- [ ] 7.4 端到端测试：A2UI 卡片渲染（info/table/list 三种类型）
- [ ] 7.5 端到端测试：技能卡片显示
- [ ] 7.6 性能测试：长文流式渲染不卡顿（> 2000 tokens 回复）
- [ ] 7.7 验证 `@ant-design/x-card` 降级：当 `card` 包无法使用时，退回纯文本显示

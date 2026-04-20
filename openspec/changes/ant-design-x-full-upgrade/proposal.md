## Why

当前桌面客户端使用 `react-markdown` 进行内容渲染，手写 SSE 解析钩子管理对话流，没有结构化卡片协议，技能(Skill)返回格式也不规范。Ant Design X 生态（`@ant-design/x`、`@ant-design/x-markdown`、`@ant-design/x-card`、`@ant-design/x-sdk`、`@ant-design/x-skill`）已提供完整的 AI 应用工具链，全面升级可显著减少样板代码、获得更好的流式渲染性能，并让 Agent 具备返回可交互动态卡片的能力。

## What Changes

- 🎨 **前端渲染升级**：用 `@ant-design/x-markdown` 替换 `react-markdown`，支持 Mermaid 图表、数学公式(KaTeX)、语法高亮
- 📡 **对话流管理**：引入 `@ant-design/x-sdk` 的 `useXAgent` / `useXChat` 替代当前手写 SSE 解析逻辑
- 🃏 **动态卡片协议**：集成 `@ant-design/x-card`，后端可通过 SSE 流推送 A2UI JSON，前端自动渲染交互式卡片
- 🧠 **技能卡片格式**：后端 skill 执行结果新增 `x-skill` 返回格式，前端用 Skill 展示组件呈现
- 🔌 **后端协议扩展**：SSE sink 新增 `__card__` 帧类型，chat route 新增卡片生成工具，Skill 注册支持结构化输出

## Capabilities

### New Capabilities

- `xmarkdown-renderer`: 使用 `@ant-design/x-markdown` 实现流式 Markdown 渲染，支持公式、Mermaid、代码高亮
- `xcard-protocol`: 后端 SSE 新增 `__card__` 帧；前端 `@ant-design/x-card` 解析并渲染 A2UI 动态卡片
- `xsdk-chat-hook`: 用 `@ant-design/x-sdk` 的 `useXAgent`/`useXChat` 重构前端对话数据流管理
- `xskill-display`: 后端 skill 结果支持结构化 `x-skill` 格式，前端用专属卡片组件展示技能执行结果

### Modified Capabilities

- `streaming`: SSE sink 新增 `__card__` 帧解析；前端 useChat 改用 x-sdk 管理 **BREAKING**

## Impact

- **前端**：`desktop/src/renderer/App.tsx`、`desktop/src/renderer/store/session.ts`、`desktop/package.json`
- **后端**：`src/core/stream-pipeline/sse-sink.ts`、`src/core/agent-loop/react.ts`
- **依赖新增**：`@ant-design/x-markdown@^2.5`、`@ant-design/x-card`、`@ant-design/x-sdk`（前端）
- **向后兼容**：后端 API 路由不变，SSE 协议新增帧类型，原有帧保持不变

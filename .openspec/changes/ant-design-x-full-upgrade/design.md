## Context

项目是 Electron + Vite + React + TypeScript 桌面客户端，后端是 Node.js + Fastify + libSQL。当前前端手写 SSE Reader 解析对话流（`App.tsx` 约 600 行），使用 `react-markdown` 渲染，无动态卡片能力。Ant Design X 2.5 已发布完整生态，本次升级目标是将其全部集成。

## Goals / Non-Goals

**Goals:**
- 用 `@ant-design/x-markdown` 替换 `react-markdown`，支持流式渲染、Mermaid、KaTeX 公式
- 引入 `@ant-design/x-sdk` (`useXAgent` / `useXChat`) 简化 SSE 数据流管理
- 集成 `@ant-design/x-card`，实现 A2UI 动态卡片协议（后端推送 JSON → 前端渲染交互卡片）
- 后端 SSE 新增 `__card__` 帧类型，skill 执行结果支持结构化输出

**Non-Goals:**
- 不改变 API 路由结构
- 不重构 libSQL 存储层
- 不升级 Electron 版本

## Decisions

### D1：渐进式包替换，不重写整个 App.tsx

**决定**：仅替换渲染层（`MarkdownBubble` 组件）和 SSE hook 层，保留现有 Zustand store 结构。

**理由**：`useXChat` 内部管理 messages 状态，但当前 store 有多 session、历史加载、token 累计等复杂逻辑，完全迁移风险大。选择「外壳不动，内核升级」策略：
- `MarkdownBubble` → `@ant-design/x-markdown` 的 `Markdown` 组件
- SSE 解析 → 封装成 `useXAgent` 适配器，仍写入 Zustand store

**替代方案**：完全用 `useXChat` 替换 store → 风险高，放弃

### D2：A2UI 卡片协议设计

**后端格式**（新增 SSE 帧）：
```
data: {"card": {"type": "...", "data": {...}, "actions": [...]}}
```

**前端处理**：SSE 解析到 `card` 字段时，将其存入 `ChatMessage.card` 字段，`Bubble` 的 `messageRender` 根据消息类型选择渲染器：
- `content` → `@ant-design/x-markdown`
- `card` → `@ant-design/x-card`（`XCard` 组件）
- 混合（先 card 后 content）→ 两者都渲染

**卡片类型支持**：
- `table`：动态数据表格
- `chart`：ECharts 图表
- `form`：交互式表单（结果回传）
- `list`：列表卡片
- `info`：信息摘要卡片

### D3：@ant-design/x-sdk 集成策略

`useXAgent` 充当 SSE 适配器，将原生 fetch stream 桥接到 Ant X 的标准消息格式。具体做法：
1. 创建 `XAgent` 实例，`request` 方法调用后端 `/api/v1/chat`
2. 解析 SSE 帧，`content`/`card`/`thinking`/`toolStart`/`toolEnd`/`usage` 分别 dispatch
3. 保持向 Zustand store 写入，维持多 session 能力

### D4：后端 Skill 结构化输出

在 `sse-sink.ts` 新增 `__card__` 帧处理。在 Agent loop 工具执行完成后，如果工具结果包含 `__xcard__` 前缀，则将其作为卡片帧推送而非普通文本。

## Risks / Trade-offs

- `@ant-design/x-card` 可能尚处 Beta，API 稳定性风险 → 封装为 `XCardRenderer` 组件，出问题可降级到纯文本
- `@ant-design/x-sdk` 的 `useXAgent` 与现有多 session Zustand store 的集成需要仔细隔离 → 每个 session 独立创建 agent 实例或共享实例 + sessionId 路由
- Mermaid 渲染需要额外 bundle（~500KB）→ 懒加载

## Migration Plan

1. 安装新依赖（前端）
2. 升级 `MarkdownBubble` → `@ant-design/x-markdown`（无破坏）
3. 封装 `useXAgentChat` hook 替换 `sendMessage` 中的 SSE 解析
4. 后端 `sse-sink.ts` 新增 `__card__` 帧
5. 前端增加 `XCardRenderer` 组件和 `ChatMessage.card` 字段
6. 测试所有帧类型的流式渲染

## Open Questions

- `@ant-design/x-card` 是否已发布 npm 稳定版？需安装时确认
- `@ant-design/x-sdk` 的 `useXAgent` 是否支持自定义 fetch？需看文档确认

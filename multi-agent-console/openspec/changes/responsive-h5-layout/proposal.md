## Why

`multi-agent-console` 当前采用 VSCode 桌面布局（48px Activity Bar + 可拖拽 Sidebar + 多窗分屏 + Monaco 编辑器 + xterm 终端），在移动端浏览器（H5）上完全无法正常使用：横向三栏挤成一团、字号/点击区过小、所有面板基于鼠标拖拽交互。后续计划用 Capacitor / RN WebView 套壳打包到移动端原生 App，因此需要一套同代码、同构建的响应式 H5 适配方案，让同一份代码在桌面 ≥1024px 维持现有 VSCode 形态，在移动端 <768px 切换为单面板 + 底部 Tab + 抽屉的移动形态。

## What Changes

- 新增统一的响应式断点系统与 `useBreakpoint` Hook（`mobile <768`、`tablet 768–1023`、`desktop ≥1024`）
- `index.html` 加入 viewport、`safe-area-inset`、禁缩放、`apple-mobile-web-app-capable` 等 H5 元数据
- `App.tsx` 拆分双形态布局：桌面态保持原 Activity Bar + Sidebar + MainArea；移动态改为 全屏单面板 + 顶部 AppBar + 底部 TabBar + 左侧抽屉
- 移动端**降级**：隐藏 Monaco 编辑器、xterm 终端、文件资源管理器右键菜单与多窗分屏；保留 对话/会话列表/Agents/MCP/知识库/工具/记忆/任务/设置 面板
- 触屏适配：所有可点击区域最小 44×44px，鼠标 `mousedown/mousemove` 拖拽逻辑在移动端不挂载
- 滚动条、字号、内边距按平台差异化：移动端字号 14px、点击区放大、滚动条隐藏
- ChatArea / SessionList / Settings 等主要面板新增 `@media` 移动样式：气泡占满 92%、Header 高度上调到 44px、PromptCard 单列
- **BREAKING**：`App.module.css` 中 `.activityBar`/`.sidebar`/`.sidebarResizer` 在移动断点下不再渲染或被新组件替代；外部如有依赖请同步调整

## Capabilities

### New Capabilities
- `responsive-layout`: 统一断点系统、`useBreakpoint` Hook、移动态 Shell（AppBar + Drawer + BottomTabBar）、移动端面板降级策略与 H5 viewport / safe-area 规范

### Modified Capabilities
<!-- 当前 openspec/specs/ 为空，无既有 spec 需要 modify -->

## Impact

- **代码**：
  - 新增 `src/hooks/useBreakpoint.ts`、`src/components/mobile/AppBar.tsx`、`src/components/mobile/BottomTabBar.tsx`、`src/components/mobile/Drawer.tsx`
  - 修改 `public/index.html`、`src/index.css`、`src/App.tsx`、`src/App.module.css`
  - 修改 `src/components/ChatArea.module.css`、`src/components/SessionList.module.css`、`src/components/AgentPanel.module.css`、`src/components/McpPanel.module.css`、`src/components/KnowledgePanel.module.css`、`src/components/TodoPanel.module.css`、`src/components/settings/SettingsLayout.module.css` 增加 `@media` 移动样式
  - `src/components/EditorArea.tsx`、`src/components/explorer/index.tsx`、`src/components/terminal/TerminalPanel.tsx` 在移动端渲染降级占位
- **API / 后端**：无变化
- **依赖**：无新增（不引入新的 UI 库，复用现有 Antd + CSS Modules）
- **构建**：仍是 `react-scripts build` 一份产物，桌面端与移动端共用
- **后续 RN 打包**：H5 完成后可直接放进 Capacitor / RN WebView 套壳，无需二次开发

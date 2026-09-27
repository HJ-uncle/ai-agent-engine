## 1. 基础设施：断点系统与 CSS 变量

- [x] 1.1 新增 `src/hooks/useBreakpoint.ts`，导出 `useBreakpoint()` 与常量 `BP = { mobile: 767, desktop: 1024 }`，使用 `window.matchMedia` 监听
- [x] 1.2 在 `src/index.css` 的 `:root` 中加入 CSS 变量：`--app-bar-h: 44px`、`--bottom-tab-h: 56px`、`--safe-top: env(safe-area-inset-top, 0px)`、`--safe-bottom: env(safe-area-inset-bottom, 0px)`、`--touch-min: 44px`
- [x] 1.3 修改 `src/index.css`：移动端媒体查询下隐藏 `::-webkit-scrollbar`；input/textarea 在移动端 `font-size: 16px` 防止 iOS 自动缩放
- [x] 1.4 修改 `src/index.css` 的 `html, body` 高度策略为 `height: 100%; min-height: 100dvh`（保留 `100vh` fallback）

## 2. H5 元数据：viewport 与原生套壳支持

- [x] 2.1 修改 `public/index.html` 的 `viewport` meta 为 `width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover`
- [x] 2.2 在 `public/index.html` `<head>` 追加 `apple-mobile-web-app-capable=yes`、`apple-mobile-web-app-status-bar-style=black-translucent`、`format-detection=telephone=no, email=no, address=no`
- [x] 2.3 将 `theme-color` 从 `#000000` 改为 `#1e1e1e`，与应用背景一致
- [x] 2.4 修改 `<title>` 为 "Multi-Agent Console"

## 3. 移动 Shell 组件

- [x] 3.1 新增 `src/components/mobile/AppBar.tsx`：固定顶部，高度 `var(--app-bar-h) + var(--safe-top)`，左插槽（汉堡）、中标题、右插槽（操作）
- [x] 3.2 新增 `src/components/mobile/AppBar.module.css`：暗色背景、底部 1px 分割线、`padding-top: var(--safe-top)`
- [x] 3.3 新增 `src/components/mobile/BottomTabBar.tsx`：接收 `items: { key, icon, label }[]`、`activeKey`、`onChange`，每项最小 44×44，并显示 label（10px）
- [x] 3.4 新增 `src/components/mobile/BottomTabBar.module.css`：固定底部、`padding-bottom: var(--safe-bottom)`、激活态 `color: #4fc1ff` + 顶部 2px 高亮线
- [x] 3.5 新增 `src/components/mobile/Drawer.tsx`：基于 Antd `Drawer` 封装，`placement="left"`、`width=280`、内部渲染全部 8 个导航 + 设置入口
- [x] 3.6 新增 `src/components/mobile/MobileShell.tsx`：组合 AppBar + 主内容 + BottomTabBar + Drawer，按 `ui.activePanel` 渲染对应面板（复用 App.tsx 的 sidebarPanel + ChatArea 逻辑）

## 4. App.tsx 双形态分发

- [x] 4.1 在 `src/App.tsx` 顶层引入 `useBreakpoint`，根据返回值条件渲染 `<MobileShell />` 或现有桌面布局
- [x] 4.2 将 `usePersist`、`ACTIVITIES`、`HistoryPanel`、`ToolsPanel`、`MemoryPanel`、`TasksPanel` 等可复用部分抽到 `src/components/panels/index.tsx`，移动桌面共用
- [x] 4.3 桌面分支保持现有 `MainArea`、`Activity Bar`、`Sidebar`、`sidebarResizer` 逻辑不变（零回归）
- [x] 4.4 移动分支：不挂载任何 `mousedown` 拖拽监听；`MainArea` 强制为 `chat-only` 形态（不渲染分屏切换工具栏）

## 5. 桌面专属功能的移动端降级

- [x] 5.1 修改 `src/components/EditorArea.tsx`：移动端渲染占位组件 `<MobileNotSupported feature="编辑器" />`
- [x] 5.2 将 Monaco 相关 import 改为 `React.lazy(() => import('./editor/MonacoEditor'))`，仅桌面分支挂载（避免移动端打入主包）
- [x] 5.3 修改 `src/components/terminal/TerminalPanel.tsx`：同样懒加载并在移动端渲染 `<MobileNotSupported feature="终端" />`
- [x] 5.4 修改 `src/components/explorer/index.tsx` / `ContextMenu.tsx`：移动端不绑定 `onContextMenu`
- [x] 5.5 新增 `src/components/mobile/MobileNotSupported.tsx`：统一的占位 UI（图标 + 文案 + 提示语）

## 6. 各业务面板的移动样式覆盖

- [x] 6.1 `src/components/ChatArea.module.css` 末尾追加 `@media (max-width: 767px)` 块：`.header { height: 44px; padding: 0 12px }`、`.bubble { max-width: 92% }`、`.content { font-size: 15px }`、`.promptGrid { grid-template-columns: 1fr }`、`.welcomeIcon { font-size: 40px }`
- [x] 6.2 `src/components/SessionList.module.css` 追加移动样式：每项高度 ≥ 56px、字号 14px、点击区扩大；隐藏 hover 操作按钮，改为常驻
- [x] 6.3 `src/components/AgentPanel.module.css` 追加移动样式：列表项卡片化、内边距 14px、字号 14px
- [x] 6.4 `src/components/McpPanel.module.css` / `KnowledgePanel.module.css` 追加同等移动样式
- [x] 6.5 `src/components/TodoPanel.module.css` 追加移动样式：复选框 20×20、整行可点
- [x] 6.6 `src/components/settings/SettingsLayout.module.css` 追加移动样式：左侧分类菜单变成顶部横向滚动 Tab，主内容全宽
- [x] 6.7 `src/components/SettingsModal.tsx`：移动端将 Modal `width` 设为 `100vw`，`style={{ top: 0, paddingBottom: 0 }}`，模拟全屏覆盖

## 7. Antd 全局调整

- [x] 7.1 在 `src/App.tsx` 的 `ConfigProvider` 中根据断点动态调整 `token.fontSize`：移动 14、桌面 13
- [x] 7.2 移动端禁用 Tooltip：在 `Tooltip` 外层包一个 `MaybeTooltip` 组件，移动端直接返回 children
- [x] 7.3 在 `src/index.css` 添加移动端 Antd Modal 全屏覆盖样式：`@media (max-width: 767px) { .ant-modal { max-width: 100vw; margin: 0; top: 0 } .ant-modal-content { min-height: 100dvh; border-radius: 0 } }`

## 8. 验证与回归

- [x] 8.1 `npm run typecheck` 通过
- [ ] 8.2 桌面端 1280×800 视口手测：Activity Bar、Sidebar、拖拽分隔条、Monaco、xterm 全部正常（零回归）
- [ ] 8.3 移动端 375×667（Chrome DevTools iPhone SE）手测：AppBar / 抽屉 / 底部 Tab 切换 / 聊天发送 / 设置打开正常
- [ ] 8.4 移动端验证：Monaco / xterm / 文件树右键不出现，且控制台无报错
- [ ] 8.5 视口拉宽缩窄过 768/1024 阈值，激活面板与会话状态保持
- [ ] 8.6 iOS Safari 实测（如有条件）：safe-area 正确、输入框聚焦不放大、双指捏合无效
- [x] 8.7 `npm run build` 产物大小对比：移动端首屏不应包含 monaco worker chunk

  **验证结果（2026-05-08）**：
  | Chunk | gzip | 内容 | 移动端首屏 |
  |---|---|---|---|
  | `main.18b24c32.js` | 733.69 kB | 主框架 + UI 壳 | ✅ 加载 |
  | `773.64d189f7.chunk.js` | 86.56 kB | **Xterm 内核**（93 处 xterm + `BufferLine`×34）| ❌ 不加载（懒加载） |
  | `269.6a9f3d0f.chunk.js` | 7.10 kB | **Monaco wrapper**（`editor.create`、`onDidChangeModelContent`）| ❌ 不加载（懒加载） |
  | `334.ae40a106.chunk.js` | 3.52 kB | 其他 lazy 模块 | ❌ 不加载 |
  | `122.83a80d72.chunk.js` | 596 B | 文件搜索 Web Worker | ❌ 不加载 |

  - `main.js` 内 `monaco-editor/esm`、`xterm/lib`、`MonacoEnvironment` 引用均为 0 ✓
  - Monaco 主体经 `@monaco-editor/react` 走 CDN 异步装载，**完全不进 bundle**
  - 移动端首屏可省 ≈ 95 kB gzip（终端 + 编辑器 wrapper），符合预期

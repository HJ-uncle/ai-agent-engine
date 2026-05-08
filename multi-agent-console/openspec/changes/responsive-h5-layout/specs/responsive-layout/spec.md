## ADDED Requirements

### Requirement: 统一断点系统

系统 SHALL 提供单一的响应式断点定义，且所有响应式判断 MUST 通过此 Hook，禁止在组件内自行写 `window.innerWidth` 判断。

断点定义 MUST 满足：
- `mobile`：viewport 宽度 ≤ 767px
- `tablet`：viewport 宽度 768–1023px
- `desktop`：viewport 宽度 ≥ 1024px

`useBreakpoint()` MUST 返回当前断点字符串，并在 viewport 变化时自动重新渲染调用方。

#### Scenario: 桌面断点判定

- **WHEN** 用户浏览器视口宽度为 1280px
- **THEN** `useBreakpoint()` 返回 `'desktop'`，且 `App.tsx` 渲染原 VSCode 三栏布局（Activity Bar + Sidebar + MainArea）

#### Scenario: 移动断点判定

- **WHEN** 用户浏览器视口宽度为 375px
- **THEN** `useBreakpoint()` 返回 `'mobile'`，且 `App.tsx` 渲染移动 Shell（AppBar + 单面板 + BottomTabBar），不渲染 Activity Bar 与 Sidebar

#### Scenario: 视口动态变化

- **WHEN** 用户在 1024px 与 600px 之间拖动浏览器窗口
- **THEN** Hook MUST 在跨过 768/1024 阈值时返回新值，导致 `App.tsx` 重新渲染并切换形态，且当前激活的面板 (`ui.activePanel`) 与会话状态 MUST 保持不变

### Requirement: 移动端 Shell 布局

当断点为 `mobile` 时，系统 SHALL 渲染包含以下结构的移动 Shell：

- 顶部 `AppBar`（高度固定 44px + safe-area-inset-top）：左侧汉堡按钮打开 Drawer、中间显示当前面板/会话标题、右侧可由当前面板注入操作按钮
- 中间内容区：单面板全屏显示，根据 `ui.activePanel` 渲染对应组件
- 底部 `BottomTabBar`（高度固定 56px + safe-area-inset-bottom）：固定 4 个高频入口 `chat / agents / mcp / settings`
- 左侧 `Drawer`：列出全部 8 个导航项（含 explorer / chat / agents / mcp / knowledge / tools / memory / tasks）+ 设置入口

#### Scenario: 切换 Tab 后关闭抽屉

- **WHEN** 用户点击汉堡按钮打开 Drawer，然后点击 Drawer 中的 "知识库" 项
- **THEN** `ui.activePanel` 设置为 `knowledge`，Drawer 自动关闭，中间内容区切换为 `KnowledgePanel`

#### Scenario: 底部 Tab 与 Drawer 状态同步

- **WHEN** 用户通过 Drawer 切到 `agents`
- **THEN** BottomTabBar 上 `agents` 项 MUST 高亮为激活态

#### Scenario: 安全区适配

- **WHEN** App 运行在带刘海/Home Indicator 的 iOS 设备
- **THEN** AppBar 顶部 padding 等于 `env(safe-area-inset-top)`，BottomTabBar 底部 padding 等于 `env(safe-area-inset-bottom)`，避免内容被刘海或 Home Indicator 遮挡

### Requirement: 桌面专属功能在移动端的降级

当断点为 `mobile` 时，系统 MUST 对以下桌面专属功能进行降级处理，且 MUST NOT 抛出异常或破坏页面布局：

- Monaco 编辑器 (`EditorArea` / `MonacoEditor`)：渲染降级占位文案 "编辑器仅在桌面端可用"，MUST NOT 加载 `monaco-editor` 主包
- xterm 终端 (`TerminalPanel`)：渲染降级占位文案 "终端仅在桌面端可用"
- 文件管理器右键菜单 (`ContextMenu`)：MUST NOT 绑定 `onContextMenu`
- `MainArea` 多窗分屏 (`splitMode` 切换工具栏)：MUST NOT 渲染，直接强制 `chat-only` 形态
- Sidebar 拖拽手柄 (`sidebarResizer`)：MUST NOT 渲染，且 mousedown 监听器 MUST NOT 挂载

#### Scenario: 移动端不加载 Monaco 主包

- **WHEN** 移动端用户首次打开页面
- **THEN** 网络面板 MUST NOT 出现 `monaco-editor` 相关 chunk 的请求

#### Scenario: 移动端文件树不响应右键

- **WHEN** 移动端用户长按文件树节点（触发浏览器的 contextmenu 事件）
- **THEN** 系统 MUST NOT 弹出自定义 ContextMenu

#### Scenario: 移动端无分屏模式按钮

- **WHEN** 移动端用户进入聊天面板
- **THEN** 顶部 MUST NOT 显示 `chat-only / horizontal / vertical` 三个模式切换按钮

### Requirement: H5 viewport 与原生套壳元数据

`public/index.html` MUST 包含以下 meta 标签以支持 H5 与 Capacitor / RN WebView 套壳：

- `<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />`
- `<meta name="apple-mobile-web-app-capable" content="yes" />`
- `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />`
- `<meta name="format-detection" content="telephone=no, email=no, address=no" />`
- `<meta name="theme-color" content="#1e1e1e" />`（替换原 `#000000`）

#### Scenario: 禁止用户缩放

- **WHEN** 移动端用户在屏幕上做双指捏合手势
- **THEN** 页面 MUST NOT 被缩放

#### Scenario: 移动端 Safari 全屏样式

- **WHEN** 用户将 Web App 添加到 iOS 主屏并启动
- **THEN** 状态栏 MUST 为半透明黑色，App 内容延伸到状态栏下方

### Requirement: 触屏可用性

移动端断点下，所有可点击元素 MUST 满足：

- 最小命中区域 ≥ 44×44 CSS 像素
- 字号 ≥ 14px
- 输入框 `font-size` ≥ 16px（避免 iOS Safari 自动放大）
- 主要文本与背景对比度 ≥ WCAG AA

移动端 MUST 隐藏 `::-webkit-scrollbar`，使用浏览器原生惯性滚动。

#### Scenario: 底部 Tab 命中区

- **WHEN** 用 375×667 视口测量 BottomTabBar 中单个 Tab 项
- **THEN** 该项的 `width × height` MUST ≥ 44×44 CSS 像素

#### Scenario: 输入框不触发自动放大

- **WHEN** iOS Safari 用户聚焦聊天输入框
- **THEN** 输入框 `font-size` 计算值 MUST ≥ 16px，页面 MUST NOT 自动缩放

### Requirement: 双形态状态一致性

`useBreakpoint` 切换形态时，业务状态 MUST 持久化并保持一致：

- 当前激活面板（`ui.activePanel`）MUST 在 localStorage 持久化，桌面/移动切换不丢失
- 会话列表 (`useSessionStore.sessions`) 与活动会话 ID MUST 在两种形态共享同一份 store
- 设置面板的 `useSettings` 状态 MUST 不因布局切换而重置

#### Scenario: 切换形态保留激活面板

- **WHEN** 用户在桌面端将激活面板从 `chat` 切到 `agents`，然后将窗口缩到 600px 进入移动形态
- **THEN** 移动 Shell 的 BottomTabBar 上 `agents` MUST 处于激活态，主内容显示 `AgentPanel`

#### Scenario: 切换形态保留会话

- **WHEN** 用户在移动端选中会话 A 进入聊天，然后将窗口拉宽到 1280px 进入桌面形态
- **THEN** 桌面 SessionList 中会话 A MUST 仍处于激活态，ChatArea 显示 A 的消息历史

## ADDED Requirements

### Requirement: 移动端独立入口

系统 MUST 提供独立的移动端 React 入口文件 `src/mobile/index.tsx`，对应独立的 HTML 模板 `public/m.html`，构建产物为 `build/m.html`。该入口与桌面入口 (`src/web/index.tsx` / `index.html`) 在运行时完全互不加载。

#### Scenario: 移动入口独立挂载
- **WHEN** 浏览器访问 `/m.html`
- **THEN** 仅加载 mobile chunk（含 `antd-mobile`），不加载 `monaco-editor`、`xterm`、`antd` 主包

#### Scenario: 入口文件挂载移动 App
- **WHEN** `m.html` 在浏览器中执行
- **THEN** `ReactDOM.createRoot` 渲染 `<MobileApp />`（来自 `src/mobile/App.tsx`）

### Requirement: 路由结构

移动端 SHALL 使用 `react-router-dom` 提供以下顶层路由：

| 路径 | 页面 | TabBar 显示 |
|---|---|---|
| `/`           | ChatPage          | 对话 |
| `/sessions`   | SessionsPage      | 会话 |
| `/agents`     | AgentsPage        | 智能体 |
| `/me`         | MeSettingsPage    | 我的 |
| `/settings/*` | SettingsRoutes    | (不在 TabBar 上) |
| `/knowledge`  | KnowledgePage     | (二级，从"我的"进入) |

#### Scenario: TabBar 切换路由
- **WHEN** 用户点击底部 TabBar 中的"会话"
- **THEN** URL 变为 `/sessions` 且 `SessionsPage` 渲染

#### Scenario: 浏览器返回键
- **WHEN** 用户从 `/sessions` 进入 `/settings/about` 后按返回键
- **THEN** 回退到 `/sessions`，状态保持

### Requirement: 原生手感导航

移动端 MUST 使用 `antd-mobile` 的 `NavBar`、`TabBar` 组件实现顶部导航和底部 Tab，禁止使用 `antd` 的 `Menu` / `Layout.Sider`。

#### Scenario: NavBar 高度与安全区
- **WHEN** 在 iOS Safari 全屏模式下渲染任意 page
- **THEN** NavBar 总高度 = 44px + `env(safe-area-inset-top)`，标题居中，左右插槽可放图标

#### Scenario: TabBar 固定底部
- **WHEN** 长内容 page 滚动到底部
- **THEN** TabBar 始终固定在视口底部（`position: fixed; bottom: 0`），下方留 `env(safe-area-inset-bottom)` 内边距，且不被内容遮挡

### Requirement: 原生弹层模型

移动端 MUST 使用 `antd-mobile` 的 `Popup`（半屏抽屉）、`ActionSheet`（操作菜单）、`Toast`（轻提示）、`Dialog`（模态确认）替代任何 `antd` 的 `Modal`、`Drawer`、`Tooltip`、`Popconfirm`。

#### Scenario: 选择操作使用 ActionSheet
- **WHEN** 用户在会话列表长按某条会话
- **THEN** 从底部弹出 `ActionSheet`，列出"重命名 / 置顶 / 删除"，背景遮罩可点关闭

#### Scenario: 不出现 Tooltip
- **WHEN** 在移动端任意页面截图
- **THEN** DOM 中不存在任何 `.ant-tooltip` 节点

### Requirement: 触摸交互基线

移动端所有可点击元素 MUST 满足：
- 触控热区 ≥ 44×44 CSS px
- 单击响应延迟 ≤ 100ms（不依赖 `dblclick` 触发主操作）
- 不绑定 `mousedown` / `mouseenter` / `mouseleave` 事件
- 表单输入框 `font-size` ≥ 16px（防 iOS 自动缩放）

#### Scenario: 单击直接触发
- **WHEN** 用户在 ChatPage 点击发送按钮
- **THEN** 一次 `touchend` 即触发发送，不需要双击

#### Scenario: 没有 hover 残留样式
- **WHEN** 用户在任意列表项上触摸滑过
- **THEN** 不出现 `:hover` 态背景色（CSS 中应使用 `@media (hover: hover)` 包裹 hover 样式）

### Requirement: 滚动与视口

主内容区 MUST 使用 `100dvh` 计算高度（fallback `100vh`），且当软键盘弹起时输入框 MUST 自动滚入视口。底部 TabBar 不参与内容滚动。

#### Scenario: 地址栏伸缩不破坏布局
- **WHEN** 用户在 iOS Safari 上滑/下滑触发地址栏隐藏/显示
- **THEN** 主内容高度自适应，TabBar 始终贴底，不出现"白条"

#### Scenario: 输入框聚焦
- **WHEN** 用户在 ChatPage 点击聊天输入框
- **THEN** 输入框被键盘顶起后仍可见（不被键盘遮挡）

### Requirement: 移动端不复用桌面 UI 组件

`src/mobile/` 下的任何文件 MUST NOT import `src/web/*`、`src/components/*`（旧目录已废弃）、或任何 PC 专属 UI 组件（Monaco、Xterm、`react-resizable`、`react-flow-renderer` 等）。

#### Scenario: 静态依赖检查
- **WHEN** 执行 `madge --circular --extensions tsx,ts src/mobile`
- **THEN** 输出中不包含来自 `src/web` 或 `src/components/mobile` 的引用

### Requirement: 必备移动页面集合

第一版移动端 MUST 实现以下页面（其余功能可后续迭代）：

- ChatPage：当前对话窗口（消息列表 + 输入栏 + 附件按钮 + 模型/Agent 切换）
- SessionsPage：历史会话列表（搜索 + 长按 ActionSheet）
- AgentsPage：Agent 列表与选择
- MeSettingsPage：设置入口聚合（个人 / 模型 / 知识库 / 关于）
- KnowledgePage：知识库文档列表（移动版）
- 设置子页：模型配置、API Key、关于

#### Scenario: 五个 TabBar Tab 全部可达
- **WHEN** 启动 mobile 入口并依次点击 4 个 TabBar 项 + 进入"我的"再进入"知识库"
- **THEN** 所有页面正常渲染，无 React 错误，无 404 路由

### Requirement: 不支持的功能优雅提示

移动端访问 Monaco 编辑器、xterm 终端、文件树拖拽、文件右键菜单等桌面专属功能时，SHALL NOT 加载相关代码，且 SHALL NOT 在 UI 上提供入口。

#### Scenario: 移动端不出现编辑器入口
- **WHEN** 在移动端任意页面操作
- **THEN** UI 上找不到打开 Monaco 编辑器或 xterm 终端的按钮 / 菜单

## Context

`multi-agent-console` 是一个基于 React 19 + Antd 6 + CSS Modules 的 Agent 控制台，UI 完全按 VSCode 桌面三栏布局设计：

- `App.module.css`：`.app { display:flex; height:100vh; width:100vw }`
- 强制三栏：`.activityBar(48px)` + `.sidebar(120-600px, 鼠标拖拽)` + `.main(flex:1)`
- `MainArea` 内部还有第二层分栏：EditorArea（Monaco）+ 拖拽分隔条 + ChatArea，含 `chat-only/horizontal/vertical` 三种模式
- 全局 `font-size: 13px`、`scrollbar 6px`、所有按钮 24×24，全是桌面密度
- 重度依赖鼠标事件：`onMouseDown` / `onMouseMove` / `Tooltip placement="right"` / 右键菜单
- 桌面专属功能：`@monaco-editor/react`（编辑器）、`@xterm/xterm`（终端）、`react-file-icon` + 文件树右键

约束：
- 当前已签署 React 19 + Antd 6，**不引入新 UI 库**（保持 bundle 小、避免重复依赖）
- 必须同代码、同构建产物，不分 mobile/desktop 两套打包
- 后续打包路线已确认是 **Capacitor / RN WebView 套壳**，故只需关注浏览器内 H5 表现
- 已确认移动端**降级**：隐藏 Monaco、xterm、文件树右键、多窗分屏

## Goals / Non-Goals

**Goals:**

- G1：建立单一断点系统（`mobile <768`、`tablet 768–1023`、`desktop ≥1024`）和 `useBreakpoint` Hook，所有响应式逻辑只走这一个出处
- G2：移动端 (`<768px`) 切换为 **AppBar + Drawer + 单面板内容 + BottomTabBar** 的标准移动 Shell，桌面端 (`≥1024`) 完全保持现状（零回归）
- G3：移动端核心面板（对话/会话列表/Agents/MCP/知识库/工具/记忆/任务/设置）可用、可点；点击区 ≥44×44px，字号 ≥14px
- G4：H5 viewport / safe-area-inset / 无缩放 / WebApp meta 配置齐全，可直接被 Capacitor / RN WebView 装载
- G5：桌面专属功能在移动端**优雅降级**为占位提示，不报错、不破坏布局

**Non-Goals:**

- N1：不重写为 React Native 原生组件
- N2：不实现 Monaco / xterm 的移动端版本（占位即可）
- N3：不为平板（768–1023）定制独立形态，平板默认走桌面布局
- N4：不引入 Tailwind / styled-components / unocss 等新样式方案
- N5：本次不改后端 API、不改 `store/`、`hooks/useChat.ts`、`api/` 等业务层

## Decisions

### D1：断点策略 — 同代码 + JS 媒体查询 Hook（而非纯 CSS @media）

选择 `useBreakpoint()` 返回 `'mobile' | 'tablet' | 'desktop'`，在 `App.tsx` 顶层做形态分发：

```ts
// src/hooks/useBreakpoint.ts
const QUERIES = {
  mobile:  '(max-width: 767px)',
  tablet:  '(min-width: 768px) and (max-width: 1023px)',
  desktop: '(min-width: 1024px)',
} as const
```

**为何不只用 CSS @media？**
当前桌面布局含大量 `mousedown` 拖拽逻辑、Monaco/xterm 这种重组件，CSS `display:none` 仍会挂载并消耗内存/带 worker。JS 分发可在移动端**不挂载**这些组件，性能与启动速度更友好；且 RN WebView 中 viewport 抖动较多，JS Hook 比 CSS 更稳。

**为何不引入 antd `Grid.useBreakpoint`？**
Antd Grid 的断点是 `xs/sm/md/lg/xl/xxl` 6 档，与本项目实际只需 3 档不一致；自建 Hook 更轻量、零依赖。

### D2：移动端 Shell 结构

```
┌─────────────────────────────┐  ← safe-area-inset-top
│  AppBar  [☰]  会话标题  [⋯] │  44px
├─────────────────────────────┤
│                             │
│  当前 Tab 对应面板（全屏）   │
│  - chat:   ChatArea         │
│  - agents: AgentPanel       │
│  - ...                      │
│                             │
├─────────────────────────────┤
│ 💬   🤖   🧠   ⚙️           │  56px BottomTabBar
└─────────────────────────────┘  ← safe-area-inset-bottom

[Drawer 抽屉] ←  从左侧滑入：所有导航项（含 Activity Bar 8 项 + 设置）
```

- `AppBar`：左侧汉堡（开抽屉）、中间会话名、右侧上下文操作（每个面板可自定义）
- `Drawer`：列出 `ACTIVITIES` 全部 8 项 + 设置；点击切换 Tab 并自动关闭
- `BottomTabBar`：只放最高频 4 项（chat / agents / mcp / settings），其余通过 Drawer 进入

### D3：桌面专属功能在移动端的处理

| 功能 | 桌面行为 | 移动端处理 |
|---|---|---|
| Activity Bar | 显示 | **不渲染**（由 Drawer 替代） |
| Sidebar 拖拽 | 鼠标拖拽 | **不挂载** drag handler |
| MainArea 分屏切换 | 三种模式 | **强制 chat-only**，不显示模式按钮 |
| Monaco 编辑器 (`EditorArea`) | 完整渲染 | 渲染降级占位：「编辑器仅在桌面端可用」 |
| xterm 终端 (`TerminalPanel`) | 完整渲染 | 渲染降级占位：「终端仅在桌面端可用」 |
| Explorer 右键菜单 | `ContextMenu` | 改为长按弹出 ActionSheet（用 Antd Drawer 模拟）；本次先**禁用右键** |
| Tooltip placement | `right` | 改为 `bottom`（避免被屏幕边缘截断） |
| Modal | 居中弹窗 | 改为底部 Sheet 风格（设置 `wrapClassName` 触发 CSS 覆盖） |

### D4：CSS 适配方式

- 全局尺度变量放 `index.css` 的 `:root`：`--app-bar-h`、`--bottom-tab-h`、`--safe-top`、`--safe-bottom`、`--touch-min`
- 移动端通过 `@media (max-width: 767px)` 在已有 `.module.css` 末尾追加覆盖块；不为每个组件再起新文件，降低维护成本
- viewport：`width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover`
- safe-area：根布局 `padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom)`
- 滚动条：移动端 `::-webkit-scrollbar { display:none }`，靠惯性滚动

### D5：导航 Tab 的状态来源

复用现有 `usePersist('ui.activePanel')`，移动端的 BottomTabBar / Drawer 改的也是同一个 key，桌面/移动切换时状态一致。

### 备选方案（已排除）

- **A1：完全重写为 Antd Mobile** — 引入新依赖、与现有 Antd 6 主题冲突、桌面端会受影响。否决。
- **A2：分包构建（mobile.html + index.html）** — 违反"同代码同构建"目标；需维护两套路由。否决。
- **A3：用 Tailwind 加响应式 utility** — 引入新构建链与设计令牌，与现有 CSS Modules 不正交。否决。

## Risks / Trade-offs

- **R1**：JS 分发导致桌面/移动切换时（如旋转屏幕）会卸载并重挂载组件树 → 用 `usePersist` 把会话/激活面板放 localStorage，确保状态不丢
- **R2**：Antd Modal 在移动端默认居中，宽度小屏溢出 → 通过 `ConfigProvider` 注入 `Modal.styles.content` 移动端样式 + 全局 CSS 覆盖
- **R3**：Monaco / xterm 的 worker 即使不渲染，import 也会被 webpack 打入主包导致首屏变大 → 移动端用 `React.lazy` 动态 import，配合 `useBreakpoint` 判定后再加载
- **R4**：iOS Safari 100vh 包含地址栏抖动 → 用 `100dvh` + fallback `100vh`
- **R5**：原生套壳后键盘弹起会顶起 viewport → 输入框容器加 `padding-bottom: env(keyboard-inset-height, 0)` 兜底
- **R6**：触摸长按与 Antd Tooltip 冲突 → 移动端禁用 Tooltip（`disabled={isMobile}`）

## Migration Plan

1. 第 1 阶段（基础设施）：断点 Hook、CSS 变量、index.html / index.css 调整。**无视觉变化**，可独立合入
2. 第 2 阶段（移动 Shell）：新增 AppBar / Drawer / BottomTabBar 三个组件，`App.tsx` 顶层按断点分发；桌面端代码路径完全不动
3. 第 3 阶段（面板适配）：逐个面板的 `.module.css` 追加移动端 `@media` 覆盖
4. 第 4 阶段（降级处理）：EditorArea / TerminalPanel / Explorer 移动端占位
5. 回滚：每阶段独立 commit，回滚只需 `git revert` 对应 commit；最坏情况删除 `useBreakpoint` 调用即可恢复桌面行为

## Open Questions

- Q1：移动端的 Settings 是直接全屏路由还是底部 Sheet？暂定**全屏覆盖**（与桌面 Modal 一致，但移动端撑满）
- Q2：是否需要 PWA `manifest.json` 配置 `display: standalone`？暂保持现状，留待后续
- Q3：抽屉是否支持手势滑出？暂只做"点击汉堡打开 / 点击遮罩关闭"，手势 v2 再加

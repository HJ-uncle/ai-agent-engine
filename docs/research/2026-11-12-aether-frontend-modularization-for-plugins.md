# Aether 前端插件承载的模块化方案

日期：2026-11-12

实施说明：下文保留调研时的结构与方案，旧目录和组件名不再代表当前代码。重构后的单界面目录、实际插件挂载点和扩展约定见 [前端结构](../../../aether-code/docs/frontend-architecture.md)，可用的外部插件清单、HTML bridge 与服务生命周期见 [插件前端贡献协议](../plugin-ui-contributions.md)。

本方案基于 `D:\dev\aether-code` 的 Workbench、Work、Chat、成果、编辑器、终端、设置和插件管理源码，以及 DeepSeek Harness 的 112 个客户端 Slot 契约。目标是让插件进入宿主组件树时有稳定的 UI 契约，同时保持苹果式极简 UI、统一焦点管理和可卸载生命周期。

## 结论

Aether 前端需要专门模块化，但不是把每个 JSX 文件机械拆小，也不是让插件直接改 DOM。需要把可扩展能力拆成四层：

1. **宿主壳层**：负责布局、尺寸、焦点、键盘、遮罩、主题和错误边界。
2. **业务组件层**：负责 Work、Chat、成果、工作区、编辑器、终端、设置和插件管理的业务状态。
3. **贡献注册层**：负责 `view / tab / action / renderer / menu / overlay` 等可插入区域，并返回 disposer。
4. **状态与能力层**：把宿主状态投影成只读 props，把写操作收敛为带权限的 command/bridge。

插件只进入第三层声明的区域，不能直接读取 Zustand/React store、调用任意 IPC、操作主窗口 DOM 或自行向 `body` 追加全局弹窗。

## 当前基础与缺口

Aether 已经有可复用的 `ViewRegistry`：

- `D:\dev\aether-code\src\renderer\src\workbench\view-registry.ts:12-83`
- 支持 `sidebar | panel | editor | right` 四种位置。
- 有 `registerView/registerViews/getViews/onViewsChanged` 和卸载 disposer。
- `Sidebar`、`PanelArea`、`EditorArea` 已按注册表消费视图。

需要纠正一个容易误判的地方：当前 `workbench/Workbench.tsx:49-53` 直接渲染 `WorkView`。上述通用 Sidebar/PanelArea/EditorArea 有 registry 消费代码，但当前 Work 主窗口没有挂载它们。**已有注册表是可复用基础，不代表正在使用的 Work 已经支持插件页面。**

目前还缺以下能力：

- 没有 `pluginId/revision/scope/permission` 归属，无法审计第三方贡献。
- 注册表只承载完整 View，无法承载 Tab、工具栏按钮、消息卡片、成果行动作和 renderer。
- Work 的 `Page`、`WorkspaceTab`、`NAVIGATION` 仍写死在 `contrib/work/WorkView.tsx:131-225`，`:691` 和 `:882-915`。
- Chat、成果、子代理、设置页虽然已拆成组件，但没有对外的 typed contribution contract。
- `registerView` 和 `registerCommand` 遇到重复 id 时覆盖旧项；旧 disposer 按 id 删除，可能误删后来注册的新项。插件更新必须改为注册令牌/所有者校验，或直接拒绝重复注册，不能照搬。
- ViewRegistration 虽声明 `when`，`getViews` 和旧 ActivityBar/Sidebar 消费处未见条件求值；不能把字段存在当作已生效的可见性控制。

## 推荐的组件树

### 壳层

```text
WorkbenchShell
├─ MenuBar
├─ WorkHost（当前实际入口）
│  ├─ WorkNavigation / WorkSessionList
│  ├─ WorkPageHost / WorkConversation
│  └─ WorkWorkspaceTabs / WorkResourcePane
├─ StatusBar
└─ OverlayHost / CommandPalette
```

这是建议的责任拆分，不是已实现组件树。先在当前 Work 路径接入扩展宿主；保留已有编辑器、终端和预览组件。无需为了插件恢复旧 Code 布局，也无需把所有普通子组件都做成 slot。宿主只在有实际扩展需求的边界声明插槽。

### Work

```text
WorkHost
├─ WorkNavigation
├─ WorkHome
├─ WorkProjects
├─ WorkSession
│  ├─ WorkConversation
│  ├─ WorkSubagents
│  └─ WorkComposer
├─ WorkWorkspace
│  ├─ WorkResourceTabs
│  ├─ WorkWorkspacePanel
│  ├─ WorkSessionArtifacts
│  ├─ WorkChanges
│  └─ WorkTerminal
└─ WorkRightbar
```

`WorkView.tsx` 应逐步退化为 controller + region assembly；每个区域内部只接收派生 props 和 `renderContribution()`，不再维护一份巨大的 page/tab 联合类型。

### Chat

```text
ChatHost
├─ ChatHeader
├─ SessionTray
├─ ConversationViewport
│  ├─ MessageList
│  ├─ MessageRenderer
│  ├─ ToolCardRenderer
│  ├─ SubagentCardRenderer
│  └─ FinalResultRenderer
├─ Composer
│  ├─ ComposerLeading
│  ├─ ComposerInput
│  ├─ ComposerTrailing
│  └─ ComposerOverlay
└─ ChatRightbar
```

这棵 Chat 树是可复用会话领域的建议拆分，不应另建一套平行会话运行时。当前 Work 路径实际调用 `WorkComposer`（`WorkView.tsx:1636`）、`WorkMessageContent`（`:1914`）、`WorkArtifactsWorkspace`（`:2555`）。`WorkComposer.tsx:8-14` 已复用 Chat 的 `InputComposer` 原语。因此应先在 Work 适配器接入共享 composer/message slots，不能只改旧 `ChatView` 后宣称 Work 已生效。

## ContributionRegistry 设计

`ViewRegistry` 的使用方逐步迁移到统一贡献生命周期；命令、菜单、renderer 各有自己的强类型接口。不要把所有扩展压进 `slot: string + owner: unknown` 的万能注册器。

| 契约层 | 必要字段或规则 |
|---|---|
| 宿主声明 | `SlotMap` 将每个 key 映射到准确 owner props、作用域、cardinality、支持版本和 allowed contribution kind |
| 类型化注册 | `register<K extends keyof SlotMap>` 推导组件 props；Action 只能注册 command，renderer 必须给出类型匹配规则 |
| 归属 | plugin id、安装实例、代码 revision、registration token；id 默认按插件命名空间隔离 |
| 实例身份 | engine/source generation、workspace/session/message/artifact 身份、view instance id；代码 revision 与业务数据 revision 分开 |
| 数据与动作 | 只读快照/selector + 明确动作；跨隔离边界的数据须可序列化、经过运行时 Schema 校验 |
| 生命周期 | 注册返回幂等 disposer；旧 disposer 不能撤销新 revision；切换 source 后丢弃旧异步结果 |
| 界面投影 | 排序、显隐、固定/更多、selected/active；禁用/卸载当前页后回到合法位置 |
| 故障处理 | 注册冲突、缺失依赖、错误边界、bridge 取消、状态诊断；不吞错 |

使用统一的 ownership/dispose 机制，不等于所有入口都必须使用同一个 API。按钮、导航、菜单项可由宿主按元数据渲染；复杂面板支持作者自定义组件。跨窗口 bridge 不传 ReactNode、函数闭包或裸 store。

为 AI 提供可查询的 slot catalog：名称、owner props、允许动作、样式组件、作用域、当前可用状态、已有占用者、最小示例。模板和 SDK 从同一份契约生成，避免 AI 猜组件/接口名称。

组件 SDK 至少区分三套能力：`@aether/plugin-sdk` 承载 manifest/bridge/lifecycle；`@aether/plugin-ui` 提供统一控件和设计 tokens；`@aether/plugin-testing` 提供装载、切换作用域和卸载的验收夹具。以上为建议包名，并非已经发布的依赖。内置页面也用同一套公共契约注册，从真实使用中检验 SDK。

页面挂载、后台服务激活和 Agent 工具暴露必须分开：安装/启用插件可注册 UI 元数据，打开页面再加载其视图，当前会话通过 `@` 或显式配置选用工具包。拥有一个 UI 入口不应自动将该插件所有工具加入每轮模型请求。需要跨插件扩展时，插件页面可声明自己命名空间内的子 slot，其他插件通过显式依赖和同一生命周期规则贡献。

## 第一批组件化插槽

### P0：可以先做

- `shell.activity.top/bottom`
- `sidebar.views`
- `work.navigation.items`
- `work.navigation.more`
- `work.workspace.tabs`
- `work.resource.tabs`
- `work.rightbar.tabs`
- `plugins.list.actions`
- `plugins.detail.actions/badge/section`
- `commands`
- `shortcuts`
- `toast`

### P1：完成后插件才真正能服务 Work

- `chat.header.actions`
- `chat.session-tray.tabs`
- `chat.session-tray.row.leading/trailing/actions`
- `chat.composer.leading/trailing/overlay/sources`
- `chat.message.before/after/actions`
- `chat.tool-card`、`chat.tool-card.actions`
- `chat.subagent.card/header/actions`
- `chat.final-result.actions`
- `work.artifacts.toolbar/row/detail/preview`
- `work.changes.actions`
- `work.workspace.toolbar/file.row/context-menu/preview`
- `work.terminal.toolbar/tab.actions/status`
- `settings.navigation.items/sections/fields`

### P2：需要更严格信任控制

- `chat.message.renderer` keyed renderer
- `work.workspace.preview` 文件类型 renderer
- `chat.composer.takeover` chain
- `chat.message.wrapper` HOC
- `work.layout.wrapper` HOC
- 全局主题 token 或图标替换

贡献区域和执行信任等级是两个独立维度。已经信任并满足兼容要求的客户端包可以共享宿主 React；需要隔离的作者页面则通过 iframe/WebContentsView 与 bridge 嵌入相应面板。GitHub 只是来源，不是信任结论。声明式按钮与导航始终由宿主绘制，自定义复杂 UI 不必退化成 Schema 表单。同一渲染器里的 Slot、CSS scope 和 ErrorBoundary 也不能当作恶意代码沙箱。

## 宿主组件的统一约束

每个可扩展组件都必须提供：

- **slot 名称和类型**：`list/keyed/single/chain/hoc`。
- **作用域**：root、session、workspace、artifact、message。
- **只读 owner props**：例如 `sessionId`、`messageId`、`artifactId`、`status`、`displayName`。
- **受控动作**：统一走 command/bridge，返回取消、超时和错误状态。
- **生命周期**：注册返回 disposer，插件停用、更新、窗口关闭时全部回收。
- **视觉契约**：只能使用 Aether design tokens、`Icon`、Button、Popover、Dialog 和标准 focus ring。
- **错误边界**：插件组件出错只折叠自己的区域，不得让 Work/Chat 整体消失。
- **数据归属**：插件持久业务数据进入宿主管理的插件数据空间，与不可变代码 revision 目录分开；删除/更新 bundle 不应隐式删除业务数据。会话、工作区和成果数据保持各自事实来源，写操作经域 API 完成。

弹窗和浮层尤其要复用现有 Dialog/Popover/overlay 管理，统一焦点、Escape、层级和关闭原因。任意 body 注入会增加重复浮层和卸载残留风险；这是一项架构风险分析，并非此前 UI 重复问题的已证实根因。

视觉建议依据 macos-design 与 ui-ux-pro-max：图标动作保留 tooltip 和可访问名称，列表保持紧凑，低频动作收进更多菜单；使用现有 tokens.css 的明暗主题和统一控件。这里采用 Apple 风格的层次与交互，Windows 窗口仍保留平台快捷键和窗口行为。焦点恢复、Tab 管理和 Escape 需要以现有 Dialog/overlay 的行为验收；本地 UX 检索只准确命中可见焦点和层级规则，没有命中焦点恢复规则，不将检索结果冒充完整交互验证。

## 性能与内存边界

- 插件 manifest/catalog 可先读元数据，页面 bundle 首次打开时才加载；不默认挂载所有已安装页面。
- 按 slot 和当前 scope 订阅。流式 token 不应通知整个插件注册表；文件列表只订阅文件版本变化。
- 展示倒计时可使用页面定时器；定时任务的持久状态与执行归 Host，页面隐藏不改变任务事实。
- 明确 hidden、unmounted、disabled、uninstalled 四种状态。隐藏页暂停无用订阅，未挂载页释放视图资源，停用撤销贡献和运行能力，卸载另行处理数据保留。
- keep-alive 采用按需和有界策略，不能像旧 PanelArea 一样把所有注册项永久挂载；需支持淘汰、恢复滚动/草稿以及未保存状态处理。
- 卸载必须回收订阅、监听器、计时器、Worker、对象 URL 和归属样式；服务端长任务另按其停止/保留契约处理。

## 实施顺序

1. **先抽接口**：保留 ViewRegistry，新增 ContributionRegistry、scope、plugin provenance 和 disposer。
2. **再抽 Work**：把 WorkNavigation、WorkspaceTab、ResourceTab 从 `WorkView.tsx` 的硬编码常量迁出，接入 registry。
3. **再抽会话**：把 ChatHeader、SessionTray、Composer 的 actions/sources/overlay 注册化。
4. **再抽成果**：把 artifacts、diff、文件预览、右栏 Tab 和产物动作注册化。
5. **用纵向样例验证运行时**：从第一批 Work slots 开始，同步接一个真实客户端模板的 manifest、bundle、revision、bridge、事件和停用清理。不要等全部区域拆完才发现外部插件无法装载。

每一步都要有真实验收：注册一个内置测试贡献，检查出现、排序、作用域、点击动作、切换会话、卸载、更新和异常隔离；再把同一套契约给一个外部插件使用。没有通过卸载和重连测试的区域不能称为插件扩展点。


## 与 Harness 的插入面比较

Harness 的生成目录 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` 当前有 **112 个 Slot key**：会话 45、侧栏 28、设置 13、插件管理 9、其他 17。这是生成的编译期目录，非运行时全部同时可用；其中包含替换位和依赖其他插件的位，数量不等于 112 个稳定公共新增区域。除 Slot 外，还有 `contextMenus.register`、`commandUi.register/decorate`、`inputTriggers.registerSource`、`shortcuts.register`、事件/视图/交互/分组 registry、toast、locale/theme/icon registry。

Aether 应比 Harness 更细的不是全局页面数量，而是 Work 特有的成果、子代理、附件、回退和恢复区域：成果工具栏/文件行/详情/预览/diff/回退/导出/批量操作，子代理列表/状态/提问/详情/继续/停止/消息/产物，均可形成稳定插入点。

完整 Harness 源码追踪和区域清单见 `harness-client-integration-notes.md` 第十一至十五节。

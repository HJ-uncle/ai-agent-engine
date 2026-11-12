# Harness 前端扩展面的运行时边界

调研对象：`D:\dev\deepseek-harness`，提交 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。只做静态源码研究，没有执行第三方插件或安装依赖。

## 结论

Harness 的前端可以按区域组合插件，但并非把任意 React 组件插入任意页面。组件必须贡献到宿主已声明且当前存活的 Slot，并通过宿主授予的渲染接口消费子 Slot。其生成目录有 **112 个 Slot 契约、12 个 Factory 定义**；这不等于 112 个始终存在、兼容性相同或对第三方承诺稳定的插入位。Factory 是可复用组件定义，也不能再算成 12 个全局区域。

完整逐项矩阵见 [harness-frontend-slot-matrix.md](harness-frontend-slot-matrix.md)，静态扫描原始结果见 [harness-frontend-slot-inventory.json](harness-frontend-slot-inventory.json)。扫描脚本仅解析 TypeScript AST，不执行被调研项目；使用的是引擎工作区已有的 TypeScript。

## 必须保留的六项运行时约束

| 约束 | 源码证据与调用链 | 对本项目的启示 |
|---|---|---|
| 真正预置的入口只有 `root` | `packages/client/ui-slots/src/index.ts:1049` 初始化 root；`ui-layout/src/client/index.ts:192–201` 注册 root frame 后才声明 sidebar/main/rightbar/overlay 等区域 | 可以把导航、主页面、右面板、输入附件等作为第一批宿主契约，但要由明确 owner 声明，不能把整个目录当永远存在的 API |
| 目标必须已声明，且声明只有一个 owner | `ui-slots/src/index.ts:1241` 的 register 路径校验声明和冲突；`ui-renderer/src/client/registry.ts:209–269` 的 `slots.inject` 等待 owner 出现，并在声明生命周期内启动注册 | 插件页面晚于插件加载、基础模块停用、热重载都应通过等待声明处理，不依赖加载顺序碰运气 |
| 卸载 owner 会撤掉子区域 | `ui-slots/src/index.ts:1632–1637` 的 `releaseChildren`；`ui-renderer/src/client/registry.ts:741–753` 把注册纳入调用方 `ctx.effect` | 插件卸载必须撤销组件、订阅、事件和子贡献；不能只在设置中把 enable 改为 false |
| 渲染权限按组件绑定 | `ui-renderer/src/client/registry.ts:376–387`：ctx 级 renderSlot 只允许 root；`scoped-slots.tsx:73–89`：组件只能渲染自己声明的 children，失效闭包及越权调用抛错 | 插件获得的是某个区域的能力，不能跨区域随意渲染，也不需要允许 DOM 注入 |
| 插入和替换要分开 | `ui-slots/src/index.ts:1317–1323` 排序；single/keyed cell 的较低 priority 胜出；list 按条目组合，chain 首个匹配接管，hoc 包装 children | 初版对外优先开放 list/keyed 的明确追加能力；整列 sidebar、主 composer、消息 body 等替换能力应单独声明和管理冲突 |
| scope 是上下文契约 | `ui-renderer/src/client/registry.ts:312–338` 的 root hooks 与 scope adapters；目录各项标明 root/session/session-maybe | 顶层插件页不能假定有当前会话，涉及会话的组件必须获得显式 session 绑定 |

上述源码短路径均相对于 `D:\dev\deepseek-harness\packages\client\`，除首个写出完整路径的条目外。

## 代表性区域：声明 → 贡献 → 消费

| 区域 | 真实调用链 | 边界 |
|---|---|---|
| 左侧导航和主页面 | `ui-sidebar/index.ts:89–105` 声明 `sidebar.panellist` 等；`:58–70` 将条目 metadata 同步到 navigation；`ui-layout/AppFrame.tsx:49` 按 panelId 消费 keyed `main` | 追加一个导航项并不自动拥有页面内容；导航 metadata 与主内容组件需对应 |
| 会话头部、输入区 | `ui-conversation/apply.ts:433–475` 声明 header/composer 子槽；`ConversationSession.tsx:206–219`、`InputBar.tsx:457–587` 消费 | owner 存在才有效；不能把 composer 的 chain 接管当普通工具按钮追加 |
| 消息与工具结果 | `ui-chat/chat/register-node-renderers.ts:41–98` 声明节点内部区域；`ui-tool/apply.ts:36–41` 声明按工具名分发的 toolview；`ui-tool/tool/ToolCallTree.tsx:53` 消费 | 事件如何组装成节点与节点如何显示是不同扩展层，不能只注册 UI 就改变会话事件语义 |
| 成果和预览 | `ui-deliverables/index.ts:64–93` 声明成果操作；`ui-sidebar-documentpreview/index.ts:104–111` 声明 document/action 区域 | 文档后缀/匹配 metadata 和 keyed renderer 是两步，不是丢入组件即可自动成为预览器 |
| 右侧页签 | `ui-sidebar-right/index.ts:233–247` 声明 tab/title；`tab-registry.ts:253` 注册页签定义；`shell/SidebarRight.tsx:221` 以动态变量 `seat` 消费，key 为 definition.id 或 tab.kind | 页签 metadata registry 与 tab body 注册都需要；静态字符串扫描无法直接发现此动态消费，因此矩阵的这两行需结合本说明阅读 |
| 设置和插件管理页 | `ui-settings-general/index.ts:237–244` 声明设置入口；`ui-plugin-manager/index.ts:129–147` 声明自身的 add.actions/tab/item/config/detail 等 9 个区域；`PluginManagerPage.tsx` 消费 | 插件管理页自身也能扩展，但其局部槽依赖管理页 owner，不是全局通用 API |
| 结构化上下文菜单 | `ui-context-menu/index.ts:171–174` 提供内容及图标槽；`ui-context-menu/registry.ts:30/54/145` 注册、解析、执行菜单项 | 内置 session 菜单走 `ctx.contextMenus`，旧 menu.item Slot 不是所有内置操作的替换入口 |

上表源码路径位于 `packages/client/`，`index.ts` 等省略共同的 `src/client/`；完整文件路径在逐项矩阵及 JSON 中。

## 公开域扩展与插件自定义子槽

应将目录分为：运行时 root、基础 frame 契约、会话/文件/设置等领域契约、特定功能插件的子槽、Factory 局部参数。后三者的 owner、生命周期和兼容承诺不同，不能仅因为出现在目录中就统一称为稳定宿主入口。

现成案例包括：语音插件贡献 `conversation.input.activity`，成果插件贡献 `conversation.chat.turnTail`，forge 贡献右侧页、会话 utilities、hero options 和会话行徽标。`packages/extensions/ui-cordis/src/client/index.ts:124–128` 则由功能插件声明 `tool.view.cordis`：这是该插件自己的子扩展面，卸载它后子区域不再存在。

此外，conversation 的 event/group/view/user-text/interaction registry、右侧 tab registry、文档预览 registry、资源 protocol、快捷键、结构化菜单等都在 Slot 之外。它们负责数据解释、选择、行为或导航信息；可视内容再由 Slot/Factory 承载。模块化方案需要同时定义行为注册接口和显示契约，不能把所有扩展都归结为 UI 插槽。

## 动态 browser-half 不等于普通 Client bundle

`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:71–78` 的规则针对动态 browser-half：通过 `ctx.slots.register` 贡献 UI，用 `slots.inject` 绑定 owner；facade 自动分配优先级；不能 import，使用传入的 React 和 `styles.insert`，并遵循主题变量。普通打包 Client 插件的模块能力不同，不能将这组限制泛化到整个 Harness 插件系统。

目录是编译期契约，实际可注册区域仍以 live owner 为准。该目录中的历史检查命令注释存在滞后，不能直接作为当前工具协议示例；当前调研结论采用实际工具的 list/query 路径。

## 调研范围与复用建议

本次计数来自生成目录与真实声明/注册/消费代码的交叉扫描，不是运行页面快照，也不构成对全部第三方兼容性的验证。根 Slot 在底层初始化、右侧 tab 使用变量消费，属于静态扫描需人工补充的两个特例。

本项目适合借鉴的是“宿主声明有限区域 → 插件提交 metadata/行为/组件 → 生命周期统一撤销 → 页面按 key 渲染”的机制。先做导航页、右侧面板、输入工具标签、工具结果与设置入口等有限契约即可，无需复制 112 个 Slot 或为所有现有组件一次性改造。

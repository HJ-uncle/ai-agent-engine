# 插件挂载点内部维护审计

日期：2026-11-13。对象：`ai-agent-engine` 与同级 `aether-code` 当前工作区。用途：维护者评审扩展边界和后续实施顺序，**不是公共 API 索引或尚未实现能力的承诺**。公共文档索引不链接本报告。

挂载扫描沿实际主界面调用链进行，未新增挂载点。本轮另外修正了交叉验证发现的能力目录、SDK 类型与原生组件校验差异，验证记录另存于维护者验收报告。下文“已实现”表示 Schema、宿主调用与实际界面位置能够对应；“内部结构”表示有 React 组合接口或内置注册表，但未向外部插件发布；“候选”均为设计建议。

源码路径约定：`E/` 表示 `D:/dev/ai-agent-engine/`，`F/` 表示 `D:/dev/aether-code/`，`R/` 表示 `F/src/renderer/src/`。行号为本次扫描时的位置，后续修改需按符号复核。

## 1. 当前契约计数与有效入口

| 维度 | 当前数量 | 计数口径及依据 |
| --- | ---: | --- |
| 贡献类型 | **12** | `pages/navigation/workspaceTabs/services/commands/menus/views/statusBar/settings/editorDecorations/hooks/background`；`E/src/plugins/contributions.ts:19`、`:73` |
| 菜单位置 | **8** | `message.actions/session.context/file.context/editor.context/editor.toolbar/app.menu/service.context/composer.toolbar`；`E/src/plugins/contributions.ts:8` |
| 内嵌视图位置 | **3** | `message.inline/composer.panel/workspace.panel`；`E/src/plugins/contributions.ts:9` |
| 平台权限 | **21** | `PLUGIN_CAPABILITY_IDS`，默认不授权；`E/src/plugins/capabilities.ts:10` |
| 事件类型 | **15** | 2 个应用、3 个会话、2 个消息、工作区、文件、编辑器选区、输入框，以及 4 个 Agent 生命周期事件；`E/src/plugins/contributions.ts:10` |
| 原生声明式组件 | **13** | `text/heading/stack/row/divider/button/input/textarea/select/checkbox/card/image/markdown`；`E/src/plugins/contributions.ts:77`、`R/features/extensions/native-document.ts:3` |
| 页面 SDK 方法 | **45** | 按 `$AE` 暴露的方法路径计数，包含通用 `call`，不重复计算兼容别名 `aetherPlugin`；`R/features/extensions/webview-document.ts:45` |

45 个方法的分组口径：根方法 5、services 5、commands 1、events 2、ui 11、skills 2、session 1、models 1、ai 1、agents 4、mcp 2、knowledge 5、workspace 3、settings 2。它是页面桥的方法数，不代表 Node 工具也拥有全部页面 UI 方法，更不代表 45 个挂载位置。

当前应用入口为 `ApplicationShell → ApplicationView`，Shell 常驻 MenuBar、StatusBar 和设置对话框。ApplicationView 根据页面选择装配 Home、Projects、AgentManager、PluginManager、AutomationsView、Browser；会话页再装配 Conversation 和 Workspace。证据：`R/app/ApplicationShell.tsx:34`、`:37`、`:40`、`:48`；`R/app/ApplicationView.tsx:636`、`:654`、`:677`、`:690`、`:701`、`:717`。页面懒加载见 `R/app/pages.tsx:4`。不能以旧模式目录或孤立组件推断当前入口。

## 2. 已实现的贡献与真实承载位置

| 贡献 | 当前实际承载及边界 | 源码证据 |
| --- | --- | --- |
| `pages` | 工具表单、沙箱 HTML 和原生 JSON 页面三种 renderer。原生 JSON 由宿主 React 控件渲染，不加载插件提供的 React 模块。 | `R/features/extensions/ExtensionPage.tsx:147`；`R/features/extensions/NativeExtensionPage.tsx` |
| `navigation` | 左侧应用导航追加入口，跳转到已注册页面；不是任意侧栏 DOM 注入。 | `R/app/ApplicationView.tsx:525`、`:680` |
| `workspaceTabs` | 当前会话右侧工作区标签及“更多工作区”菜单，使用同一页面宿主。 | `R/features/workspace/WorkspaceView.tsx:145`、`:247`、`:315` |
| `services` | 服务状态、启动／停止／查询和页面入口；固定底部活动托盘展示。服务内存截止时间不等于持久后台调度。 | `R/features/extensions/services.ts:35`、`:58`、`:68`；`R/app/StatusBar.tsx:67` |
| `commands` | 命令面板、声明的快捷键、菜单和状态栏共用命令执行入口。停用时撤销。 | `R/features/extensions/interactions.ts:24`、`:39`；`R/ui/CommandPalette.tsx` |
| `menus` | 8 个位置，见下表；仅在实际调用 `useExtensionMenuItems` 的宿主中成立。 | `R/features/extensions/slots.tsx:14` |
| `views` | 3 个位置，默认折叠，展开时挂载，当前全局最多同时展开 4 个；第五个展开会释放最早展开的页面。 | `R/features/extensions/slots.tsx:11`、`:25` |
| `statusBar` | 底部状态栏追加命令按钮；活动托盘是宿主常驻入口，不为每个插件创建一个托盘。 | `R/app/StatusBar.tsx:67`、`:70` |
| `settings` | 新增独立插件设置页并参加页面级搜索；不提供任意内置设置页插槽，也没有字段级声明式设置生成器。 | `R/features/settings/AppSettingsView.tsx:210`；`R/features/extensions/interactions.ts:40` |
| `editorDecorations` | 工作区 CodePreview 的装饰；匹配为字面子串，不是任意正则或全平台编辑器服务。 | `R/features/workspace/CodePreview.tsx:37`、`:187` |
| `hooks` | 明确授权后，根据声明事件调用插件工具。4 个 `agent.*` 来自引擎真实生命周期；前端发布类型没有因此获得伪造 Agent 事件的入口。 | `E/src/plugins/lifecycle-runtime.ts:44`、`:68`、`:96`；`F/src/shared/plugin-contributions.ts:36` |
| `background` | 引擎管理的持久定时调度；窗口关闭到托盘与引擎完全退出不同。完全退出期间不持续运行，下次启动恢复；不提供任意常驻 `activate/dispose` Node 模块。 | `E/src/plugins/background-runtime.ts:29`、`:63`、`:114`、`:140` |

### 2.1 菜单与视图逐项核对

| 位置 | 当前接入处 | 必须说明的边界 |
| --- | --- | --- |
| `message.actions` | `R/features/conversation/MessageContent.tsx:62`、`:240` | 普通和补充消息；`readOnly` 时隐藏动作入口。不是消息批量选择工具栏。 |
| `session.context` | `R/features/sessions/SidebarTask.tsx:22`、`:72` | 目前是左侧会话右键；顶部 `TaskActions.tsx:76` 和项目内会话 `Projects.tsx:416` 尚未复用。 |
| `file.context` | `R/features/workspace/WorkspacePanel.tsx:133`、`:771` | 传入当前文件目标，未开放内部已有的整组多选路径。 |
| `editor.context`、`editor.toolbar` | `R/features/workspace/CodePreview.tsx:35`、`:36`、`:161` | CodePreview 专用；打开菜单时保存选区快照，不能描述成所有编辑器和所有文档预览都接入。 |
| `app.menu` | `R/app/MenuBar.tsx:123` | 顶部插件菜单及已声明命令，不允许重写所有系统菜单。 |
| `service.context` | `R/features/services/ServiceTray.tsx:136` | 服务／通知行的附加菜单；详情本体依旧由宿主固定展示。 |
| `composer.toolbar` | `R/features/composer/Composer.tsx:99`、`:529` | 输入框工具栏；不代表 `@` 引用来源、附件动作和发送校验已开放。 |
| `message.inline` | `R/features/conversation/MessageContent.tsx:221`、`:248` | 消息下方折叠面板。子代理转录复用 MessageContent，因此也继承此面板，但没有运行级子代理上下文。 |
| `composer.panel` | `R/features/composer/Composer.tsx:357` | 输入框上方折叠面板；不是自由替换输入编辑器。 |
| `workspace.panel` | `R/features/workspace/WorkspaceView.tsx:339` | 工作区附加折叠面板；不是每种文件、Git 或成果对象的专用 inspector。 |

### 2.2 现有边界，不能写成已开放的能力

- **上下文有限**：`ExtensionContext` 只有 session、workspace、engineReady、messageId/messageRole/filePath/selectionText/targetId；工具额外上下文只转发后 5 个字符串字段。没有通用多选、run/child/asset 身份、surface、readOnly、目标版本契约。见 `R/features/extensions/types.ts:6`、`interactions.ts:16`。
- **可见性条件有限**：只有 `session/workspace/engineReady` 三个布尔条件，没有消息角色、工具名称、MIME、运行状态或页面条件。见 `E/src/plugins/contributions.ts:6`。
- **内部组合不等于插件 API**：`MessageContent.userActions/replyActions/children`、`CompactToolRow.detailFooter`、`ExtensionRegistration.components` 都是宿主内部 React 接口。见 `R/features/conversation/MessageContent.tsx:49`、`shared/CompactToolRow.tsx:43`、`R/features/extensions/types.ts:20`。
- **子代理的继承是局部的**：`SubagentTranscript.tsx:43`、`:191` 传 `readOnly` 使用 MessageContent；消息内嵌视图仍可挂载，而消息操作按钮被隐藏。未单独开放子代理详情／运行操作，也未向 inline context 传入 readOnly。后续上下文设计需显式表达该边界。
- **编辑器是只读预览**：`CodePreview.tsx:56`、`:147` 返回 `readOnly:true`；SDK 的 `replaceSelection` 在此明确拒绝。不能用方法名存在证明可编辑。`composer.insert` 当前追加草稿末尾，不是光标位置插入。
- **浏览器两种页面不同**：受信插件标签复用沙箱页面桥，`openPluginBrowserPage` 目前只接受 webview；普通网站没有 `$AE`。见 `R/features/browser/browser-store.ts:62`、`:65`、`:114`。native 页面不能借此宣称也支持浏览器标签。
- **设置已可用但有范围**：`$AE.settings.get/set` 访问插件自身设置；不能读取模型密钥或随意修改平台全局设置。独立设置页已支持，不应重复列为“缺失能力”。
- **权限不是操作系统沙箱**：21 项授权控制宿主 SDK；Node 插件是本机代码。现有页面 sandbox/CSP、修订授权、工作区限定与 Node 进程自身权限是不同层。见 `E/src/plugins/capabilities.ts:77`、`R/features/extensions/ExtensionPage.tsx:142`。
- **避免误删旧模块**：未接入当前插件宿主的旧编辑器注册不代表其关联 store、GitDiff、搜索和编辑器设置都无用。此次没有据文件名或 export 删除组件。

## 3. P0：优先补齐业务对象与批量上下文

下表“建议名”仅供讨论，**不是当前允许的 manifest 值**。优先补一类对象完整的动作、上下文和结果承载，不按按钮数量拆成多个功能。

| 编号／建议区域 | 用途与当前缺口 | 必要上下文 | 实际入口证据 |
| --- | --- | --- | --- |
| P0-1 对话多选操作 `conversation.selection.actions` | 选定数轮后质检、总结、脱敏、生成需求文档。现只提供复制／导出，插件不知道用户选了哪些轮次。 | `sessionId, selectedTurnIds, selectedMessageIds, historyRevision, completeness`；内容按授权读取。 | `R/features/conversation/ConversationView.tsx:306`、`:554`、`:646` |
| P0-2 工具结果 renderer／操作 `tool.result`、`tool.actions` | 在对应调用内展示 flow 轨迹、图片对比、结构化数据，保留原始回执入口。现为内置分支或通用 JSON 摘要。 | `sessionId, messageId, toolCallId, toolName, status, resultRevision, readOnly`，结果引用和分页。 | `R/features/conversation/ToolActivity.tsx:42`、`:46`；`R/features/conversation/shared/CompactToolRow.tsx:150`；`R/features/conversation/shared/ToolResult.tsx:78` |
| P0-3 附件动作 `attachment.context` | 发送前压缩、OCR、转格式，或把历史附件派生成新附件。现只有预览／移除。 | `attachmentId, filePath, mimeType, size, origin, messageId?, draftRevision?`，区分生成新件与替换草稿附件。 | `R/features/composer/Composer.tsx:376`、`:385`；`R/features/conversation/shared/AttachmentChip.tsx:99`、`:132`、`:144` |
| P0-4 `@`／`/` provider | 引用工单、设计稿、外部知识条目、流程模板，返回可追踪资源。现 `@` 插件工具包已接入，但引用种类固定；工具包不等于任意 provider。 | `query, trigger, requestId, draftId, sessionId?, workspacePath, selectedResourceIds`；取消、分页、插入回执。 | `R/features/conversation/shared/MentionRefPicker.tsx:61`、`:79`、`:105`；`ResourcePicker.tsx:12`、`:49`；`R/features/composer/Composer.tsx:586`、`:620` |
| P0-5 子代理运行操作／详情 `subagent.actions`、`subagent.panel` | 评估当前分身、继续分派、比较输出、展示依赖。已有通用消息面板不能表达子代理运行对象。 | `rootSessionId, parentSessionId, childSessionId, rootRunId, runId, status, builtinRole, atSeq, readOnly`。 | `R/features/workspace/WorkspaceView.tsx:429`；`R/features/collaboration/SubagentsPanel.tsx:475`、`:512`、`:521` |
| P0-6 文件多选菜单／工具栏 | 批量图片处理、合并 PDF、目录检查；扩展已有 `file.context` 比另造文件列表更直接。 | `sessionId, workspaceRoot, selectedPaths[], primaryPath, bindingEpoch, selectionRevision`；保留目录／文件类型。 | `R/features/workspace/WorkspacePanel.tsx:133`、`:747`、`:771`；目前插件上下文只传单个目标。 |
| P0-7 文档预览操作／面板 | 在图片、PDF、Office 预览中 OCR、翻译、提取、转换；不能只覆盖 CodePreview。 | `resourceId, sessionId, path, mimeType, viewerKind, contentRevision, readOnly`；页码／页区间等需按预览类型定义。 | 见第 5 节工作区专项证据。 |
| P0-8 成果操作／详情面板 | 质量检查、版本比较、派生交付物、后续处理。成果是某轮交付的快照，不能等同当前路径的文件。 | `assetId, runId, assistantMessageId, itemId, sha256, sourceRevision, currentPath?, published/readOnly`。 | 见第 5 节成果专项证据。 |

## 4. P1/P2：补足日常工作流，不重复制造入口

| 优先级／区域 | 建议与用途 | 必要上下文 | 证据与边界 |
| --- | --- | --- | --- |
| P1 会话操作统一／标题栏 | 先把现有 `session.context` 复用到顶部和项目会话列表，再增加少量标题栏命令／会话 inspector；用于质量报告、工单和导出。 | `sessionId, runId?, status, agentId?, modelId?, surface`。 | `R/app/ApplicationView.tsx:597`；`R/features/sessions/TaskActions.tsx:76`；`R/features/projects/Projects.tsx:416` |
| P1 会话装饰／过滤 | 质检、待复核、关联工单等插件标记及分组过滤；不能覆盖系统运行／提问状态。每行用有界数据快照，禁止每行启动 iframe。 | `sessionId, status, archived, pinned, updatedAt, workspacePath, decorationRevision`。 | `R/features/sessions/SidebarTask.tsx:23`、`:31`；`SidebarHistory.tsx:9`、`:19`、`:108` |
| P1 Agent 对象菜单／详情 | 能力体检、提示词版本比较、基准测试、导出。现在只有固定三页编辑器和编辑／删除菜单。 | `agentId, agentRevision, builtinRole?, workspacePath, selectedForSession, locked`。 | `R/app/ApplicationView.tsx:701`；`R/features/agents/AgentManager.tsx:64`、`:920`、`:1343` |
| P1 服务详情／通知动作 | 展示阶段、失败项、进度和声明的暂停／重试。当前已提供 services、service.context；新增应补详情和通知目标，而非再建一套托盘。 | `serviceId, pluginId, instanceId, sessionId?, status, revision, notificationId?`。 | `R/features/services/ServiceTray.tsx:201`、`:207`；`R/features/extensions/services.ts:24`、`:62` |
| P1 首页任务启动器 | 图片工作流、项目分析等模板，能预填草稿与资源或打开页面。当前四个模板写死。 | `draftId, draftRevision, selectedWorkspacePath?, engineReady`；新任务可能没有 sessionId。 | `R/features/sessions/Home.tsx:12`、`:38`、`:53`；`R/app/ApplicationView.tsx:677` |
| P1 项目菜单／详情 | 项目健康、知识覆盖、需求看板、跨会话汇总。全局导航不等于选中项目上下文。 | `projectKey, workspacePath, archived, pinned, sessionIds/pageCursor, selectedCollection`。 | `R/features/projects/Projects.tsx:171`、`:265`、`:296`；`:95` 明确默认沙箱与选中项目不同。 |
| P1 变更审阅／diff | 风险分析、测试影响、审查结果；按左右版本和回执范围执行，不能拿当前文件冒充旧版。 | `changeId, sessionId, runId, path, beforeRef, afterRef, diffKind, selectionRange, readOnly`。 | 见第 5 节。 |
| P1 Git 对象／工具栏 | 按文件、提交和选区生成审查、发布说明、工单关联。需要 Git 身份，不能只复用普通 filePath。 | `repoRoot, worktreeId?, headOid, commitOid?, path?, index/worktree, selectedHunks?, refreshRevision`。 | 见第 5 节；执行写操作仍走具名 API。 |
| P1 终端／任务日志 | 解释错误、解析测试结果、日志分类；手动终端与持久后台 command job 是不同对象。 | `sessionId, terminalId? / jobId?, cwd, cursor, logRange, status`；默认读取选区／有界日志。 | 见第 5 节；没有开放任意 PTY 或原始 IPC。 |
| P1 搜索结果操作／面板 | 按检索结果做依赖分析、归纳、重构辅助；搜索 provider 属于更大能力，应另评审。 | `queryId, workspaceRoot, pattern, include/exclude, resultRevision, selectedMatches[], truncated`。 | 见第 5 节；检索结果需有界且保留版本。 |
| P1 浏览器标签／网络请求菜单 | 页面总结、API 调试、抓包导出；先支持明确选中的 tab／request。 | `tabId, sessionId?, navigationId, url, requestId?, captureRevision`；敏感请求信息需字段级限制。 | 见第 5 节；普通网页目前没有 `$AE`。 |
| P1 自动化对象／运行记录 | 计划体检、运行结果分析、失败归类、复制为业务流程。不能把插件 background 调度当作平台自动化 UI 接口。 | `automationId, automationRevision, runId?, sessionId?, targetKind, status, scheduledAt, notificationId?`。 | `R/app/ApplicationView.tsx:717`；`R/features/automations/AutomationsView.tsx:113`、`:121`；`AutomationEditor.tsx:132`、`:135` |
| P1/P2 声明式设置字段 | 从字段 Schema 生成原生设置，支持默认值、校验、字段搜索、重置、已修改与作用域覆盖。已有插件设置页和 `$AE.settings` 可复用。 | `pluginId, key, scope, effectiveValue, defaultValue, overrideSource, revision`。 | `F/src/shared/plugin-contributions.ts:43`；`R/features/extensions/interactions.ts:40`；`R/features/settings/AppSettingsView.tsx:231`、`:241`；`settings-registry.ts:297` |
| P2 自定义文件 renderer | `.flow`、图、专属结构化文件；需要文件类型选择、实例生命周期、保存冲突和安全资源协议。 | `resourceId, mimeType, path, revision, readOnly, capabilities`。 | 见第 5 节；不能把现有独立 HTML 插件页当作已支持文档接管。 |
| P2 网页划词／结构化文档区域 | 页面选区、PDF 页、表格单元格等精确操作。先定义文档语义 API，再开放菜单，避免依赖任意 DOM。 | `surfaceId, navigation/documentRevision, selectionDescriptor, origin, frameId?`。 | 见第 5 节；需独立宿主设计，不能直接向所有网页注入平台桥。 |

## 5. 工作区专项证据

工作区、文档预览、成果、Git、终端、搜索与浏览器的入口证据由同轮专项扫描汇总；本节记录有效调用链及对象边界，不把组件导出视为已开放插件能力。

| 区域 | 有效调用链与精确位置 | 结论 |
| --- | --- | --- |
| 文件与工作区 | `R/features/workspace/WorkspaceView.tsx:398` 挂 WorkspacePanel；`WorkspacePanel.tsx:133` 构造单个 filePath 的插件上下文，`:749` 内部已取得 `menu.paths` 多选，`:771` 拼入插件菜单。 | `file.context` 已开放，多选没有进入公开契约。先补已有入口的上下文，不另造文件列表。 |
| 文档预览 | `R/features/workspace/WorkspaceView.tsx:412`、`:597` 接到 ArtifactPanel；`R/features/artifacts/ArtifactPanel.tsx:413` 的 DocumentMenuProvider，`:432` 的 FilePreview、`:451` 的 CodePreview；`R/features/workspace/SourcePreview.tsx:78`、`:103` 是资料预览入口。 | 不能用 CodePreview 插件能力概括图片／PDF／Office。`R/core/editor/useDocumentContextMenu.tsx:16` 的 `getExtraItems` 和 `:106` 的拼接是内部可复用结构，不是 manifest API。 |
| 成果快照 | 会话 `R/features/conversation/ConversationView.tsx:768` 的 FinalDeliverables → `R/features/artifacts/FinalDeliverables.tsx:87` 的 FinalResult；`FinalResult.tsx:41` provider 绑定 source/session/run/asset，`:45` 是工具栏，`:58`、`:59` 分别进入 TextPreview/FilePreview。 | 独立成果 renderer，与当前工作区文件不同。`F/src/shared/final-result.ts:11`、`:12`、`:20` 包含 sha256、assetId、runId；候选操作必须保留这些身份。 |
| 变更审阅 | `R/features/workspace/WorkspaceView.tsx:393` 挂 ArtifactsWorkspace；`R/features/artifacts/SessionArtifacts.tsx:387` 批次操作、`:418` 版本选择、`:429` 单操作；`ChangeReviewActions.tsx:92`、`:105` 比较确认目标身份。 | 存在成熟内置版本／批次／确认流程，未接插件 slot。应沿用 change 身份和并发检查，避免绕过现有回退逻辑。 |
| Git／diff | `R/features/workspace/WorkspaceView.tsx:443` 开始 Git 分支；`R/features/git/GitChangesPanel.tsx:1815` 组装 fileContextItems、`:2375` 提交右键、`:2899` 实际文件菜单；`GitDiff.tsx:70` 创建独立只读 Monaco diff。 | Git 的文件／提交／diff 都没有专属插件契约，不能把 CodePreview 菜单当作已覆盖 Git。 |
| 终端／后台命令 | `R/features/workspace/WorkspaceView.tsx:441` 挂 TerminalPanel；`R/features/terminal/TerminalView.tsx:228` 固定菜单；`TerminalPanel.tsx:285` 是 job 身份与状态，`:297`／`:298` 复制及停止，`:307` 按序输出。 | `service.context` 能操作活动托盘，不等于终端选区、工具栏或日志面板已开放。 |
| 搜索 | `R/features/workspace/WorkspaceSearch.tsx:27` 把当前作用域 actions 传入 SearchPanel；`R/features/search/SearchView.tsx:39` 的 SearchPanelActions、`:63` 的 SearchPanel、`:463` 的替换预览文件列表。 | actions 是内部可复用结构；未开放结果菜单或 provider 注册。新增 provider 比增加一个结果菜单具有更大的协议范围。 |
| 浏览器／网络 | `R/features/browser/BrowserView.tsx:549` 标签菜单；`:702`／`:704`／`:706` 明确区分 PluginBrowserSurface、BrowserLocalPreview 与原生 BrowserSurface；`:733` 网络检查器、`:739` 控制台。 | 插件浏览器页已有桥，普通网页、标签菜单、网络请求和控制台没有专属插件接口。网页右键或 DOM 语义访问需要新的受控原生 bridge。 |

上表中的同名单文件续引与其最近完整路径同目录。需要自定义 `.flow` renderer 或 PDF 页／表格区域操作时，应在对应预览宿主中设计注册、解析与交互协议；现有 DocumentMenuProvider、FilePreview 的组件分支不足以证明已经具备此能力。

## 6. 扩展前必须形成的契约

1. **目标身份与范围**：统一传递宿主捕获的 source、插件修订、surface、session、workspace 绑定和对象 ID。菜单打开时保存目标快照；点击执行前验证身份仍有效。多选不能仅传一个任意拼接字符串或旧数组引用。
2. **版本与完整性**：历史消息、成果、diff、浏览器导航和日志都需要 revision／hash／cursor／atSeq。提供 `readOnly`、`completeness`、`truncated`，不得把部分加载冒充完整数据。批量作用域需要稳定 ID 列表及分页策略。
3. **权限**：沿用 manifest 声明与用户授权的交集，已安装授权绑定修订、开发模式绑定工程身份。新区域需要的内容读取和写入分离；注册菜单不自动获得文件、消息、模型、剪贴板权限。禁止插件通过 args 伪造会话／租户／宿主目标。
4. **动作与回执**：读操作、草稿修改、执行、保存／覆盖、历史变更分别定义命令和返回值。支持取消、并发版本冲突、可重试错误、部分成功；UI 不先显示成功再等真正写入。Node 的系统权限边界应在开发文档保持准确描述。
5. **生命周期**：引擎切换、插件停用、修订替换、权限撤销、开发会话关闭、目标被删和导航变化时，统一撤销菜单、快捷键、订阅、装饰与页面目标。旧异步回执不能写入新会话。页面卸载与后台任务停止是不同事件。
6. **性能**：视图默认折叠、按需挂载；列表装饰批量获取、结果有界、可取消且缓存有上限。事件只在有订阅／hook 时处理，输入／选择变化适度合并；不为每条历史消息保留 iframe 或持续读取完整日志。
7. **原生一致性**：优先复用现有菜单、Popover、Dialog、表单、焦点恢复和主题 token；紧凑单行入口、原生分组、必要的详情再展开。避免插件自行占据系统状态标记；保留键盘、无障碍标签、深浅色和减少动态效果。
8. **协议同步**：每项同时更新引擎 strict Schema／目录、前端类型、实际挂载、Node／页面适用范围、模板和公共参考。`when` 需要扩展语义而非执行任意表达式。能力发现应返回宿主支持情况，不能仅靠 TypeScript export 猜测。

## 7. 建议交付顺序与验收依据

- 第一批：上下文契约与会话菜单复用；对话批选、文件多选、附件／预览／成果操作。直接验证当前会话质检、图片处理、文档转换的完整流程。
- 第二批：工具结果 renderer、引用 provider、子代理详情、服务状态与通知动作；验证插件能利用既有平台能力，而非重复实现一个客户端。
- 第三批：首页／项目／Agent、Git／diff／终端／搜索／浏览器／自动化及声明式设置。自定义文档 renderer、普通网页桥接和搜索 provider 分别作为独立宿主能力评审。

后续每项验收至少覆盖：目标归属与修订、真实副作用、跨会话切换、撤权／停用／换版、取消或并发冲突、离开页面释放资源，以及深浅主题与键盘交互。批量场景必须验证空选／部分加载／大量目标；成果与 diff 必须验证旧快照没有被当前文件替换。所有测试使用隔离数据，临时产物放 `.e2e-tmp/`。

本报告是源码审计，不声称候选已经实现或通过运行测试。此前已有实现的验证记录另见 `E/docs/test-reports/plugin-extensions-2026-11-13.md`；本次契约核对同时确认前端 hook 类型包含 15 种事件、原生 select 上限为 256 项。公共 SDK 的正式签名仍以开发者参考及生成类型为准，不应引用本报告的候选名称作为可执行配置。

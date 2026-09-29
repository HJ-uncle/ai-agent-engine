# Aether Code × 当前引擎：能力归属、消费契约与真实差距

审计日期：2026-09-29。真实产品消费方是 `D:\dev\aether-code`，不是引擎仓库附带的 `multi-agent-console`。本文补充此前的引擎/Claude 2.1.266 比较，纠正将“引擎没有”直接等同于“产品没有”的结论。

审计基线：引擎 HEAD `770090dbd9f4857e6bb11c0d1ceef3db8c5b27d5`；IDE HEAD `2c6a74a55f42d09f7751e1142382c361c51625e6`，**IDE 有大量未提交改动，本文按当前磁盘内容审计，不能仅用 HEAD 重建结论**。本分项只读源码、未修改业务代码；主审计随后提供隔离运行验证，证据补充如下。下文源码行号对应审计时磁盘快照。

主审计验证：引擎与 IDE 构建通过，见 [engine build](/D:/dev/ai-agent-engine/docs/research/consumer-engine-build.txt)、[IDE build](/D:/dev/ai-agent-engine/docs/research/aether-code-build.txt)；真实 Electron + 引擎的子代理生命周期测试 3/3 通过，见 [E2E 日志](/D:/dev/ai-agent-engine/docs/research/aether-code-lifecycle-e2e.txt)。模型能力覆盖、回退到达顺序、后续人工修改覆盖、201 条返回 200 条，由真实 route handler + SQLite 合成数据探针验证，见 [探针代码](/D:/dev/ai-agent-engine/docs/research/audit-consumer-data-contracts.ts)、[结构化结果](/D:/dev/ai-agent-engine/docs/research/aether-code-data-contract-probe.json)。该探针不覆盖 Electron UI 或鉴权集成；回退故意控制请求到达顺序，证明顺序敏感，**不表示已经测出并发竞态发生率**。

## 1. 先修正比较口径

1. **产品已有丰富本地 Git 能力**：状态、暂存、提交、分支、拉取/推送、合并/rebase/cherry-pick、stash、tag、历史、克隆、SSH agent 等。引擎没有 Git 专用工具不能推导为 IDE 没有 Git。
2. **IDE 已启动真正的 TypeScript Language Server**，编辑器 hover/definition/references/completion 与实时诊断由本地 LSP 提供；引擎 `code_diagnose` 是另一条能力链。不能再用后者的简化实现否定整个产品有 LSP。
3. **IDE 有本地 node-pty 终端**。它是用户操作的终端，不等于模型可用的后台任务/持久 shell 工具。
4. **当前 code profile 已修复旧工具名过滤问题**，`execute_cmd/glob_search/grep_search` 按实际名称注册；旧配置名被标准化。code 的显式空 `allowedTools: []` 真的不注册工具。旧审计中对应缺陷应标记为已修复。
5. **IDE 默认 22 个 code 内置工具**，而非 general 全量口径的 46 个；允许进一步注册符合命名/来源规则的 skills/MCP 扩展。`install_package`、记忆、cron/agent/task 管理工具默认不在 IDE 模型工具面中。
6. **IDE 拉起的 embedded 引擎显式绑定 `127.0.0.1`**。引擎独立启动的默认监听地址与 IDE 嵌入式启动要分别讨论。

## 2. 能力归属矩阵

分类：**本地**表示 Electron/renderer 自主完成；**引擎**表示产品消费 REST/SSE；**混合**表示两侧共同完成；**未接 UI**表示有实现/API，但不能按可用界面能力计分。

| 能力 | 归属与当前实际状态 | 证据 |
|---|---|---|
| 文件树、读写、新建、重命名、复制、回收站 | 本地 FileService + IPC；与模型 workspace 权限独立 | [file-service.ts:87](/D:/dev/aether-code/src/main/fs/file-service.ts:87)、[file-service.ts:216](/D:/dev/aether-code/src/main/fs/file-service.ts:216)、[ipc.ts:143](/D:/dev/aether-code/src/main/ipc.ts:143) |
| Monaco 编辑器、脏标记、保存、视图位置、选区加入对话 | 本地；保存后另触发引擎诊断 | [MonacoEditor.tsx:58](/D:/dev/aether-code/src/renderer/src/contrib/editor/MonacoEditor.tsx:58)、[editor-store.ts:293](/D:/dev/aether-code/src/renderer/src/core/editor/editor-store.ts:293) |
| 全工作区搜索/替换/替换预览 | 本地；git grep 与文件扫描回退；正则/大小写/整词/排除规则；500 命中、扫描文件 512 KiB 等上限 | [search-service.ts:40](/D:/dev/aether-code/src/main/search/search-service.ts:40)、[search-service.ts:89](/D:/dev/aether-code/src/main/search/search-service.ts:89)、[search-service.ts:108](/D:/dev/aether-code/src/main/search/search-service.ts:108)、[search-service.ts:162](/D:/dev/aether-code/src/main/search/search-service.ts:162) |
| Git 工作区与暂存区状态/增删统计/差异数据 | 本地 Git CLI；已接 Git 面板 | [git-service.ts:322](/D:/dev/aether-code/src/main/git/git-service.ts:322)、[git-service.ts:591](/D:/dev/aether-code/src/main/git/git-service.ts:591)、[GitChangesPanel.tsx:342](/D:/dev/aether-code/src/renderer/src/contrib/git/GitChangesPanel.tsx:342) |
| Git 暂存/取消暂存/批量/丢弃/hunk 丢弃 | 本地 API 与 Git 面板；编辑器内 hunk 操作尚未接宿主 | [git-service.ts:648](/D:/dev/aether-code/src/main/git/git-service.ts:648)、[git-service.ts:747](/D:/dev/aether-code/src/main/git/git-service.ts:747)、[git-service.ts:814](/D:/dev/aether-code/src/main/git/git-service.ts:814) |
| Git 提交/amend/撤回提交/空提交/gitignore | 本地；提交信息可额外走引擎轻任务模型，失败有本地规则回退 | [git-service.ts:862](/D:/dev/aether-code/src/main/git/git-service.ts:862)、[git-service.ts:975](/D:/dev/aether-code/src/main/git/git-service.ts:975)、[GitCommitBar.tsx:130](/D:/dev/aether-code/src/renderer/src/contrib/git/GitCommitBar.tsx:130) |
| Git fetch/pull/push/sync/force push/remote 管理 | 本地；支持 merge/rebase 拉取策略与指定远端/分支 | [git-service.ts:1045](/D:/dev/aether-code/src/main/git/git-service.ts:1045)、[git-service.ts:1139](/D:/dev/aether-code/src/main/git/git-service.ts:1139)、[git-service.ts:1270](/D:/dev/aether-code/src/main/git/git-service.ts:1270) |
| Git branch/merge/rebase/cherry-pick/revert 及中止 | 本地 | [git-service.ts:1320](/D:/dev/aether-code/src/main/git/git-service.ts:1320)、[git-service.ts:1386](/D:/dev/aether-code/src/main/git/git-service.ts:1386)、[git-service.ts:1446](/D:/dev/aether-code/src/main/git/git-service.ts:1446) |
| Git stash/tag/log/incoming/commit show/file history/blame | 本地 API；历史图/提交详情已有 UI，blame/file timeline 编辑器联动未接 | [git-service.ts:1458](/D:/dev/aether-code/src/main/git/git-service.ts:1458)、[git-service.ts:1598](/D:/dev/aether-code/src/main/git/git-service.ts:1598)、[git-service.ts:1708](/D:/dev/aether-code/src/main/git/git-service.ts:1708)、[git-service.ts:1976](/D:/dev/aether-code/src/main/git/git-service.ts:1976) |
| Git 克隆与 SSH agent | 本地服务 + 克隆进度/取消 IPC；不是引擎工具 | [ipc.ts:39](/D:/dev/aether-code/src/main/ipc.ts:39)、[ipc.ts:304](/D:/dev/aether-code/src/main/ipc.ts:304) |
| Git diff 编辑器、gutter、行内 blame | **未接 UI**：列表点击加载 diff 后打开普通文件；完整行内 diff 组件保留但未挂载 | [GitChangesPanel.tsx:482](/D:/dev/aether-code/src/renderer/src/contrib/git/GitChangesPanel.tsx:482)、[GitInlineDiffWidget.tsx:9](/D:/dev/aether-code/src/renderer/src/contrib/git/GitInlineDiffWidget.tsx:9)、[git-store.ts:1388](/D:/dev/aether-code/src/renderer/src/core/git/git-store.ts:1388) |
| Git worktree 创建/删除/隔离执行 | 本轮未找到对应生命周期 API；`discardWorktree` 等指普通工作树内容，不能算 `git worktree add/remove` | [git-client.ts:51](/D:/dev/aether-code/src/renderer/src/core/git/git-client.ts:51)、[git-service.ts:775](/D:/dev/aether-code/src/main/git/git-service.ts:775) |
| 人工交互终端 | 本地 node-pty；Windows powershell、Unix shell；输入/resize/dispose；继承用户环境 | [pty-service.ts:17](/D:/dev/aether-code/src/main/terminal/pty-service.ts:17)、[pty-service.ts:30](/D:/dev/aether-code/src/main/terminal/pty-service.ts:30)、[ipc.ts:400](/D:/dev/aether-code/src/main/ipc.ts:400) |
| TypeScript/JavaScript 语言服务 | 本地真实 typescript-language-server + JSON-RPC；自动跟随工作区启动 | [server.ts:37](/D:/dev/aether-code/src/main/lsp/server.ts:37)、[ipc.ts:424](/D:/dev/aether-code/src/main/ipc.ts:424)、[bootstrap.ts:18](/D:/dev/aether-code/src/renderer/src/bootstrap.ts:18) |
| Hover/定义/引用/补全 | 本地 LSP 已注册四类 Monaco provider | [ts-client.ts:262](/D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:262)、[ts-client.ts:288](/D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:288)、[ts-client.ts:312](/D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:312)、[ts-client.ts:332](/D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:332) |
| 重命名/符号/签名/代码动作等 LSP UI | 没有相应新 provider；内置 TS 的 rename/signature/symbol 等反而在 LSP 启用后关闭，见下文缺口 | [ts-client.ts:45](/D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:45)、[ts-client.ts:453](/D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:453) |
| Problems 面板与保存诊断 | 引擎 `/lsp/diagnose` 结果进入 Problems；本地 LSP 只画 marker，尚未统一 | [diagnostics.ts:58](/D:/dev/aether-code/src/renderer/src/core/lsp/diagnostics.ts:58)、[problems-store.ts:4](/D:/dev/aether-code/src/renderer/src/core/lsp/problems-store.ts:4) |
| Agent 对话、工具执行、提问/审批、子代理 | 引擎 SSE/REST；本地有相应卡片、历史和应答适配 | [useChat.ts:584](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:584)、[useChat.ts:695](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:695)、[pending.ts:111](/D:/dev/aether-code/src/renderer/src/core/engine/pending.ts:111) |
| 停止执行 | 本地断 SSE 后另 POST `/chat/cancel`；不是只断 UI 连接 | [useChat.ts:733](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:733) |
| Agent 改动 diff、保留、撤回、暂存 | 混合：引擎快照及回退、本地 diff 计算、本地 git add；非工作区事务快照 | [ChangesPanel.tsx:24](/D:/dev/aether-code/src/renderer/src/contrib/chat/ChangesPanel.tsx:24)、[ChangesPanel.tsx:127](/D:/dev/aether-code/src/renderer/src/contrib/chat/ChangesPanel.tsx:127)、[ChangesPanel.tsx:155](/D:/dev/aether-code/src/renderer/src/contrib/chat/ChangesPanel.tsx:155) |
| 模型 CRUD/连通测试/能力推断、主/子/轻任务模型 | 引擎；IDE 有模型管理和选择 UI，能力编辑只开放部分字段 | [models.ts:105](/D:/dev/aether-code/src/renderer/src/core/engine/models.ts:105)、[ModelFormDialog.tsx:199](/D:/dev/aether-code/src/renderer/src/contrib/models/ModelFormDialog.tsx:199)、[useChat.ts:588](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:588) |
| 安全模式与策略规则管理 | 引擎会话模式 + 全局策略；IDE 有选择器与规则 UI，存在状态/语义错位 | [security.ts:118](/D:/dev/aether-code/src/renderer/src/core/engine/security.ts:118)、[security-store.ts:58](/D:/dev/aether-code/src/renderer/src/core/engine/security-store.ts:58) |
| CodeGraph 状态/构建索引/模型查询 | 引擎；IDE 设置页与对话页已接 status/index，发送工作区路径 | [CodeGraphSettingsView.tsx:75](/D:/dev/aether-code/src/renderer/src/contrib/settings/CodeGraphSettingsView.tsx:75)、[ChatView.tsx:901](/D:/dev/aether-code/src/renderer/src/contrib/chat/ChatView.tsx:901) |
| Skills/MCP | 引擎预配置的扩展可进入 code 工具面；IDE 尚无专门管理界面，不能把引擎管理页算成 IDE 已接入 | [tool-profile.ts:34](/D:/dev/ai-agent-engine/src/tools/tool-profile.ts:34)、[AppSettingsView.tsx:41](/D:/dev/aether-code/src/renderer/src/contrib/settings/AppSettingsView.tsx:41) |
| 记忆/Agent CRUD/定时任务/通用后台任务管理 | 引擎 general 能力；IDE code profile 主动排除对应模型工具，界面未见专门管理页 | [tool-profile.ts:28](/D:/dev/ai-agent-engine/src/tools/tool-profile.ts:28)、[chat.ts:864](/D:/dev/ai-agent-engine/src/api/http/routes/chat.ts:864) |

### 2.1 当前 code 的完整 22 个内置工具

```text
read_file       write_file       list_files       delete_file       create_dir
glob_search     grep_search      execute_cmd      code_diagnose     codegraph
subagent        todo_list        todo_create      todo_update       todo_delete
list_skills     get_skill        run_skill_script
web_fetch       http_request     ask_user         get_current_context
```

来源：[tool-profile.ts:20](/D:/dev/ai-agent-engine/src/tools/tool-profile.ts:20)。`edit_file` 虽仍在 IDE 中文展示映射中，却不在这里；展示字符串不能当已注册工具。`task_*` 被排除也不代表子代理任务记录不存在，要按各自子代理协议判断。

IDE 普通 HTTP 与 SSE 都发送 `X-Aether-Tool-Profile: code`：[tool-profile.ts:2](/D:/dev/aether-code/src/main/engine/tool-profile.ts:2)、[client.ts:53](/D:/dev/aether-code/src/main/engine/client.ts:53)、[host.ts:408](/D:/dev/aether-code/src/main/engine/host.ts:408)。引擎在 registry 注册处做硬过滤，显式工具列表与 profile 相交：[registry-factory.ts:117](/D:/dev/ai-agent-engine/src/tools/registry-factory.ts:117)、[registry.ts:8](/D:/dev/ai-agent-engine/src/core/tool-registry/registry.ts:8)。command/glob/grep 注册名称已经统一：[registry-factory.ts:202](/D:/dev/ai-agent-engine/src/tools/registry-factory.ts:202)、[registry-factory.ts:266](/D:/dev/ai-agent-engine/src/tools/registry-factory.ts:266)。

profile 已传播到 chat、消息编辑/重生成、Flow 和 subagent；code 会跳过内联长期记忆、长期记忆召回和后台写入。它是**能力选择契约**，不是 OS 沙箱，也不会自动关闭该 HTTP 客户端可调用的管理端点。MCP/skill 扩展数量不能预先固化为 22。

## 3. 确认存在的契约断链

### 3.1 P1：标准模式实际取消路径边界，但 UI 只警示完全访问

引擎 [workspace/manager.ts:45](/D:/dev/ai-agent-engine/src/workspace/manager.ts:45) 对任何非 `safe` 模式直接返回解析后的路径，因此 `standard` 与 `full-access` 均不受 workspace 包含检查。IDE [security.ts:63](/D:/dev/aether-code/src/renderer/src/core/engine/security.ts:63) 的标准模式文案只谈命令确认；[security.ts:112](/D:/dev/aether-code/src/renderer/src/core/engine/security.ts:112) 的 `isRiskyMode` 仅认 full-access，只有后者提供“读写工作区外文件”提示。

实际影响：用户从 safe 选 standard 时，文件工具权限也扩大，但界面没有告知。必须由引擎明确返回结构化权限能力，例如命令审批、路径范围、网络范围，避免两个仓库各自猜测安全模式语义。

### 3.2 P1：已确认执行仍可能被旧白名单拒绝

IDE 审批回传使用被拦截的真实工具名及严格 `approved/rejected` 值，且续跑保留工作区/模型：[pending.ts:219](/D:/dev/aether-code/src/renderer/src/core/engine/pending.ts:219)、[useChat.ts:718](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:718)。因此不能笼统归因为 UI 不会审批。

引擎 [cmd-tool.ts:43](/D:/dev/ai-agent-engine/src/tools/cmd/cmd-tool.ts:43) 策略层允许后，[cmd-tool.ts:74](/D:/dev/ai-agent-engine/src/tools/cmd/cmd-tool.ts:74) 在 safe 模式仍独立检查旧命令白名单。若命令经会话审批通过但不在旧白名单，实际仍失败。这是引擎内部“审批允许”与“执行允许”不一致，会诱导用户将整个会话升为更高权限。

### 3.3 P1：批量撤回对同文件逐操作快照并发执行，不能保证恢复原点

引擎 `ChangeStore.record` 为每次操作写新行；[ChangeStore.list:119](/D:/dev/ai-agent-engine/src/storage/changes/index.ts:119) 按时间倒序返回最多 200 行，未按文件聚合。单条撤回 [changes.ts:42](/D:/dev/ai-agent-engine/src/api/http/routes/changes.ts:42) 直接将 `oldContent` 写回路径。

IDE [ChangesPanel.tsx:194](/D:/dev/aether-code/src/renderer/src/contrib/chat/ChangesPanel.tsx:194) 的“全部撤回”用 `Promise.allSettled` 并发逐 id POST。对于同一文件 `A→B→C` 两条快照，若恢复 A 先执行、恢复 B 后执行，最终得到 B，却两条记录都可标为已撤回。数组倒序不等于网络请求/数据库 await/文件落盘有顺序保障。超过 200 条时，“全部”也只撤回展示集合。

另有边界：单条撤回不比较当前文件是否仍等于记录中的 `newContent`，会覆盖后续人工编辑；IDE 已有确认对话框，不能说没有确认，但确认不能代替冲突检测。建议引擎提供按 session/path 聚合、按版本验证、服务端有序执行的批量 revert；再让 UI 显示影响文件和冲突。

主审计隔离探针实证：同文件初始 A、当前 C，oldest-first 到达最终 B，newest-first 到达最终 A；`USER EDIT AFTER AGENT` 被写回 A 且业务码 200、无冲突标记；保存 201 条仅返回 200 条。见 [data contract probe](/D:/dev/ai-agent-engine/docs/research/aether-code-data-contract-probe.json)。这是受控顺序验证，不是 UI 并发复现率测量。

### 3.4 P1：编辑模型普通字段会丢失未展示的能力覆盖

IDE 类型能表达 vision/video/audio/thinking/toolCalling/parallelTools/jsonMode/search/caching/streamUsage/prefix/contextWindow：[models.ts:15](/D:/dev/aether-code/src/renderer/src/core/engine/models.ts:15)。但 [ModelFormDialog.tsx:199](/D:/dev/aether-code/src/renderer/src/contrib/models/ModelFormDialog.tsx:199) 只重建 vision/thinking；[ModelFormDialog.tsx:232](/D:/dev/aether-code/src/renderer/src/contrib/models/ModelFormDialog.tsx:232) 每次保存都提交这个部分对象或 null。引擎 [sqlite/models.ts:145](/D:/dev/ai-agent-engine/src/storage/sqlite/models.ts:145) 整体替换 JSON，不做字段合并。

可复核场景：模型原来配置 `contextWindow: 128000, parallelTools: false`，用户只改显示名称并保存；这两个覆盖值被删除，后续能力解析回退到默认推断。影响上下文用量与实际压缩/工具协议等判断，取决于引擎各能力消费位置。建议表单保留原对象，只 patch 显式编辑字段，并区分“未改”“设 false”“恢复自动”。不能把“有一个能力探测按钮”计作全部能力已完整管理。

主审计已用真实模型路由/SQLite 验证：原对象包括 `contextWindow:123456/toolCalling/parallelTools/streamUsage`，按表单形状提交仅有 vision/thinking 后，其余覆盖字段全部消失，见 [data contract probe](/D:/dev/ai-agent-engine/docs/research/aether-code-data-contract-probe.json)。

### 3.5 P2：安全模式缓存跨会话请求竞态

[security-store.ts:58](/D:/dev/aether-code/src/renderer/src/core/engine/security-store.ts:58) 切 B 会话先更新 state，但 [security-store.ts:64](/D:/dev/aether-code/src/renderer/src/core/engine/security-store.ts:64) 复用一个全局 inflight：A 的 GET 未完成时切 B，B 不发请求；A 返回后因 session 不符被丢弃，B 可能长期保留 `safe/loading`。另外 [security-store.ts:87](/D:/dev/aether-code/src/renderer/src/core/engine/security-store.ts:87) 模式修改失败回滚不验证当前 session，旧请求可回滚新会话 UI。

这是显示状态/可操作性问题；没有证据证明它改变了引擎真实模式。修复应按 session 缓存 inflight、加入请求代次，并让未知状态显示“未确认”，不要以 safe 代替未知。

### 3.6 P2：本地 LSP 接通后仍缺完整语言服务与诊断汇聚

- 真 LSP 成功后 [ts-client.ts:45](/D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:45) 关闭内置 documentHighlights/documentSymbols/rename/signatureHelp，但只注册 hover/definition/references/completion；这些功能没有对应补位。
- 补全 [ts-client.ts:359](/D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:359) 未映射 `textEdit/additionalTextEdits`，没有 `completionItem/resolve`，只插入 insertText/label；不能按完整自动导入/补全能力计分。
- 本地 `publishDiagnostics` 只写 `tsserver` marker：[ts-client.ts:207](/D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:207)。Problems store 只由引擎诊断写入：[diagnostics.ts:69](/D:/dev/aether-code/src/renderer/src/core/lsp/diagnostics.ts:69)。因此编辑器红线与 Problems 列表不是同一套数据。
- `lspRequest` 没有超时、取消和发送失败清理：[ts-client.ts:77](/D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:77)；退出回调不 reject pending 请求：[ts-client.ts:419](/D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:419)；stop 等待无界 shutdown：[ts-client.ts:474](/D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:474)。语言服务无响应时，换工作区/停止存在挂起风险。

建议把“编辑器语言服务 provider”“Problems 统一模型”“供模型调用的语言工具”分开验收。补齐 UI LSP 不会自动让 Agent 获得 find-references/rename 等工具；后者需要独立工具/API 契约。

### 3.7 远程模式：没有工作区映射、身份配置或能力握手

远程连接只以 `/health` 和版本读取进入 ready：[host.ts:106](/D:/dev/aether-code/src/main/engine/host.ts:106)。业务 HTTP/SSE 仅有 Accept/Content-Type/profile header，没有 JWT/API key 入口：[client.ts:53](/D:/dev/aether-code/src/main/engine/client.ts:53)、[host.ts:408](/D:/dev/aether-code/src/main/engine/host.ts:408)。

必须精确区分：**当前引擎没有凭据也会回退到 default 租户/method:none**，见 [auth/middleware.ts:27](/D:/dev/ai-agent-engine/src/auth/middleware.ts:27)；不能声称“开启 AUTH_ENABLED 就必然拒绝 IDE”。真实消费缺口是 IDE 无法选择认证租户/角色，也无法连接强制 JWT/API key 的外部网关；缺凭据放行则是引擎自身的安全边界问题。

文件身份更直接：本地 root 经 [workspace-store.ts:340](/D:/dev/aether-code/src/renderer/src/core/workspace/workspace-store.ts:340) 直接送入 `workspacePaths`：[useChat.ts:589](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:589)。附件先写本地 `.aether/attachments`：[file-service.ts:241](/D:/dev/aether-code/src/main/fs/file-service.ts:241)，聊天只发相对文件名：[useChat.ts:594](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:594)。CodeGraph、诊断也发本地绝对路径。没有发现文件同步、remote root 映射、SSHFS 或远端文件 API 接管编辑器的实现。

因此远程模式仅在两端能访问一致路径和内容时可自然成立；跨主机/不同 OS 不能视为完整 Remote IDE。Agent 修改在远端，而 Git 暂存 [ChangesPanel.tsx:163](/D:/dev/aether-code/src/renderer/src/contrib/chat/ChangesPanel.tsx:163) 在本地，更需要明确 workspace identity。

能力握手也缺失：当前引擎理解 profile；旧引擎若忽略这个 header，可能返回 general 工具面。IDE 的健康/版本检查没有对 profile support、协议版本、workspace identity 做强制协商。不要把源码中的 header 视为所有安装运行时都已生效的证明。

### 3.8 需要保留但不应夸大的兼容风险

- `pending.ts` 支持多问题 `questions` 的 ask 帧，但 permission 别名分类只检查 `args.question || args.options`：[pending.ts:118](/D:/dev/aether-code/src/renderer/src/core/engine/pending.ts:118)。未来引擎若只发 `questions`，第二个别名帧会被当成 permission 并覆盖已解析提问。**当前** [ask-user/index.ts:13](/D:/dev/ai-agent-engine/src/tools/ask-user/index.ts:13) 公布的是单问题 schema，故这是新旧协议升级风险，不算当前正常 schema 必现故障。
- `createModel` 自动启用的第二次 PUT 没检查业务 `ok`，仍返回 `isEnabled:true`：[models.ts:120](/D:/dev/aether-code/src/renderer/src/core/engine/models.ts:120)。目前 UI 不暴露启用开关，影响小于能力覆盖丢失，但说明需要结构化失败契约。
- 工具中文名是本地静态表，并非服务端 metadata：[tool-names.ts:9](/D:/dev/aether-code/src/renderer/src/contrib/chat/tool-names.ts:9)。新增/改名影响渲染、文件跳转、历史回放和 pending 真实名称；应保留 canonical name 与 displayName 的区别。

## 4. 权限边界不能互相代算

| 层 | 当前边界 | 审计含义 |
|---|---|---|
| 本地人工文件操作 | FileService allowRoot + lexical `path.resolve/relative`；未看到 realpath 检查；目录列表会跟随 symlink stat | 本地边界可被符号链接/目录联接实际落点影响，见 [file-service.ts:96](/D:/dev/aether-code/src/main/fs/file-service.ts:96)、[file-service.ts:138](/D:/dev/aether-code/src/main/fs/file-service.ts:138)；不把用户手动允许根目录直接当成模型绕过权限 |
| 本地 Git | `execFile` 执行 Git，cwd 经过 FileService allowed root；Git 自身读配置/凭据 | [git-service.ts:235](/D:/dev/aether-code/src/main/git/git-service.ts:235)、[git-service.ts:274](/D:/dev/aether-code/src/main/git/git-service.ts:274)；人工 Git 权限不由引擎 safe 控制 |
| 本地人工终端 | 用户 shell、继承环境、输入直接发 PTY | 这是 IDE 用户能力；不能当作 Agent 已有沙箱/后台任务权限语义 |
| 模型文件工具 | 引擎 workspace + session security mode | `standard` 已取消路径包含约束；lexical 路径检查不等于 OS 隔离 |
| 模型 execute_cmd | 策略裁决 + safe 旧白名单 + cwd 检查；非 full-access 缩减环境；子进程树取消已实现 | 当前 [cmd-tool.ts:107](/D:/dev/ai-agent-engine/src/tools/cmd/cmd-tool.ts:107) 已有环境区分与取消，不能照搬旧命令生命周期结论；命令参数实际能访问的文件仍不由 cwd 限定 |
| Code profile | 注册时过滤工具；传递到子代理等调用链 | 不负责进程沙箱、文件系统隔离、管理 API 鉴权，也不自动约束每个 MCP/skill 的外部权限 |
| 嵌入式引擎网络 | IDE spawn 设置 HOST=127.0.0.1 | [host.ts:203](/D:/dev/aether-code/src/main/engine/host.ts:203)；独立启动/远程/复用进程另行评估 |

## 5. 对 Claude 能力比较应如何调整

| 原来可能得出的结论 | 经真实消费端审计后的准确结论 |
|---|---|
| 缺 Git | 产品已具备广泛人工 Git 工作流；主要缺 Git diff/gutter 宿主、Git worktree 生命周期，以及 Agent 可审计的专用 Git/隔离接口 |
| 没有真正 LSP | IDE 有真 TS LSP；缺完整 provider、可靠 lifecycle/diagnostics 汇聚、给 Agent 用的语言服务工具；不同语言覆盖仍需单独评估 |
| 缺终端 | IDE 有人工 PTY；Agent `execute_cmd` 与 Claude 的持久 shell/后台任务能力仍应独立比较 |
| 全部工具默认暴露给 IDE | 当前默认 code 是 22 内置工具，按 profile/allowlist 硬过滤；general 服务管理工具未进入模型面 |
| 没有改动审查/撤回 UI | 已有聊天 diff/keep/revert/stage；缺同文件有序批量回退、版本冲突保护、统一 Git diff 宿主和工作区级事务快照 |
| 权限只是前端开关 | 引擎确实执行策略与模式；当前问题是 UI 语义不一致、审批与旧白名单冲突、跨会话缓存竞态、进程隔离不足 |
| 连接远端即等于远程开发 | 目前是远程 HTTP 引擎连接；缺工作区文件身份/映射同步、鉴权配置和能力协商 |
| 引擎有 Skills/MCP 管理即产品已完整支持 | 产品可消费已配置扩展，但 IDE 尚无相应管理页和完整安装/信任/状态流程 |

与 Claude 2.1.266 比较时，每项至少分“CLI/模型可调用”“IDE 用户可用”“后端 API 存在”“产品 UI 已接入”四个维度。后端广度、IDE 交互广度和代理自主完成任务的能力不是同一个分数。

## 6. 建议优先级与验收边界

1. **先修真实断链**：standard 路径语义、批准后白名单冲突、批量回退顺序与当前内容校验、模型 capability patch、session 安全状态竞态。
2. **固定跨仓契约**：统一 version/capabilities 握手；profile 生效结果、canonical 工具名、workspace identity、鉴权方式、pending schema 明确返回。测试覆盖真实 consumer 请求与引擎响应，避免只各测各的 mock。
3. **完成已有能力闭环**：Git diff/gutter 挂载；LSP 超时/退出清理、缺失 provider、诊断进入统一 Problems。已有 API/组件先接完整，再计作新增产品能力。
4. **再做独立能力提升**：Agent 可用的 LSP 工具、Git worktree 隔离、持久 shell/background job、Skills/MCP 管理。不要重复重写 IDE 已存在的本地 Git/PTY。

本文包含静态审计与上文明确列出的主审计隔离探针结果，其余问题不宣称已有运行复现。后续验收应覆盖：UI 同文件 A→B→C 的并发撤回、>200 次改动；快速 A→B 切会话；只改模型显示名后 capability 完整保留；safe 批准非旧白名单命令；standard 访问工作区外文件时准确提示；LSP 进程无响应/退出/快速换根；Windows IDE 连接 Linux 引擎时工作区能力协商。

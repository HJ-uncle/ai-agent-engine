# Aether Code 全功能覆盖与差距审计

日期：2026-09-30  
被审计项目：D:\dev\aether-code  
报告文件：D:\dev\ai-agent-engine\docs\research\2026-09-30-aether-final-coverage-gaps.md

## 结论

当前项目的 261 项本地 E2E 已全部通过，但仍没有达到“所有外部能力全部对齐”：已有测试对引擎生命周期、协议身份、会话恢复、根运行/审批、流式输出、子代理、后台命令、精确编辑、文件系统与搜索 IPC、安全模式、Git 服务层、终端能力和主要工作台路径提供了真实证据；Git UI 深层操作、MCP OAuth/stdio/resources、真实第三方 provider、完整 LSP provider、附件/mentions 组合和安装升级仍需要独立环境验证。

当前检出的 Playwright 测试清单为 32 个 spec 文件、261 个测试。使用的命令：

    cd D:\dev\aether-code
    npx playwright test --list

输出为 Total: 261 tests in 32 files。随后已在单 worker、提升 Windows 进程权限下实际执行：**261/261 passed，0 failed，0 skipped**；独立 smoke **39/39 passed**。完整证据见 `2026-09-30-aether-code-e2e-full-definitive.txt` 与 `2026-09-30-aether-code-smoke-final-clean.txt`。

覆盖等级定义：

- A：真实运行证据（真实 Electron/引擎/HTTP/IPC/文件系统或 Playwright UI 路径）。
- B：契约/纯函数证据（协议投影、解析器、状态机、schema 或纯函数测试，不能证明完整用户路径）。
- C：当前没有足够测试证据（只看到实现、间接调用或局部冒烟）。

## 32 个 spec 的当前证据

| spec | 测试数 | 覆盖范围 | 等级 | 结论 |
|---|---:|---|:---:|---|
| change-revert-contract.spec.ts | 10 | 全量/单条回退选择、冲突/缺失/失败保留历史、临时 ID、批量文件分组 | B | 服务端回退契约充分，不能替代 UI |
| change-revert-ui.spec.ts | 3 | 文件回退真机闭环、冲突/缺失快照、保留改动与结果查看 | A | 回退主路径有真实证据 |
| chat-recovery-contract.spec.ts | 6 | SSE 解析、消费游标、原子投影、附件/todo/改动快照、稳定 ID | B | 恢复协议覆盖充分 |
| chat-recovery-ui.spec.ts | 3 | 思考/工具增量刷新、重启恢复、取消语义、附件待办改动恢复 | A | 快照和恢复主路径有证据 |
| command-job-contract.spec.ts | 10 | 后台任务 schema、派发/归属、游标、过期输出、终态原因 | B | 状态边界覆盖充分 |
| command-job-store.spec.ts | 3 | 切换会话、清空、取消失败、过期输出 | B | store 状态覆盖充分 |
| command-job-ui.spec.ts | 6 | 真实命令、stdout/stderr、刷新/切会话、停止、退出码/超时、子代理归属、引擎退出、404 | A | 后台命令闭环有真实证据 |
| diagnostics-state.spec.ts | 1 | LSP 诊断 failure/empty/cancel 状态语义 | B | 只证明状态纯函数 |
| edit-file-ui.spec.ts | 3 | 精确编辑、版本冲突、重复匹配拒绝、diff/回退 | A | 编辑安全主路径有真实证据 |
| engine-host-contract.spec.ts | 6 | dev sibling 引擎、端口占用、取消启动、远端握手、token、工作区边界 | A | D0 运行时身份与远端边界有证据 |
| engine-storage-contract.spec.ts | 8 | 密钥迁移/损坏、入口选择、打包运行时路径、握手信封 | B | 存储/运行时契约有证据，未证明打包应用 |
| git-parsers.spec.ts | 14 | status/log、ahead/behind、重命名、分离 HEAD、异常输出解析 | B | 解析器覆盖充分 |
| git-service-matrix.spec.ts | 8 | preload 直连 Git 全流程：状态、index、diff/hunk、commit、branch/tag、stash、merge/rebase/cherry-pick/revert、remote/clone/progress | A | 服务层接近完整；源码 inventory 断言 80 个 invoke 方法且未覆盖列表为空 |
| history-replay.spec.ts | 3 | 首次启动、历史消息/思考/工具回放、删除后不复活 | A | 历史数据主流程有证据 |
| lsp-diagnostics.spec.ts | 4 | TS 文件保存→诊断→Problems→跳转、unsupported extension、不误报、renderer 错误检查 | A | 只覆盖诊断主路径 |
| model-config-ui.spec.ts | 3 | 模型改名、vision/thinking overrides 无损保存 | A | 表单无损编辑有证据；provider 流程未覆盖 |
| model-form-contract.spec.ts | 6 | override 合并、显式 false/null、脱敏密钥、默认状态 | B | 表单转换契约覆盖充分 |
| narrow-chat-layout.spec.ts | 3 | 280px/最小窗口布局按钮可见 | A | 窄布局有证据 |
| pending-interactions.spec.ts | 12 | permission/ask 帧归一化、合并、响应值、多选 | B | 交互协议覆盖充分 |
| platform-feature-matrix.spec.ts | 11 | FS CRUD/binary/truncate/attachments/越界/junction、search scan/git/replace、settings 重启、window IPC、PTY | A | 平台 IPC 矩阵覆盖强；原生 picker 仍缺 |
| pure-functions.spec.ts | 37 | 文件类型/base64/hex、Git 展示、排除规则与 pathspec | B | 纯函数覆盖充分 |
| remote-connection-contract.spec.ts | 1 | 手动本机开发地址免 token、非本机要求凭据 | B | 仅契约，未覆盖完整远端 UI |
| root-run-contract.spec.ts | 7 | optimistic ID、版本、done/failure、历史恢复、审批记录、工具终态 | B | 根运行协议覆盖充分 |
| root-run-ui.spec.ts | 5 | 多轮运行、刷新后审批、safe 命令批准/拒绝、切会话、provider 失败/重启 | A | 根运行主路径有证据 |
| security-client.spec.ts | 11 | 三种模式、非法值、payload、元数据与风险提示 | B | 客户端纯状态契约充分 |
| security-mode-lifecycle.spec.ts | 3 | A/B 会话模式切换、对话/设置写入、异常退出后 unknown | A | 安全模式 UI 生命周期有证据 |
| security-state.spec.ts | 8 | 跨会话/跨代请求、PUT/GET 竞态、重置、未知值 | B | 状态机边界覆盖充分 |
| smoke.spec.ts | 39 | 工作台、资源管理器、编辑器、引擎、安全、终端、多选/拖拽、预览、Git 入口、命令面板、Quick Open、搜索/替换、快捷键、标签页 | A | 主工作台覆盖广，但复杂面板多只验证入口 |
| streaming-model-contract.spec.ts | 5 | model-only、usage 去重、正文/工具顺序、实际模型、provider failure | B | 流式模型协议覆盖充分 |
| streaming-model-ui.spec.ts | 4 | 真流式、刷新接续、工具前正文、fallback、断开失败 | A | 流式主路径有证据 |
| subagent-lifecycle.spec.ts | 3 | 真实引擎/HTTP/IPC 子代理成功、独立取消、历史/重启/导出 | A | 子代理生命周期有证据 |
| subagent-state.spec.ts | 15 | 协议身份/seq、400 失败、取消、归属、迟到事件、历史与用量 | B | 子代理状态边界覆盖充分 |

## Preload 能力清单与证据

读取 src/preload/index.ts 后，当前 API 域为：

| API 域 | 暴露能力 | 当前证据 | 主要缺口 |
|---|---|---|---|
| engine | snapshot、start/stop/restart、request、stream.start/abort、snapshot/log/stream events | engine-host、root-run、chat-recovery、streaming、subagent UI/contract | 完整错误注入、跨 renderer 组合场景仍需执行型回归 |
| settings | get/update | platform matrix、security/settings UI 局部 | Appearance/Engine/CodeGraph 全 UI 操作缺少 |
| fs | pickFolder、allowRoot、readDir/readFile/writeFile/createFile/createFolder/rename/copy/trash/stat/listAll/copyIntoWorkspace | platform matrix + smoke | 原生 pickFolder/打开文件夹对话框无真实测试；allowRoot 主要间接使用 |
| git | 80 个 invoke 方法、onCloneProgress | git-service-matrix + smoke | GitView UI 操作几乎未覆盖 |
| search | query/replace/preview | platform matrix + smoke 搜索/替换 | 更多 UI 错误/取消/大规模结果路径需补 |
| terminal | create/write/resize/dispose、data/exit events | smoke + platform matrix PTY | 多 shell/崩溃/权限限制分支不完整 |
| lsp | start/stop/send、message/exit events | lsp diagnostics | 只注册 TS/JS/TSX/JSX，未覆盖完整 provider 行为 |
| window | minimize/toggleMaximize/close/isMaximized | platform matrix maximize/restore/minimize | close 未直接测试（避免关闭 runner） |

## 仍未被完整证明的用户功能

### Git UI（服务层已齐，UI 未齐）

smoke.spec.ts 只证明状态栏入口、仓库信息和文件树角标。没有 UI 动作覆盖：

- stage/unstage、discard；
- commit、commit amend、提交建议；
- diff 面板和 hunk rollback；
- branch 创建/切换/重命名/删除；
- remote/fetch/pull/push/publish/sync；
- tag、stash push/pop/apply/drop/clear；
- merge/rebase/cherry-pick/revert 冲突 UI 与 abort；
- history、blame、file timeline；
- clone overlay、目标目录选择、进度、取消和错误呈现。

因此“Git 能力已全部测试”只对服务层 API 成立，对用户看到的 GitView 不成立。

### Mention 与附件 UI（当前明显空白）

真实 UI 只在 chat-recovery-ui.spec.ts 通过 input[type=file].setInputFiles(note.txt) 验证文本附件 chip、发送、刷新/重启恢复；底层 copyIntoWorkspace 在 platform-feature-matrix.spec.ts 覆盖清洗名、字节和碰撞。

没有真实 UI 证据的路径：

- @ 补全和手动“添加附件或引用”工作区面板；
- file/dir/code/terminal/agent source；
- 行号范围 token；
- chip 删除与重建、pending mention；
- 图片选择、缩略图、图片 Dialog；
- 文本附件点击预览；
- 粘贴文本转附件、拖放；
- unsupported file/size 分支。

源码位置：src/renderer/src/components/chat/MentionInput.tsx、ChatView.tsx、useAttachments.ts。

### ChatView 与 SessionTray

已有 root-run、change-revert、subagent 测试能覆盖删除回合、回退、多选/全选和 Markdown 导出等局部动作，但没有完整证明：

- 普通消息复制、retry、regenerate、delete turn 的所有分支；
- 消息导航/标记；
- SessionTray 队列编辑、删除、合并、发送模式切换、清空；
- 附件 UI 细节和错误呈现。

### 会话历史 UI

history-replay.spec.ts 证明数据回放和删除后不复活；其他测试证明可切换历史会话。当前 SessionHistoryView.tsx 的以下能力没有 UI E2E 动作证据：

- 右键置顶/取消置顶；
- 重命名；
- 收藏和收藏过滤；
- 六色 tag；
- 按 updatedAt/title/tagColor 排序及升降序；
- 新建会话/历史占位；
- 打开项目目录；
- 刷新后的排序、筛选和选中状态。

当前源码没有独立“历史导出”动作；聊天多选导出和子代理导出是另一能力，已有局部测试。

### 设置、主题、引擎和代码图

- AppearanceSettingsView.tsx 有 system/light/dark 和 6 种 accent（blue/purple/pink/orange/green/graphite），但没有通过设置 UI 点击验证。platform matrix 只验证 API 写入 appearance=dark、accent=blue 并重启持久化。
- 未覆盖 system media change、light/system 切换、其余 5 accent、DOM token、Monaco/xterm 主题重绘。
- EngineSettingsView.tsx 的 embedded/remote、端口/远端地址、autoStart、save/save-and-restart、start/stop/restart UI 没有完整 E2E；token/协议主要是 engine-host/纯契约。
- CodeGraphSettingsView.tsx 的 status、refresh、create、rebuild、poll、failure UI 没有对应 E2E。
- 文件/搜索排除、keybindings、安全设置已有 smoke 或 lifecycle 证据，但仍主要是单路径。

### LSP

src/renderer/src/core/lsp/ts-client.ts 当前只注册 typescript、javascript、typescriptreact、javascriptreact。lsp-diagnostics.spec.ts 只覆盖 TS 诊断。

没有行为证据的能力包括：

- hover、definition、references；
- rename/workspace edits；
- signature help；
- document symbols、document highlights；
- completion/resolve、additionalTextEdits；
- JS/JSX/TSX 真机矩阵；
- Python、Go、Rust、Java 等 provider（当前源码也没有这些 provider）。

Quick Open 源码明确写有 @/# symbol jump 尚未接入，不能把它列为已实现能力。

### 模型 provider 与连接测试

当前 provider 为 deepseek/openai/anthropic/qwen/custom。model-config-ui.spec.ts 只创建 synthetic OpenAI 模型并验证改名、vision/thinking override；没有 UI 证据证明 provider 切换和预设、创建/删除模型、test connection、多 provider 真实请求、API key validation、错误和脱敏、vision/thinking 实际调用。

### OS、SSH 和原生对话框

git-service-matrix.spec.ts 在 Windows 只使用 addSshKey(''synthetic-no-real-secret'') 并断言失败/Windows 限制；没有真实 SSH agent/key/passphrase 成功路径，也没有 UI SSH 操作。Git service 有 disposable local bare remote 的 clone/remote 证据，但 clone dialog、目标目录选择、fs.pickFolder 和“打开文件夹”原生对话框没有 E2E；工作区恢复主要通过 settings.lastFolder。

### 打包、安装和升级

当前存在 resources/engine/win32-x64/stage-manifest.json、resources/engine/win32-x64/verify-runtime.mjs、build/node-LICENSE、electron-builder.yml。engine-storage-contract.spec.ts 只对 packaged runtime selection 做纯契约验证（例如 resources/engine/win32-x64/dist/main.js）；engine-host-contract.spec.ts 验证 dev sibling engine、token、protocol/build identity 和 start/stop races。

尚无真实 packaged Electron artifact 验证：

- electron-builder --dir 或 installer build 后启动打包应用；
- packaged resource path 和 Windows native dependency；
- 安装、卸载、升级/auto-update；
- 打包应用的引擎自动启动、token、文件/聊天工作区边界。

prepare:engine/verify:engine 是脚本/运行时检查，不能替代打包应用启动验收。

## 最高性价比的后续测试任务

| 优先级 | 任务 | 需要覆盖的验收点 | 原因 |
|---:|---|---|---|
| P0 | 先执行当前 261 个测试并保存真实结果 | clean disposable workspace、失败分类、renderer console/page errors、Windows 进程清理 | 当前只有 list 证据，必须先获得真实基线 |
| P0 | GitView UI 矩阵 | stage/unstage/discard、commit、diff/hunk、branch/tag/stash、remote、冲突、clone progress/cancel | 服务层已齐，补 UI 的边际收益最高 |
| P0 | Mention/附件 UI 矩阵 | @ 补全、四类 source、行号、chip 生命周期、图片/文本预览、粘贴/拖放、拒绝分支 | 聊天高频入口当前证据空白 |
| P1 | SessionHistory + Appearance/Engine/CodeGraph UI | 右键菜单、收藏/置顶/重命名/tag/排序；主题重绘；引擎 remote/embedded 保存重启；代码图状态机 | UI 与持久化风险集中，测试成本中等 |
| P1 | LSP 行为矩阵 | JS/TS/JSX/TSX 诊断，以及 hover/definition/references/rename/completion/symbols | 当前只有 diagnostics |
| P1 | ChatView/SessionTray 全动作 | copy/retry/regenerate、队列 edit/remove/merge/send mode/clear、消息导航/标记 | 直接影响日常聊天操作 |
| P1 | Provider 真实连接矩阵 | 五 provider 的表单、test connection、错误/脱敏、vision/thinking 与 fallback | 当前只证明无损编辑 |
| P2 | 原生 Windows 路径 | pickFolder、clone target picker、打开项目目录、SSH agent/key/passphrase | 原生 dialog 和凭据分支最易在发布时失效 |
| P2 | Packaged artifact 验收 | dir/installer 启动、资源路径、native deps、安装/卸载/升级 | dev/contract 证据不足以发布 |
| P2 | 回归与可观测性 | 独立临时目录、trace/video/log、runner 无残留 | 减少环境污染导致的假阴性 |

建议顺序：P0 全量真实基线 → Git UI 与 Mention/附件 → 历史/设置/主题 → LSP 与 provider → 原生 Windows → packaged artifact。每层完成后重新执行当前 32 个 spec，并追加专项 spec；只有真实运行结果全部通过，才能把“覆盖完成”写成结论。

## 最终判定

- 引擎协议、状态恢复和服务层能力：大部分已对齐，证据较强。
- Git 服务层接近完整；Git 用户界面明显未对齐。
- 聊天附件底层部分对齐；mentions、图片/拖放/粘贴和附件 UI 未对齐。
- 历史数据回放对齐；历史管理 UI 未完整验证。
- LSP 诊断的 TS 主路径对齐；广义 LSP provider/语言和编辑器能力未对齐。
- 设置/主题/代码图/模型 provider 存在实现，但 UI 和真实连接覆盖不足。
- 远端 token/身份协议边界清楚；打包、原生对话框、SSH、安装升级没有发布级证据。

因此可以确认 D:\dev\aether-code 当前清单内的 261 项本地自动化功能测试全部通过，但不能把这等同于所有外部能力已对齐或达到发布级验证。下一步应按 P0→P2 顺序补齐真实第三方远端、MCP、完整 LSP provider、附件/mentions 和安装升级证据，再作发布判断。


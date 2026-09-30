# Aether Code 前端功能与测试审计（2026-09-30）

目标是先把当前 `D:\dev\aether-code` 的前端功能目录与现有测试全部盘点，再执行完整 Playwright 回归。测试加载 `out/` 产物，`workers=1`，不复制真实秘钥或用户状态。

## 验证结果

- `npm run typecheck`：通过（node + web）。
- `npm run build`：通过（elevated；electron-vite 需要在工程根写临时 config 文件）。
- `npx playwright test --list`：当前可枚举 **261 tests / 32 files**。
- 完整 `npx playwright test --workers=1`：**261 passed / 0 failed / 0 skipped**，最终证据 `2026-09-30-aether-code-e2e-full-definitive.txt`。
- 独立 `smoke.spec.ts`：**39/39 passed**，最终证据 `2026-09-30-aether-code-smoke-final-clean.txt`。
- Git service matrix：**80/80 preload invoke 方法覆盖**；平台 IPC matrix：**11/11 passed**。

本轮最终完整回归没有失败或跳过。之前记录的旧 `.chat-panel`、旧窄布局按钮、旧 `.sec-picker__trigger`、共享 fixture 根折叠和原生确认弹窗路径已按现行 UI 更新测试契约后复跑通过。

## 阻塞修复

`e2e/git-parsers.spec.ts` 原本导入不存在的 `src/main/git/parsers.ts`，导致 `npx playwright test --list` 直接失败并显示 0 tests。已补充纯函数模块（未改测试断言）：

- `parseGitStatus`：porcelain v1 `-z --branch` 的分支、ahead/behind、重命名双路径、暂存标志、空历史。
- `parseGitLog`：`%H%x1f%h%x1f%an%x1f%ad%x1f%D%x1f%s` 字段与特殊标题。
- `isNotARepoError`、`isNoCommitsError`：可行动错误分类。

现行 `git-format.ts` 接受新 `stagedChange/unstagedChange` 契约，同时兼容旧测试输入 `indexStatus/workTreeStatus`，未跟踪显示 `U` 并保留中文提示；focused 51/51 通过。

## 功能覆盖矩阵

| 功能域 | 当前实现/页面 | 现有证据 | 状态 |
|---|---|---|---|
| 工作台与布局 | Workbench、ActivityBar、Sidebar、EditorArea、PanelArea、标题栏、Resizer | smoke 39、narrow 3 | 主路径通过 |
| 资源管理器与本地文件 | ExplorerView、file-ops、排除、最近目录、拖拽、多选、复制/剪切/粘贴、新建/重命名/回收站、虚拟滚动 | smoke 多条真实磁盘副作用断言、平台 FS 矩阵 | 主要本地路径通过 |
| 编辑器/预览 | Monaco、DocumentView、FilePreview、标签、保存/重开、二进制十六进制、图片预览 | smoke 编辑器/预览/标签；pure-functions 预览 14 条；edit-file D6 3 条 | 已覆盖主要路径；hover/completion/多语言未覆盖 |
| LSP/Problems | TS language server、诊断、Problems 面板、跳转/清理 | lsp-diagnostics 4 条；D8 证据 27/27 | 已覆盖诊断主链；hover/completion/崩溃重启边界弱 |
| 引擎连接/IPC | embedded/remote、握手、实例头、token、启动/停止/重启、SSE 流 | engine-host 6、storage 8、remote 1、D0-D5 真机用例 | 已覆盖核心契约；所有 IPC channel 并未逐一真机触发 |
| 对话/会话 | ChatView、SessionTray、Markdown、消息导航、待办、附件/mention、撤回/恢复/导出 | root-run、pending、change-revert、chat-recovery、history、streaming、smoke | 已覆盖运行/恢复主链；附件/mention、导出极端路径弱 |
| 真流式/模型切换 | provider SSE、usage、fallback、actual model、thinking | streaming contract 5 + UI 4；model form/UI 9 | 已覆盖主要路径 |
| 安全模式 | ComposerOptions、SecurityView、mode state/client、policy | security client/state/lifecycle、smoke 当前选择器 | 主路径通过 |
| 子代理 | SubagentCard、归属、取消、失败/恢复/导出、后台命令 | subagent-state 15、lifecycle 3；D7 command-job 6 | 已覆盖核心状态机 |
| 后台命令 | CommandJobCard/store、输出游标、取消、超时、引擎退出 | contract 10、store 3、UI 6 | 已覆盖 |
| 终端 | node-pty、xterm、resize/write/dispose、多标签 | smoke 单终端/多标签、平台 PTY 矩阵 | 当前环境下主路径通过；不同 conpty 发行环境仍需复测 |
| 全局搜索/替换 | SearchView、git grep/scan、正则/大小写/include/exclude、预览/落盘 | smoke 搜索/替换/排除；平台 search 矩阵；pure-functions | 主要路径通过，极端大文件/异常边界可扩展 |
| Git 基础 | GitView、status/diff/stage/unstage/discard、状态徽标、history 解析 | Git service matrix、parsers、smoke 状态入口/徽标 | 本地仓库路径通过 |
| Git 高级/远端 | branch/checkout/commit/amend/undo/tag/stash/merge/rebase/cherry-pick/clone/SSH/remote sync | Git service matrix 覆盖 80 个 invoke 方法和本地 bare remote；SSH/真实第三方认证除外 | 本地矩阵已通过 |
| 设置 | AppSettings、Appearance、Engine、CodeGraph、Exclude、SearchExclude、Keybindings、Models | model/security/exclude 部分；smoke 快捷键/排除 | 部分；appearance/accent/engine/codegraph/完整 keybindings 未全测 |
| 窗口/菜单/命令 | 自绘最小化/最大化/关闭、MenuBar、CommandPalette、QuickOpen、ContextMenu | smoke 菜单/命令面板/QuickOpen；平台矩阵验证 maximize/restore/minimize 副作用 | 主要路径已通过 |
| 打包运行 | packaged Node runtime、NSIS 资源、退出回收 | `build`、`prepare:engine`、`verify:engine`、D9 证据 | staging/运行时验证通过；安装升级仍未覆盖 |

## 主要未覆盖项与性价比顺序

1. **Git 真实外部边界**：SSH、第三方远端认证失败和网络中断；本地 bare remote 的常规流程已通过。
2. **MCP 与 provider**：stdio/OAuth/resources、真实 provider/test-connection、插件市场和真实远端服务。
3. **LSP/聊天细节**：hover/completion/definition/references/rename、多语言 provider、附件/mentions 全组合。
4. **发布级流程**：安装/升级/卸载、原生 picker、不同 conpty 环境和生产 token 注入。

该记录不提交源码；前端未提交修改包括补充 `src/main/git/parsers.ts` 与兼容 `src/renderer/src/core/git/git-format.ts`。

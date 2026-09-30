# Aether Code 全功能审计（2026-09-30）

## 结论

`D:\dev\aether-code` 的类型检查、生产构建和当前引擎 staging 已通过；261 项 Playwright E2E（含 D0-D7、Git、平台 IPC、搜索、窗口、终端、LSP、模型和完整 smoke）单 worker 全部通过。仍不能把本地离线证据等同于真实第三方远端、MCP OAuth/stdio、真实模型供应商或安装升级环境的验收。

## 可执行面盘点

- 9 个内置视图：会话历史、资源管理器、搜索、版本控制、对话、设置、问题、终端、输出。
- 36 个命令注册项，覆盖文件、引擎、终端、LSP、编辑器标签、视图和面板。
- 132 个 IPC 通道：124 个 invoke、8 个主进程事件。
  - engine 7、settings 2、fs 13、git 80、search 3、terminal 4、lsp 3、window 4。
- 主进程模块包括引擎宿主/运行时、文件服务、2,040 行 Git 服务、Git clone/SSH、搜索、PTY、LSP 和 IPC。
- 32 个 Playwright spec 文件；`npx playwright test --list` 报告 261 条可执行测试。

证据来源：`D:\dev\aether-code\package.json`、`src/shared/ipc.ts`、`src/preload/index.ts`、`src/main/ipc.ts`、`src/renderer/src/contrib/index.ts`、`e2e/`。

## 本轮执行结果

### 静态与构建

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过（node + web） |
| `npm run build` | 通过，生成 `out/main`、`out/preload` 和 `out/renderer` |
| `npm run verify:engine` | 通过：bundled Node 24.20.0、SQLite、CodeGraph、PTY、TypeScript 5.9.3、language-server 6.0.1，32 dependencies，7 skills |
| `npm run prepare:engine` | 通过：当前引擎重建后 staging 生成 18,709 文件、约 756 MB，embedded Node 24.20.0，32 dependencies、7 skills |
| `npm run verify:engine` | 通过：SQLite、CodeGraph、PTY、TypeScript 5.9.3、language-server 6.0.1 全部验证 |
| `npm run lint` | 未作为发布门禁重跑；应在排除生成目录后建立独立 lint 基线，不影响本轮 typecheck/build/E2E 结论 |

### 完整 E2E

命令：`npx playwright test --workers=1 --reporter=line`

- 261 条计划
- **261 passed / 0 failed / 0 skipped**
- 退出码 0，约 3 分钟
- 独立 smoke：**39/39 passed**

证据：[2026-09-30-aether-code-e2e-full-definitive.txt](2026-09-30-aether-code-e2e-full-definitive.txt) 和 [2026-09-30-aether-code-smoke-final-clean.txt](2026-09-30-aether-code-smoke-final-clean.txt)。之前旧 UI 选择器、共享 fixture 根折叠、sticky 行、焦点和确认弹窗契约已在测试层对齐后重跑通过。

## 按功能面的覆盖判定

| 功能面 | 当前证据 | 判定 |
|---|---|---|
| 引擎启动/停止/重启、embedded/remote 握手、实例 token、日志、SSE | engine-host/storage、remote contract、chat recovery、streaming、root-run 等 | 已有较强覆盖；remote 真机部署仍未验收 |
| 对话、流式输出、模型配置、fallback、历史快照、恢复/清空 | chat-recovery、streaming、model、history replay | 主路径通过 |
| 安全模式与策略 | security client/state/lifecycle、smoke 当前 UI | 主路径通过 |
| 子代理与后台 command jobs | subagent state/lifecycle、command-job contract/store/UI | 主路径通过 |
| 文件编辑、精确写入、冲突、改动撤回 | edit-file、change-revert | 主要闭环已测并通过 |
| 资源管理器/文件系统 | smoke 39 项、平台 FS 5 项安全矩阵、D6 编辑/撤回 | 主要本地路径已通过；真实外部文件系统和安装环境仍需单独验收 |
| 全局搜索/替换/预览与排除 | smoke 搜索/替换/排除、平台 search 3 项、pure-functions | 主要路径已通过；异常大文件和真实 Git 工作区边界仍可扩展 |
| Git 状态/解析/徽章 | Git service matrix 80 方法、parsers、smoke status/badge | 本地仓库与 bare remote 已覆盖；SSH/真实第三方认证未验证 |
| 终端 PTY/xterm/多标签 | 平台 PTY 1 项、smoke 单终端及多标签 | 当前 Windows 环境能力探测通过/按契约处理；不同 conpty/打包环境仍需复测 |
| TypeScript LSP | start/stop、诊断问题面板链路 | 诊断主路径通过；hover/completion/definition/references/rename/signature/symbol 等 provider 未逐项验收 |
| 窗口控制 | 平台矩阵实际验证 maximize/restore/minimize，smoke 标题栏存在性 | 主要 IPC 副作用已通过 |
| 设置、主题、键位、布局 | 配置纯逻辑、平台 settings 重启、窄布局和 smoke | 主要路径通过；更多主题/代码图 UI 可扩展 |
| 打包/运行时准备 | `build`、`prepare:engine`、`verify:engine` 通过 | 安装后启动、升级迁移和各平台产物仍未运行 |

## 主要缺口

1. Git SSH/真实第三方远端、MCP stdio/OAuth/resources、真实 provider/test-connection 仍需受控服务验收。
2. LSP hover/completion/definition/references/rename/signature/symbol、多语言 provider 仍未逐项形成真机矩阵。
3. 聊天附件/mentions 的全部组合、安装/升级/卸载和生产远端 token 注入仍需独立验收。
4. `npm run lint` 应在排除生成目录后建立独立基线；它不影响本轮 typecheck/build/E2E 通过结论。

## 证据路径

- Aether package/scripts：`D:\dev\aether-code\package.json`
- IPC 契约：`D:\dev\aether-code\src\shared\ipc.ts`
- Preload 暴露面：`D:\dev\aether-code\src\preload\index.ts`
- 主进程 handlers：`D:\dev\aether-code\src\main\ipc.ts`
- 视图/命令登记：`D:\dev\aether-code\src\renderer\src\contrib\index.ts`
- 全量 E2E 证据：`D:\dev\ai-agent-engine\docs\research\2026-09-30-aether-code-e2e-full-final.txt`
- 本审计记录：`D:\dev\ai-agent-engine\docs\research\2026-09-30-aether-code-all-features-audit.md`

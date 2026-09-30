# D8 / D9 并行实施与验收

用户要求同时完成 D8（LSP/Problems 完整消费）与 D9（Windows 干净环境分发）。两条线分别实施，最后串行构建并做实际 Electron 验收。

## D8 范围

- 引擎诊断进程必须有界取消：超时、AbortSignal、进程树停止和退出确认；HTTP 诊断路径必须经过 workspace 安全边界。
- renderer 统一引擎诊断与 TypeScript LSP 的 Problems/Monaco markers；退出、超时、会话切换和重复 start 不得留下悬挂请求或旧 markers。
- 补齐现有客户端的 signature help、rename、document symbols；completion 保留 textEdit/additionalTextEdits，不扩大为新的 Agent 工具。

## D9 范围

- Windows packaged 入口固定使用 `resources/engine/<platform>/dist/main.js` 与同目录 build manifest。
- 制品包含配套引擎 dist、生产运行依赖、迁移入口及必要 skills/assets；启动不依赖同级源码仓库或开发 `node_modules`。
- 干净目录启动，实际验证聊天、工具、审批、取消/恢复、LSP/Problems 关键路径；不迁移真实开发状态，不打印凭据。

## 验收证据

保存到 `.e2e-tmp/d8-d9-evidence/`。两仓任何一条 build/typecheck、受影响单测或真实 Electron 失败，都不标记对应阶段完成。

## 最终验收（2026-09-30）

### D8：已通过

- 引擎 typecheck 通过；LSP 相关测试 **7 files / 27 tests passed**。覆盖诊断并发、HTTP 取消与工作区路径安全、ESLint、进程树取消/超时/输出上限、UTF-8 分片、真实 TypeScript CLI 子进程、未保存内容相对导入。
- 前端 `npm run typecheck`（node + web）与 `npm run build` 通过。真实 Electron `diagnostics-state.spec.ts` 通过；`lsp-diagnostics.spec.ts` 在隔离 TEMP 目录单 worker **4/4 passed**。默认 TEMP 首轮仅因已有 Electron 句柄导致 `rmSync` EPERM，未进入断言，保留原始证据。
- LSP 客户端增加请求超时/取消、退出拒绝、generation 隔离、模型监听释放、版本保护，以及 rename/signatureHelp/documentSymbol/highlight；completion 保留 textEdit、additionalTextEdits、snippet 和 resolve。引擎与 tsserver Problems 按 owner 合并并去重。

### D9：已通过

- E 最新 build ID：`sha256:46a547d55449d2e983344b4560d606b7d3be2f5a146a28e31eb42338012c6e38`。
- Windows x64 staging：`resources/engine/win32-x64`，18,709 个文件、756,247,500 bytes，414 个锁定包，7 个技能；lock hash `sha256:ecd75f91269b0b5c78f673cbfc59aeca8effab7bdb42ca5b62723f05145a0494`。
- 包内独立 Node：24.20.0，ABI 137，N-API 10；包内 native smoke（SQLite、CodeGraph、PTY）、TypeScript 5.9.3 与 TypeScript Language Server 6.0.1 全通过。
- `npm run verify:engine` 强制使用 `resources/engine/win32-x64/runtime/node.exe` 并通过。`npm run build:unpack` 已包含 build、prepare 和 electron-builder；builder `extraResources` 复制到 `engine/win32-x64`。
- 实际 `dist/win-unpacked/aether-code.exe` 已构建，并复制到隔离目录后启动：`app.isPackaged=true`，没有源码同级路径、开发 Node 或 `AETHER_*` 路径覆盖；引擎就绪、用户态 state/skills 创建、LSP TS2322 Problems 可见、应用退出后端口关闭、包内 runtime/manifest hash 未变化。证据：`D9-packaged-clean-electron.txt`。
- 同一隔离 packaged executable 使用本地合成 OpenAI-compatible provider 完成一轮真实聊天，provider 请求 1 次并返回 `PACKAGED_CHAT_OK`；包内 Node 执行 seed、数据库和引擎 state 均在 userData，关闭后端口回收。证据：`D9-packaged-chat-electron.txt`。
- NSIS 安装包已生成：`D:/dev/aether-code/dist/aether-code-1.0.0-setup.exe`，222,392,315 bytes，SHA-256 `628e3c0613a1760dd20d037b23cf686d06f0622ab3f8dd79b6ce4703f0e350a1`；blockmap SHA-256 `8670e2e16fe25c78abd8c9b1e60e5e78c5bc8b3a0a6fe4b2ffd6e22fc8c44728`。
- 引擎 `getUserAetherDir()` 尊重宿主提供的 `AETHER_GLOBAL_DIR`，安装包不会读取开发者 home 配置；技能先复制到 userData 并保留用户修改，安装资源保持只读。

### 交付文件

- D8 引擎测试：`.e2e-tmp/d8-d9-evidence/D8-engine-lsp-tests.txt`
- D8 前端检查：`.e2e-tmp/d8-d9-evidence/D8-frontend-owner-checks.md`
- D9 bundled smoke：`resources/engine/win32-x64/stage-manifest.json` 与 `npm run verify:engine` 输出
- D9 实际包验收：`.e2e-tmp/d8-d9-evidence/D9-packaged-clean-electron.txt`

构建未发布、未提交；开发状态和真实凭据没有复制进制品。`resources/engine/`、隔离包和测试夹具均属于生成物，后续可按开发阶段清理。

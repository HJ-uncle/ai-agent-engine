## Context

`agent-engine` 是一个基于 Fastify + TypeScript 的 AI Agent 后端服务，提供 HTTP/SSE 接口供 `wuzu-client` 调用。当前架构中两者完全解耦：`wuzu-client` 通过 `AgentEngineProvider`（`src/main/engine/agentEngineProvider/`）发起 HTTP 请求，要求 `agent-engine` 作为独立进程预先运行在 `http://127.0.0.1:12323`。

现在需要将 `agent-engine` 打包为 `@wuzu/agent-engine-sdk`，让 `wuzu-client` 主进程能够：
1. **内嵌模式**：自动拉起 agent-engine 子进程，用户无需手动部署
2. **远端模式**：连接用户自行部署的 agent-engine（保持现有行为）

`agent-engine` 技术栈：TypeScript ESM + `tsx`/`tsc`，依赖含原生模块（`node-pty`、`@libsql/client`）。

## Goals / Non-Goals

**Goals:**
- 建立独立的 `sdk-package/` npm 包目录，可通过 `npm pack` 产出 `.tgz`
- 实现 `AgentEngineSdk` 类，支持 `embedded` / `remote` 双模式
- 内嵌模式：子进程管理（启动/就绪探测/优雅关闭/崩溃保护）+ 端口探测
- 构建脚本将 `agent-engine` 编译产物（`dist/` + `node_modules/`）打入 `bin/`
- 导出完整 TypeScript 类型定义（`.d.ts`）
- 不改动 `agent-engine` 现有 `src/` 业务代码

**Non-Goals:**
- 跨平台 native module 的 CI 自动构建（首期手动处理各平台 `.tgz`）
- SDK 发布到公共 npm registry
- 自动更新机制（`.tgz` 手动更新）
- agent-engine 进程崩溃后的自动重启（首期仅报错通知）

## Decisions

### D1：SDK 包独立于主包，位于 `sdk-package/` 子目录

**决策**：新建 `agent-engine/sdk-package/` 作为独立 npm 包根目录，有自己的 `package.json`（`name: "@wuzu/agent-engine-sdk"`）和 `tsconfig.json`。

**理由**：
- 主包保持 ESM + tsx 工作流不受干扰
- SDK 包可单独 `npm pack`，不影响主包的 `npm start` 流程
- 类型编译产物（`dist/`）与主包分离，避免路径污染

**备选方案**：在主包根目录添加 `sdk` 入口 → 拒绝，会导致主包 `package.json` exports 复杂化

---

### D2：`bin/` 目录包含完整可运行产物（`dist/main.js` + `node_modules/`）

**决策**：`sdk-package/bin/` 中放置：
```
bin/
├── main.js           ← agent-engine dist/main.js
└── node_modules/     ← agent-engine 的运行时依赖
```
通过 `scripts/copy-bin.js` 在 `npm run build` 时从主包复制。

**理由**：
- 确保 SDK 安装后自包含，wuzu-client 安装 `.tgz` 后无需额外 `npm install`
- 避免 native module（`node-pty`、`@libsql/client`）在 wuzu-client 环境中重新编译

**备选方案**：只打包 `dist/main.js`，依赖由 wuzu-client 安装 → 拒绝，会引入原生模块跨环境编译问题

**trade-off**：`.tgz` 体积较大（含 `node_modules`），约 50~200MB

---

### D3：SDK 使用 `child_process.spawn` 启动 `node bin/main.js`

**决策**：内嵌模式通过 `spawn('node', ['bin/main.js'], { env, detached: false })` 启动子进程。

**理由**：
- `detached: false` 确保父进程（Electron 主进程）退出时子进程自动终止
- 使用当前 Node 运行时（Electron 内置的 Node），无需额外打包 Node 二进制
- 子进程继承 `process.env` 并注入动态端口 `PORT=<port>`

**备选方案**：将 agent-engine 编译为独立二进制（`pkg` / `nexe`）→ 拒绝，原生模块兼容性极难保证

---

### D4：就绪探测通过轮询 `/health` 接口实现

**决策**：子进程启动后，SDK 以 200ms 间隔轮询 `GET http://127.0.0.1:<port>/health`，成功响应则 resolve；超时（默认 15s）则 reject 并终止子进程。

**理由**：最简单可靠的方式，无需解析子进程 stdout（不同平台换行符/编码差异大）

---

### D5：端口探测通过尝试绑定 TCP 端口实现

**决策**：`portFinder.ts` 从 `preferredPort`（默认 12323）开始，逐个尝试 `net.createServer().listen(port)`，找到第一个可用端口返回。

**理由**：比解析 `EADDRINUSE` 错误更可靠，兼容 Windows/macOS/Linux

## Risks / Trade-offs

**[风险] `.tgz` 体积过大** → 缓解：`copy-bin.js` 中过滤不必要文件（如 `node_modules/**/test/`、`*.map`）；长期考虑使用 esbuild bundle

**[风险] 子进程 data 目录路径** → agent-engine 使用相对路径 `data/agent.db`，子进程 `cwd` 需设置为 `bin/` 同级目录，或通过 `DATA_DIR` 环境变量覆盖 → 缓解：SDK 注入 `DATA_DIR`，指向 Electron `app.getPath('userData')/agent-engine/`

**[风险] Windows 下 `node-pty` native binding 路径** → `node-pty` 的 `.node` 文件路径在不同 Node 版本下不同 → 缓解：SDK 包构建时明确指定 Node 版本，匹配 Electron 内置 Node 版本

**[风险] 端口探测并发问题** → 两个 wuzu-client 实例同时启动时可能选中同一端口 → 缓解：选中端口后立即绑定占位（`net.createServer` 延迟 close），子进程启动后释放

**[风险] 子进程孤儿** → Electron 异常崩溃（kill -9）时 `detached: false` 不一定生效 → 缓解：子进程检测 stdin 关闭（`process.stdin.on('close')`）后自行退出

## Migration Plan

1. 在 `agent-engine` 中执行 `npm run build` → 产出 `dist/`
2. 在 `sdk-package/` 中执行 `npm run build` → 复制产物 + TypeScript 编译
3. 执行 `npm pack` → 产出 `wuzu-agent-engine-sdk-x.x.x.tgz`
4. 在 `wuzu-client` 中 `npm install <path-to>.tgz`
5. `wuzu-client` 中 `AgentEngineProvider` 接入 SDK（Phase 2，独立 change）

**回滚**：`.tgz` 不安装，`wuzu-client` 保持现有远端模式配置，无破坏性变更。

## Open Questions

- `agent-engine` 进程崩溃后是否需要自动重启？首期暂不实现，待 Phase 2 集成时根据用户反馈决定
- `DATA_DIR` 的默认路径在 wuzu-client 中如何约定？待 Phase 2 `AgentEngineRuntime` 模块中确定

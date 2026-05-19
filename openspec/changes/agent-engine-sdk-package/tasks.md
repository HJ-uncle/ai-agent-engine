## 1. 包结构初始化

- [x] 1.1 在 `agent-engine/sdk-package/` 创建 `package.json`（name: `@wuzu/agent-engine-sdk`，main/types/files 字段正确）
- [x] 1.2 创建 `sdk-package/tsconfig.json`（target CJS，输出到 `dist/`，生成 `.d.ts`）
- [x] 1.3 创建 `sdk-package/src/` 目录结构：`index.ts`、`types.ts`、`embedded/`、`client/`

## 2. 公开类型定义（sdk-core）

- [x] 2.1 在 `src/types.ts` 中定义 `AgentEngineSdkConfig`、`EmbeddedOptions`、`RemoteOptions`、`EngineHealthResult`
- [x] 2.2 在 `src/types.ts` 中定义 `SdkMode`（`'embedded' | 'remote'`）

## 3. 内嵌运行时 —— 端口探测（embedded-runtime）

- [x] 3.1 创建 `src/embedded/portFinder.ts`，实现 `findAvailablePort(preferredPort, maxTries?)` 函数
- [x] 3.2 端口探测：使用 `net.createServer().listen()` 方式尝试绑定，找到可用端口后 resolve，超过 `maxTries=100` 后 reject

## 4. 内嵌运行时 —— 子进程管理（embedded-runtime）

- [x] 4.1 创建 `src/embedded/processManager.ts`，定义 `ProcessHandle` 接口
- [x] 4.2 实现 `startProcess({ binPath, port, dataDir, env, onExit })` 函数，使用 `child_process.spawn` 启动 `node main.js`，注入 `PORT`、`DATA_DIR` 环境变量，`detached: false`
- [x] 4.3 实现 `stopProcess(handle, timeoutMs?)` 函数：先 SIGTERM，等待最长 5 秒，超时则 SIGKILL

## 5. 内嵌运行时 —— 就绪探测（embedded-runtime）

- [x] 5.1 创建 `src/embedded/readinessProbe.ts`，实现 `waitUntilReady({ baseUrl, timeoutMs, intervalMs })` 函数
- [x] 5.2 就绪探测：以 `intervalMs`（默认 200ms）轮询 `GET <baseUrl>/health`，ECONNREFUSED 不立即失败，超时后 reject 含 `'startup timeout'` 的错误

## 6. HTTP 客户端（sdk-core）

- [x] 6.1 将 `agentEngineProvider/httpClient.ts` 的核心逻辑复制到 `src/client/httpClient.ts`，去除对主进程 `logger` 的依赖，改用 `console.warn`

## 7. SDK 主类（sdk-core）

- [x] 7.1 创建 `src/index.ts`，实现 `AgentEngineSdk` 类
- [x] 7.2 实现构造函数：接收 `AgentEngineSdkConfig`，校验 remote 模式必须有 `baseUrl`
- [x] 7.3 实现 `start()` 方法：embedded 模式依次调用端口探测 → 启动子进程 → 就绪探测；remote 模式直接 resolve；已启动时幂等返回
- [x] 7.4 实现 `stop()` 方法：embedded 模式终止子进程并清理状态；remote 模式 no-op；未启动时 no-op
- [x] 7.5 实现 `healthCheck()` 方法：通过 `httpClient` 发送 `GET /health`，返回 `EngineHealthResult`
- [x] 7.6 实现 `get baseUrl()` 和 `get mode()` 访问器

## 8. 构建脚本（sdk-build）

- [x] 8.1 创建 `sdk-package/scripts/copy-bin.js`：检查 `../dist/main.js` 是否存在，不存在则以有意义的错误退出
- [x] 8.2 `copy-bin.js` 将 `../dist/main.js` 复制到 `bin/main.js`
- [x] 8.3 `copy-bin.js` 将 `../node_modules/` 复制到 `bin/node_modules/`（排除 devDependencies 相关目录）
- [x] 8.4 在 `sdk-package/package.json` 中配置 `scripts.build`（`tsc && node scripts/copy-bin.js`）和 `scripts.pack`（`npm run build && npm pack`）
- [x] 8.5 在根 `agent-engine/package.json` 中添加 `scripts.build:sdk`（`cd sdk-package && npm run pack`）

## 9. 验证

- [x] 9.1 在 `sdk-package/` 执行 `npm run build`，确认 `dist/` 和 `bin/` 正确生成
- [x] 9.2 执行 `npm pack`，产出 `.tgz` 文件（~60MB）
- [ ] 9.3 在临时目录安装 `.tgz`，验证 `require('@wuzu/agent-engine-sdk')` 返回 `AgentEngineSdk`
- [ ] 9.4 在 `wuzu-client` 中安装 `.tgz`，验证 TypeScript 类型无报错（`npm run typecheck`）
- [ ] 9.5 手动测试：在 `wuzu-client` 主进程中以 embedded 模式调用 `sdk.start()`，确认 agent-engine 子进程成功启动并就绪

## Why

`agent-engine` 目前作为独立 HTTP 服务运行，`wuzu-client` 通过网络调用与其交互，导致用户需要额外手动部署并维护一个后台服务。将 `agent-engine` 打包为 SDK 后，客户端可直接内嵌启动引擎进程，实现开箱即用；同时保留远端连接模式，满足高级用户自定义部署的需求。

## What Changes

- **新增** `sdk-package/` 目录，作为独立 npm 包 `@wuzu/agent-engine-sdk` 的根目录
- **新增** SDK 核心入口类 `AgentEngineSdk`，封装内嵌启动（子进程管理）和远端连接两种模式
- **新增** 子进程生命周期管理模块（启动、就绪探测、优雅关闭、异常重启）
- **新增** 随机可用端口探测模块（避免 12323 端口冲突）
- **新增** 构建脚本：`npm run build && npm pack` 产出 `.tgz`，将 `agent-engine` 编译产物随包打入 `bin/`
- **新增** SDK 公开类型定义（`AgentEngineSdkConfig`、`SdkMode`、`EmbeddedOptions`、`RemoteOptions`）
- 现有 `src/` 业务代码**不改动**，SDK 仅作为独立打包层

## Capabilities

### New Capabilities

- `sdk-core`: SDK 主入口，`AgentEngineSdk` 类封装双模式（embedded / remote）的启动、停止、健康检查、baseUrl 暴露
- `embedded-runtime`: 子进程生命周期管理 —— 启动 `bin/main.js`、端口探测、就绪轮询、优雅关闭、崩溃重启保护
- `sdk-build`: SDK 打包流程 —— TypeScript 编译、`bin/` 产物复制、`npm pack` 生成 `.tgz` 供 wuzu-client 本地引用

### Modified Capabilities

（无现有 spec 需要修改）

## Impact

- **新增文件**：`sdk-package/` 目录（`package.json`、`tsconfig.json`、`src/`、`bin/`、`scripts/`）
- **构建依赖**：`sdk-package/` 的构建依赖主包先执行 `npm run build`（产出 `dist/main.js`）
- **对 wuzu-client 的影响**：安装 `.tgz` 后，`AgentEngineProvider` 可通过 SDK 在内嵌模式下动态获取 `baseUrl`，无需用户预先配置
- **跨平台注意**：`agent-engine` 含原生模块（`node-pty`、`@libsql/client`），打包 `bin/` 时需携带 `node_modules`（含 native binding），各平台需分别构建

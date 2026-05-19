## ADDED Requirements

### Requirement: 端口探测找到可用端口
`portFinder` 模块 SHALL 从指定首选端口开始，逐个探测直到找到可用的 TCP 端口。

#### Scenario: 首选端口可用
- **WHEN** `findAvailablePort(12323)` 被调用，12323 端口未被占用
- **THEN** resolve `12323`

#### Scenario: 首选端口被占用时递增探测
- **WHEN** `findAvailablePort(12323)` 被调用，12323 已被占用，12324 可用
- **THEN** resolve `12324`

#### Scenario: 超出最大尝试次数时 reject
- **WHEN** 连续 100 个端口均被占用
- **THEN** reject，错误信息包含 `'No available port found'`

### Requirement: 子进程启动并注入环境变量
`processManager` 模块 SHALL 使用 `child_process.spawn` 启动 `node bin/main.js`，并注入 `PORT`、`DATA_DIR` 等环境变量。

#### Scenario: 子进程以正确端口启动
- **WHEN** `startProcess({ port: 12324, binPath, dataDir })` 被调用
- **THEN** 子进程以 `env.PORT=12324`、`env.DATA_DIR=<dataDir>` 启动，`detached: false`

#### Scenario: 子进程意外退出时触发 onExit 回调
- **WHEN** 子进程进程被外部 kill
- **THEN** `processManager` 触发注册的 `onExit(code, signal)` 回调

### Requirement: 就绪探测等待 agent-engine 启动完成
`readinessProbe` 模块 SHALL 以固定间隔轮询 `/health`，在超时前成功响应则 resolve。

#### Scenario: 服务在超时前就绪
- **WHEN** `waitUntilReady({ baseUrl, timeoutMs: 15000, intervalMs: 200 })` 被调用，服务在 3 秒后响应 200
- **THEN** 在 3 秒左右 resolve

#### Scenario: 超时后 reject 并终止探测
- **WHEN** `waitUntilReady({ baseUrl, timeoutMs: 5000, intervalMs: 200 })` 被调用，服务始终不响应
- **THEN** 5 秒后 reject，错误信息包含 `'startup timeout'`

#### Scenario: 探测期间网络错误不立即失败
- **WHEN** 探测过程中连接被拒绝（ECONNREFUSED）
- **THEN** 继续轮询，直到超时

### Requirement: 优雅关闭子进程
`processManager` 的停止逻辑 SHALL 先发送 SIGTERM，等待最长 5 秒，若未退出则发送 SIGKILL。

#### Scenario: 子进程在 SIGTERM 后正常退出
- **WHEN** `stopProcess()` 被调用，子进程在 1 秒内退出
- **THEN** resolve，不发送 SIGKILL

#### Scenario: 子进程未响应 SIGTERM 时强制 kill
- **WHEN** `stopProcess()` 被调用，子进程 5 秒内未退出
- **THEN** 发送 SIGKILL，进程终止后 resolve

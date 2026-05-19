## ADDED Requirements

### Requirement: SDK 支持双模式初始化
`AgentEngineSdk` 类 SHALL 在构造时接受 `AgentEngineSdkConfig`，其中 `mode` 字段决定运行模式（`'embedded'` 或 `'remote'`）。

#### Scenario: embedded 模式构造成功
- **WHEN** 传入 `{ mode: 'embedded', embedded: { preferredPort: 12323 } }`
- **THEN** 构造不抛出异常，`sdk.mode` 返回 `'embedded'`，`sdk.baseUrl` 在 `start()` 前为空字符串

#### Scenario: remote 模式构造成功
- **WHEN** 传入 `{ mode: 'remote', remote: { baseUrl: 'http://127.0.0.1:12323' } }`
- **THEN** 构造不抛出异常，`sdk.mode` 返回 `'remote'`

#### Scenario: remote 模式缺少 baseUrl 时抛出错误
- **WHEN** 传入 `{ mode: 'remote' }`（不含 `remote.baseUrl`）
- **THEN** `start()` 调用 reject，错误信息包含 `'remote.baseUrl is required'`

### Requirement: SDK start() 返回 baseUrl
`start()` 方法 SHALL 在成功后 resolve 并返回 `{ baseUrl: string }`，该 URL 可直接用于 HTTP 请求。

#### Scenario: embedded 模式 start() 成功后返回实际 baseUrl
- **WHEN** `embedded` 模式下 `start()` 被调用，子进程启动并通过就绪探测
- **THEN** resolve `{ baseUrl: 'http://127.0.0.1:<实际端口>' }`，`sdk.baseUrl` 与之一致

#### Scenario: remote 模式 start() 不启动子进程
- **WHEN** `remote` 模式下 `start()` 被调用
- **THEN** 不启动任何子进程，直接 resolve `{ baseUrl: <config.remote.baseUrl> }`

#### Scenario: 多次调用 start() 幂等
- **WHEN** 已处于 started 状态时再次调用 `start()`
- **THEN** 直接 resolve 当前 `baseUrl`，不重新启动进程

### Requirement: SDK stop() 优雅关闭
`stop()` 方法 SHALL 终止内嵌子进程（若存在）并清理内部状态。

#### Scenario: embedded 模式 stop() 终止子进程
- **WHEN** `embedded` 模式下 `stop()` 被调用
- **THEN** 子进程收到 SIGTERM，进程退出，`sdk.baseUrl` 重置为空字符串

#### Scenario: remote 模式 stop() 无副作用
- **WHEN** `remote` 模式下 `stop()` 被调用
- **THEN** 方法 resolve，不做任何操作

#### Scenario: 未启动时调用 stop() 无异常
- **WHEN** `start()` 未被调用时调用 `stop()`
- **THEN** 方法正常 resolve，不抛出异常

### Requirement: SDK 导出健康检查
`healthCheck()` 方法 SHALL 发送 `GET /health` 请求并返回 `EngineHealthResult`。

#### Scenario: 服务正常时返回 ok
- **WHEN** agent-engine 正常运行，`healthCheck()` 被调用
- **THEN** resolve `{ ok: true, latencyMs: <数字> }`

#### Scenario: 服务不可达时返回错误
- **WHEN** agent-engine 未运行，`healthCheck()` 被调用
- **THEN** resolve `{ ok: false, error: <错误信息> }`（不 reject）

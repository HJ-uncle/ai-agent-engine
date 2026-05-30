## ADDED Requirements

### Requirement: DeepSeek 错误码分级处理

`DeepSeekAdapter` SHALL 将 DeepSeek HTTP 错误码映射为语义化的自定义 Error 子类，前端 useChat/errorHandler SHALL 识别这些类型并展示针对性提示。

#### Scenario: 402 触发充值提示

- **WHEN** API 调用收到 HTTP 402 响应
- **THEN** 抛出 `DeepSeekInsufficientBalanceError`，消息包含充值页面 URL，Agent Loop 停止重试

#### Scenario: 429 触发自动退避重试

- **WHEN** API 调用收到 HTTP 429 响应
- **THEN** 按 1s/2s/4s 间隔最多重试 3 次；全部失败后抛出 `DeepSeekRateLimitError`

#### Scenario: 503 标记可重试

- **WHEN** API 调用收到 HTTP 503 响应
- **THEN** 抛出 `DeepSeekServiceUnavailableError`（`retryable: true`）

#### Scenario: 422 参数降级重试

- **WHEN** API 调用收到 HTTP 422 且错误体可解析出参数名
- **THEN** Adapter 移除该参数后重试一次；仍失败则抛出 `DeepSeekInvalidParamError`

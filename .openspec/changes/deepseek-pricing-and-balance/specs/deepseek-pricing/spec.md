## ADDED Requirements

### Requirement: 价格配置可手动编辑并支持折扣截止时间

系统 SHALL 为每个 DeepSeek 模型提供可编辑的价格配置，包含：原价（input/output/cacheHit，单位元/百万 token）、折扣价（相同三字段）和折扣截止时间（ISO8601）。系统 SHALL 在运行时根据当前时间自动判断使用原价或折扣价，无需重启。

#### Scenario: 折扣期内显示折扣价

- **WHEN** 当前时间 < `discountUntil`
- **THEN** 系统返回折扣价字段用于成本估算，并在 UI 显示"折扣中"标签

#### Scenario: 折扣到期后自动回原价

- **WHEN** 当前时间 >= `discountUntil`
- **THEN** 系统返回原价字段，UI 不再显示"折扣中"标签，成本估算使用原价差价

#### Scenario: 用户修改价格并保存

- **WHEN** 用户在 DeepSeek 设置页修改任意价格字段并点击保存
- **THEN** 配置持久化到服务端文件，前端读取最新值并更新 ChatArea 估算

#### Scenario: 配置文件不存在时写入默认值

- **WHEN** 后端启动且 `~/.agent-engine/deepseek-prices.json` 不存在
- **THEN** 系统自动写入内置默认配置（包含 deepseek-chat 和 deepseek-reasoner 的原价快照）

---

### Requirement: 余额查询 API 代理

系统 SHALL 提供 `GET /api/deepseek/balance` 端点，后端使用已配置的 `DEEPSEEK_API_KEY` 代理调用 DeepSeek `/user/balance` 接口，返回余额信息。前端 SHALL 不直接使用 API Key 调用 DeepSeek。

#### Scenario: 成功查询余额

- **WHEN** 用户在设置页点击"刷新余额"按钮
- **THEN** UI 显示最新可用余额（元）及货币单位，最后刷新时间

#### Scenario: 低余额警告

- **WHEN** 查询返回余额 < 10 元（可配置阈值）
- **THEN** UI 显示橙色警告卡片，提示"余额不足，请充值"

#### Scenario: API Key 未配置时的提示

- **WHEN** 后端 `DEEPSEEK_API_KEY` 未设置
- **THEN** 返回 HTTP 400，UI 显示"请先配置 API Key"而非通用错误

---

### Requirement: 动态模型列表拉取

系统 SHALL 提供 `GET /api/deepseek/models` 端点，代理调用 DeepSeek `/models` 接口，结果缓存 5 分钟。ModelSettings 选择器 SHALL 支持从此端点获取模型列表。

#### Scenario: 成功获取并缓存模型列表

- **WHEN** 调用 `GET /api/deepseek/models`
- **THEN** 返回模型 ID 列表，缓存有效期内再次调用直接返回缓存值

#### Scenario: 缓存过期后重新拉取

- **WHEN** 距上次拉取超过 5 分钟且再次请求
- **THEN** 重新调用 DeepSeek API 并刷新缓存

#### Scenario: 拉取失败时的降级

- **WHEN** DeepSeek `/models` 返回错误或网络超时
- **THEN** 返回内置硬编码模型列表（`deepseek-chat`、`deepseek-reasoner`），并在响应中标记 `fallback: true`

---

### Requirement: DeepSeek 特有错误码分级处理

`DeepSeekAdapter` SHALL 识别 DeepSeek 返回的特有错误码并映射到自定义 Error 子类，前端 SHALL 针对每类错误展示有意义的提示而非通用"调用失败"。

#### Scenario: 402 余额不足

- **WHEN** DeepSeek API 返回 HTTP 402
- **THEN** Adapter 抛出 `DeepSeekInsufficientBalanceError`，前端显示带充值链接的错误卡片，不重试

#### Scenario: 429 速率限制自动重试

- **WHEN** DeepSeek API 返回 HTTP 429
- **THEN** Adapter 自动指数退避重试（间隔 1s/2s/4s，最多 3 次），全部失败后抛出 `DeepSeekRateLimitError`，前端显示"请求过于频繁，请稍后重试"

#### Scenario: 503 服务不可用

- **WHEN** DeepSeek API 返回 HTTP 503
- **THEN** Adapter 抛出 `DeepSeekServiceUnavailableError`（含 `retryable: true`），前端显示"DeepSeek 服务暂时不可用"并提供"重试"按钮

#### Scenario: 422 参数错误降级重试

- **WHEN** DeepSeek API 返回 HTTP 422 且错误消息含特定参数名
- **THEN** Adapter 移除该参数后重试一次；若仍失败，抛出 `DeepSeekInvalidParamError`

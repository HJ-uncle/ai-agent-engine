## ADDED Requirements

### Requirement: 动态模型列表拉取与缓存

系统 SHALL 从 DeepSeek `/models` 端点动态获取模型列表，并在内存中缓存 5 分钟，降低 API 调用频次。

#### Scenario: 正常返回模型列表

- **WHEN** `GET /api/deepseek/models` 在缓存有效期内被调用
- **THEN** 直接返回缓存中的模型 ID 数组，不重新请求 DeepSeek

#### Scenario: API 故障时返回内置列表

- **WHEN** DeepSeek `/models` 调用超时或返回 5xx
- **THEN** 返回内置默认列表 `["deepseek-chat", "deepseek-reasoner"]`，附带 `fallback: true`

## ADDED Requirements

<!-- documentation-status: historical -->
> 历史资料：保留原有调研、设计或验收条件，不代表当前版本全部行为或本轮测试结果。现行操作与源码入口见[文档首页](../../../../../docs/README.md)；文档状态见[全量清单](../../../../../docs/documentation-inventory.md)。状态标注：2026-11-17。


### Requirement: 动态模型列表拉取与缓存

系统 SHALL 从 DeepSeek `/models` 端点动态获取模型列表，并在内存中缓存 5 分钟，降低 API 调用频次。

#### Scenario: 正常返回模型列表

- **WHEN** `GET /api/deepseek/models` 在缓存有效期内被调用
- **THEN** 直接返回缓存中的模型 ID 数组，不重新请求 DeepSeek

#### Scenario: API 故障时返回内置列表

- **WHEN** DeepSeek `/models` 调用超时或返回 5xx
- **THEN** 返回内置默认列表 `["deepseek-chat", "deepseek-reasoner"]`，附带 `fallback: true`

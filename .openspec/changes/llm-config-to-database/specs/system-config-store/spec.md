## ADDED Requirements

### Requirement: System config key-value storage
系统 SHALL 提供 `system_config` 表，以 key-value 方式持久化存储系统级配置项。敏感字段（is_secret=1）的 value 必须使用 `encrypt()` 加密存储，读取时使用 `decrypt()` 解密。

#### Scenario: 写入非敏感配置
- **WHEN** 调用 `SystemConfigStore.set("LLM_PROVIDER", "openai", false)`
- **THEN** 数据库 `system_config` 中存在 `key=LLM_PROVIDER, value="openai", is_secret=0`

#### Scenario: 写入敏感配置
- **WHEN** 调用 `SystemConfigStore.set("OPENAI_API_KEY", "sk-xxx", true)`
- **THEN** 数据库中 `value` 为加密密文，`is_secret=1`

#### Scenario: 读取敏感配置
- **WHEN** 调用 `SystemConfigStore.get("OPENAI_API_KEY")`
- **THEN** 返回解密后的原始明文 `"sk-xxx"`

#### Scenario: 读取不存在的 key
- **WHEN** 调用 `SystemConfigStore.get("NONEXISTENT_KEY")`
- **THEN** 返回 `null`

#### Scenario: 加密 key 变更后读取
- **WHEN** 加密 key 变更导致解密失败
- **THEN** `SystemConfigStore.get()` 返回 `null`（不抛出异常）

#### Scenario: 批量读取所有配置
- **WHEN** 调用 `SystemConfigStore.getAll()`
- **THEN** 返回所有配置项，敏感字段已解密，decryption 失败的字段值为 `null`

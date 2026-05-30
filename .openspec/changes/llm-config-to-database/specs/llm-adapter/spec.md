## MODIFIED Requirements

### Requirement: LLM adapter default configuration source
LLM 适配器工厂 SHALL 提供 `createLLMAdapterWithDbConfig(overrides?)` 异步工厂函数。该函数在创建 adapter 前从数据库的 `system_config` 表读取默认配置（LLM_PROVIDER、LLM_PRIMARY_MODEL、OPENAI_API_KEY、OPENAI_BASE_URL），读取失败时回退到 `process.env`。

#### Scenario: 数据库有完整配置时使用数据库配置
- **WHEN** `system_config` 中存有 `LLM_PROVIDER=openai`、`LLM_PRIMARY_MODEL=gpt-4o`、`OPENAI_API_KEY=sk-xxx`、`OPENAI_BASE_URL=https://api.openai.com/v1`
- **THEN** `createLLMAdapterWithDbConfig()` 创建的 adapter 使用上述数据库配置

#### Scenario: 数据库无配置时 fallback 到环境变量
- **WHEN** `system_config` 中不存在任何 LLM 相关 key，`process.env.LLM_PROVIDER=anthropic`
- **THEN** `createLLMAdapterWithDbConfig()` 创建的 adapter 使用 `anthropic` provider

#### Scenario: overrides 优先级最高
- **WHEN** 传入 `overrides = { provider: "ollama", model: "llama3" }`
- **THEN** 忽略数据库和环境变量中的 provider/model，使用 overrides 的值

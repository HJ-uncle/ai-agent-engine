## Why

当前默认 LLM 模型配置（`LLM_PROVIDER`、`LLM_PRIMARY_MODEL`、`OPENAI_BASE_URL`、`OPENAI_API_KEY`）保存在服务器本地的 `.env` 文件中，存在敏感数据泄露风险（版本控制误提交、文件权限不当等）。需要将这些敏感配置迁移至数据库存储，并通过加密保护 API Key，使配置管理更安全、统一。

## What Changes

- 新增数据库表 `system_config` 用于存储 key-value 格式的系统级配置项，敏感字段（API Key）加密存储
- 新增 `SystemConfigStore` 数据访问层，提供 get/set/getAll 操作
- 修改 `GET /settings` 接口：优先从数据库读取 LLM 相关配置，回退到环境变量
- 修改 `PUT /settings` 接口：将 LLM 相关敏感配置写入数据库，不再写入 `.env` 文件
- 修改 `createLLMAdapter`：新增 `createLLMAdapterWithDbConfig` 异步版本，从数据库加载默认配置
- 新增数据库迁移 `010_add_system_config.ts`

## Capabilities

### New Capabilities

- `system-config-store`: 数据库级 key-value 系统配置存储，支持加密敏感字段的读写

### Modified Capabilities

- `llm-adapter`: LLM 适配器工厂现在可以从数据库读取默认的 provider/model/apiKey/baseUrl 配置

## Impact

- **数据库**：新增 `system_config` 表（migration 010）
- **API**：`GET /settings` 和 `PUT /settings` 行为变更（LLM 配置源变为数据库）
- **LLM Adapter**：新增异步工厂函数 `createLLMAdapterWithDbConfig`
- **向后兼容**：数据库无配置时自动降级到环境变量，保持平滑升级
- **`.env` 文件**：`LLM_PROVIDER`、`LLM_PRIMARY_MODEL`、`OPENAI_API_KEY`、`OPENAI_BASE_URL` 不再被 settings 路由写入（仅保留为最低优先级回退）

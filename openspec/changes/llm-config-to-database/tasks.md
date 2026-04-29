## 1. 数据库迁移

- [x] 1.1 创建 `src/storage/sqlite/migrations/010_add_system_config.ts`，定义 `system_config` 表的 `up()` 函数（CREATE TABLE IF NOT EXISTS）
- [x] 1.2 在 `src/storage/sqlite/db.ts` 中导入并注册 migration 010，在 `initDb()` 中调用 `await up10(db)`

## 2. SystemConfigStore

- [x] 2.1 创建 `src/storage/sqlite/system-config.ts`，实现 `SystemConfigStore` 类
- [x] 2.2 实现 `get(key: string): Promise<string | null>` — 查询数据库，is_secret=1 时 decrypt，失败返回 null
- [x] 2.3 实现 `set(key: string, value: string, isSecret: boolean): Promise<void>` — UPSERT，is_secret=1 时 encrypt
- [x] 2.4 实现 `getAll(): Promise<Record<string, string | null>>` — 批量读取所有配置项
- [x] 2.5 导出单例 `systemConfigStore` 实例

## 3. LLM Adapter 异步工厂

- [x] 3.1 在 `src/core/llm-adapter/factory.ts` 中添加 `createLLMAdapterWithDbConfig(overrides?)` 异步函数
- [x] 3.2 函数内从 `systemConfigStore` 读取 `LLM_PROVIDER`、`LLM_PRIMARY_MODEL`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`，fallback 到 `process.env`
- [x] 3.3 调用现有 `createBaseAdapter` 创建 adapter，保持 overrides 优先级最高

## 4. Settings 路由改造

- [x] 4.1 修改 `src/api/http/routes/settings.ts` 的 `GET /settings`：从 `systemConfigStore.getAll()` 读取 LLM 配置，覆盖 env 回退
- [x] 4.2 修改 `PUT /settings`：将 `LLM_PROVIDER`、`LLM_PRIMARY_MODEL`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`ANTHROPIC_API_KEY` 从 `stringUpdates` 分离，写入数据库（API Key 字段标记 isSecret=true）
- [x] 4.3 其余非敏感字段（MAX_ITERATIONS 等）仍调用 `writeEnvFile`

## 5. Chat/Messages 路由使用异步 Adapter

- [x] 5.1 修改 `src/api/http/routes/chat.ts` 中调用 `createLLMAdapter` 的地方，改为 `await createLLMAdapterWithDbConfig(...)`
- [x] 5.2 修改 `src/api/http/routes/messages.ts` 中调用 `createLLMAdapter` 的地方，改为 `await createLLMAdapterWithDbConfig(...)`

## Context

系统当前用 `.env` 文件保存 LLM 敏感配置（provider、model、API Key、Base URL），由 `settings.ts` 的 `readEnvFile`/`writeEnvFile` 读写。数据库已有 `models` 表（用于用户自定义模型）和通用加密工具 `src/utils/encryption.ts`，但缺少存储系统级全局配置的机制。

## Goals / Non-Goals

**Goals:**
- 新增 `system_config` 表，以加密 key-value 方式存储系统级配置
- `GET /settings` 优先从数据库读取 LLM 配置，回退到环境变量
- `PUT /settings` 将 LLM 相关字段写数据库，不再写 `.env`
- `createLLMAdapterWithDbConfig` 异步工厂：先查数据库，再 fallback 到 env
- 数据库迁移 010 自动建表，幂等安全

**Non-Goals:**
- 不迁移 `DATABASE_URL`、`MAX_ITERATIONS` 等非敏感运维配置到数据库
- 不实现多租户隔离（system_config 是全局单一命名空间）
- 不提供 UI 级的加密 key 轮换功能

## Decisions

### D1: 表结构 — key-value with `is_secret` flag

```sql
CREATE TABLE system_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,        -- 敏感字段存密文，非敏感存明文
  is_secret INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)
```

**理由**：轻量、易扩展，不需要为每个新配置项添加列；与现有 models 表加密模式一致，复用 `encrypt/decrypt`。

### D2: 优先级链 — DB > process.env > hardcoded default

读取顺序：`SystemConfigStore.get(key)` → `process.env[key]` → 默认值。  
**理由**：保证平滑升级（旧实例数据库无值时不中断），同时允许运维通过环境变量覆盖（如容器注入）。

### D3: 敏感字段列表（写数据库时加密）

`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` 标记 `is_secret=1` 并加密存储；  
`LLM_PROVIDER`, `LLM_PRIMARY_MODEL`, `OPENAI_BASE_URL` 明文存储（`is_secret=0`）。

### D4: `createLLMAdapterWithDbConfig` 异步工厂

在 chat/messages 路由等需要 LLM adapter 的地方替换为异步版本；同步版 `createLLMAdapter` 保留，仍读 env，不破坏现有测试。

**理由**：最小化改动范围，避免大规模重构。

### D5: Settings 路由不再写 `.env` 中的 LLM 字段

`PUT /settings` 中，`LLM_PROVIDER / LLM_PRIMARY_MODEL / OPENAI_API_KEY / OPENAI_BASE_URL / ANTHROPIC_API_KEY` 从 `stringUpdates` 分离，写数据库；其余字段（MAX_ITERATIONS 等）仍走 `writeEnvFile`。

## Risks / Trade-offs

- **加密 key 变更** → 数据库中密文无法解密。缓解：`mapModelRow` 已有 try-catch 返回空串并提示重新输入，`SystemConfigStore` 复用同样模式。
- **首次部署迁移** → 数据库建表后原 `.env` 中的值不会自动导入。缓解：优先级链保证 env 仍生效，用户下次通过 UI 保存后自动写入数据库。
- **并发写** → SQLite 单写，`UPSERT` 原子操作，无竞争问题。

## Migration Plan

1. 部署新代码（含 migration 010）
2. `initDb()` 自动执行 `010_add_system_config.ts`，建立 `system_config` 表
3. 现有 `.env` 中的 LLM 配置继续通过 env fallback 工作
4. 用户在设置页面点击保存后，配置写入数据库，`.env` 对应字段可手动清理
5. 回滚：删除 migration 010 的表，恢复 settings.ts 旧逻辑

## Open Questions

- 是否需要一次性的"从 .env 自动导入"脚本？（当前方案不包含，用户下次保存即可）

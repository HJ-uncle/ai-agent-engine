import type { Client } from '@libsql/client'

export async function up(client: Client): Promise<void> {
  const statements = [
    // 模型白名单表
    `CREATE TABLE IF NOT EXISTS model_whitelists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      thinking_mode INTEGER NOT NULL DEFAULT 0,
      thinking_config TEXT,
      response_thinking_field TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(provider, model_id)
    )`,

    // 用户自定义模型配置表
    `CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      api_key TEXT NOT NULL,
      base_url TEXT NOT NULL,
      display_name TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 0,
      version TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      deleted_at INTEGER,
      UNIQUE(tenant_id, provider, model_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_models_tenant ON models(tenant_id)`
  ]

  await client.batch(statements.map((sql) => ({ sql })), 'write')

  // 初始化部分内置白名单数据
  const whitelists = [
    {
      provider: 'deepseek',
      model_id: 'deepseek-reasoner',
      thinking_mode: 1,
      thinking_config: '{"thinking":{"type":"enabled"}}',
      response_thinking_field: 'reasoning_content'
    },
    {
      provider: 'claude',
      model_id: 'claude-3-7-sonnet-20250219',
      thinking_mode: 1,
      thinking_config: '{"thinking":{"type":"enabled","budget_tokens":1024}}',
      response_thinking_field: 'thinking'
    },
    {
      provider: 'openai',
      model_id: 'o1',
      thinking_mode: 1,
      thinking_config: '{"reasoning_effort":"medium"}',
      response_thinking_field: 'content'
    },
    {
      provider: 'openai',
      model_id: 'gpt-4o',
      thinking_mode: 0,
      thinking_config: null,
      response_thinking_field: null
    },
    {
      provider: 'custom',
      model_id: 'custom-model',
      thinking_mode: 0,
      thinking_config: null,
      response_thinking_field: null
    }
  ]

  const insertStmt = `INSERT OR IGNORE INTO model_whitelists (provider, model_id, thinking_mode, thinking_config, response_thinking_field) VALUES (?, ?, ?, ?, ?)`
  
  for (const wl of whitelists) {
    await client.execute({
      sql: insertStmt,
      args: [wl.provider, wl.model_id, wl.thinking_mode, wl.thinking_config, wl.response_thinking_field]
    })
  }
}

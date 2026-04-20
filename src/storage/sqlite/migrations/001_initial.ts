import type { Client } from '@libsql/client'

export async function up(client: Client): Promise<void> {
  const statements = [
    // Conversation history
    `CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      session_id TEXT NOT NULL,
      conversation_id TEXT,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool', 'system')),
      content TEXT NOT NULL,
      tool_call_id TEXT,
      tool_call_name TEXT,
      tool_name TEXT,
      tool_args TEXT,
      tokens INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,
    `CREATE INDEX IF NOT EXISTS idx_conversations_session
      ON conversations(tenant_id, session_id, created_at)`,

    // Memory store
    `CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      session_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(tenant_id, session_id, key)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_memories_session
      ON memories(tenant_id, session_id)`,

    // Cache store
    `CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`,

    // Async job queue
    `CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
      result TEXT,
      error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      started_at INTEGER,
      completed_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_tenant ON jobs(tenant_id, status)`,

    // Quota / token usage tracking
    `CREATE TABLE IF NOT EXISTS quotas (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      date TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      requests_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(tenant_id, date)
    )`,

    // Prompt templates
    `CREATE TABLE IF NOT EXISTS prompt_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      description TEXT,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(tenant_id, name)
    )`,

    // Knowledge base documents
    `CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'text/plain',
      chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,
    `CREATE INDEX IF NOT EXISTS idx_documents_tenant ON documents(tenant_id)`,

    // Document chunks
    `CREATE TABLE IF NOT EXISTS document_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,
    `CREATE INDEX IF NOT EXISTS idx_chunks_document ON document_chunks(document_id)`,
    `CREATE INDEX IF NOT EXISTS idx_chunks_tenant ON document_chunks(tenant_id)`,

    // FTS5 full-text search index for document chunks
    `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content,
      chunk_id UNINDEXED,
      document_id UNINDEXED,
      tenant_id UNINDEXED
    )`,

    // Users (for auth, P2)
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      api_key_hash TEXT,
      email TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(tenant_id)
    )`,

    // Tool call metrics
    `CREATE TABLE IF NOT EXISTS tool_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      success INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tool_metrics_tenant ON tool_metrics(tenant_id, created_at)`,
  ]

  await client.batch(statements.map((sql) => ({ sql })), 'write')
}

export async function down(client: Client): Promise<void> {
  const statements = [
    'DROP TABLE IF EXISTS chunks_fts',
    'DROP TABLE IF EXISTS tool_metrics',
    'DROP TABLE IF EXISTS users',
    'DROP TABLE IF EXISTS document_chunks',
    'DROP TABLE IF EXISTS documents',
    'DROP TABLE IF EXISTS prompt_templates',
    'DROP TABLE IF EXISTS quotas',
    'DROP TABLE IF EXISTS jobs',
    'DROP TABLE IF EXISTS cache',
    'DROP TABLE IF EXISTS memories',
    'DROP TABLE IF EXISTS conversations',
  ]

  await client.batch(statements.map((sql) => ({ sql })), 'write')
}

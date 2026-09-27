import type { Client } from '@libsql/client'

/**
 * 011: 安全策略引擎 + 网络策略 + LSP 诊断缓存
 *
 * - security_policies         命令安全策略规则（命令白/黑/问，支持参数正则）
 * - security_audit_log        所有安全决策的审计日志（命令 + 网络）
 * - network_policies          单行 JSON 配置（默认 id=1）
 * - lsp_diagnostics_cache     按文件内容 hash 缓存诊断结果
 *
 * 工具调用统计复用已有的 tool_metrics 表（migration 001）。
 */
export async function up(db: Client): Promise<void> {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS security_policies (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      command      TEXT NOT NULL,
      arg_pattern  TEXT,
      action       TEXT NOT NULL CHECK(action IN ('allow','ask','deny')),
      priority     INTEGER NOT NULL DEFAULT 100,
      enabled      INTEGER NOT NULL DEFAULT 1,
      description  TEXT,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sec_policies_cmd ON security_policies(command, enabled)`,

    `CREATE TABLE IF NOT EXISTS security_audit_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id     TEXT NOT NULL DEFAULT 'default',
      session_id    TEXT,
      category      TEXT NOT NULL CHECK(category IN ('cmd','network','fs','lsp')),
      target        TEXT NOT NULL,
      details       TEXT,
      decision      TEXT NOT NULL CHECK(decision IN ('allow','ask','deny','error')),
      rule_id       INTEGER,
      reason        TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    )`,
    `CREATE INDEX IF NOT EXISTS idx_audit_log_time ON security_audit_log(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_log_cat  ON security_audit_log(category, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON security_audit_log(tenant_id, created_at DESC)`,

    `CREATE TABLE IF NOT EXISTS network_policies (
      id          INTEGER PRIMARY KEY CHECK(id = 1),
      config      TEXT NOT NULL,
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    `CREATE TABLE IF NOT EXISTS lsp_diagnostics_cache (
      file_path    TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      language     TEXT NOT NULL,
      diagnostics  TEXT NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (file_path, content_hash)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_lsp_cache_time ON lsp_diagnostics_cache(created_at DESC)`,
  ]
  for (const sql of stmts) await db.execute(sql)
}

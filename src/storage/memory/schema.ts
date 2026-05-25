export const MEMORY_SCHEMA: string[] = [
  // ─── 图谱元信息 ──────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS memory_graph_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── 记忆节点 ────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS memory_nodes (
    id                TEXT PRIMARY KEY,
    tenant_id         TEXT NOT NULL DEFAULT 'default',
    session_id        TEXT NOT NULL,
    type              TEXT NOT NULL CHECK(type IN (
                        'preference','decision','fact','lesson','narrative','milestone'
                      )),
    timestamp         INTEGER NOT NULL,
    last_accessed     INTEGER NOT NULL DEFAULT (unixepoch()),
    strength          REAL NOT NULL DEFAULT 1.0 CHECK(strength >= 0.0 AND strength <= 1.0),
    importance        REAL NOT NULL DEFAULT 0.5 CHECK(importance >= 0.0 AND importance <= 1.0),
    summary           TEXT NOT NULL,
    detail            TEXT,
    trigger_context   TEXT,
    emotional_valence REAL DEFAULT 0.0 CHECK(emotional_valence >= -1.0 AND emotional_valence <= 1.0),
    emotional_trigger TEXT,
    source_session_id TEXT,
    source_interaction_index INTEGER,
    source_tools_used TEXT,
    source_context_snapshot TEXT,
    decay_rate        REAL NOT NULL DEFAULT 0.01 CHECK(decay_rate >= 0.0),
    last_strength_update INTEGER NOT NULL DEFAULT (unixepoch()),
    embedding_json    TEXT,
    embedding         F32_BLOB(1536),
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  `CREATE INDEX IF NOT EXISTS idx_memory_nodes_tenant
    ON memory_nodes(tenant_id)`,

  `CREATE INDEX IF NOT EXISTS idx_memory_nodes_embedding
    ON memory_nodes(libsql_vector_idx(embedding))`,

  `CREATE INDEX IF NOT EXISTS idx_memory_nodes_session
    ON memory_nodes(tenant_id, session_id)`,

  `CREATE INDEX IF NOT EXISTS idx_memory_nodes_type
    ON memory_nodes(tenant_id, type)`,

  `CREATE INDEX IF NOT EXISTS idx_memory_nodes_strength
    ON memory_nodes(tenant_id, strength)`,

  `CREATE INDEX IF NOT EXISTS idx_memory_nodes_importance
    ON memory_nodes(tenant_id, importance DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_memory_nodes_accessed
    ON memory_nodes(tenant_id, last_accessed)`,

  `CREATE INDEX IF NOT EXISTS idx_memory_nodes_timestamp
    ON memory_nodes(tenant_id, timestamp DESC)`,

  // ─── 记忆关联边 ──────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS memory_edges (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL DEFAULT 'default',
    source_node_id  TEXT NOT NULL,
    target_node_id  TEXT NOT NULL,
    type            TEXT NOT NULL CHECK(type IN (
                      'reinforces','contradicts','leads_to','part_of',
                      'similar_to','tagged_with'
                    )),
    strength        REAL NOT NULL DEFAULT 0.5 CHECK(strength >= 0.0 AND strength <= 1.0),
    description     TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (source_node_id) REFERENCES memory_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target_node_id) REFERENCES memory_nodes(id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS idx_memory_edges_tenant
    ON memory_edges(tenant_id)`,

  `CREATE INDEX IF NOT EXISTS idx_memory_edges_source
    ON memory_edges(source_node_id)`,

  `CREATE INDEX IF NOT EXISTS idx_memory_edges_target
    ON memory_edges(target_node_id)`,

  `CREATE INDEX IF NOT EXISTS idx_memory_edges_type
    ON memory_edges(tenant_id, type)`,

  // ─── 标签表 ──────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS memory_tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id  TEXT NOT NULL DEFAULT 'default',
    name       TEXT NOT NULL,
    UNIQUE(tenant_id, name)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_memory_tags_tenant
    ON memory_tags(tenant_id)`,

  // ─── 节点-标签 多对多关联表 ──────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS memory_node_tags (
    node_id TEXT NOT NULL,
    tag_id  INTEGER NOT NULL,
    PRIMARY KEY(node_id, tag_id),
    FOREIGN KEY (node_id) REFERENCES memory_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id)  REFERENCES memory_tags(id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS idx_memory_node_tags_tag
    ON memory_node_tags(tag_id)`,
]

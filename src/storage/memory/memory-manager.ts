import { getMemoryDb } from './db.js'
import type { InValue } from '@libsql/client'
import type {
  MemoryManager,
  MemoryNode,
  MemoryEdge,
  MemoryGraphMeta,
  MemoryContext,
  MemoryNodeType,
  MemoryEdgeType,
  MemoryNodeFilter,
  CreateMemoryNodeInput,
  UpdateMemoryNodeInput,
  CreateMemoryEdgeInput,
} from './types.js'
import { v4 as uuidv4 } from 'uuid'

function mapNodeRow(row: Record<string, unknown>): MemoryNode {
  return {
    id: row['id'] as string,
    tenantId: row['tenant_id'] as string,
    sessionId: row['session_id'] as string,
    type: row['type'] as MemoryNodeType,
    timestamp: row['timestamp'] as number,
    lastAccessed: row['last_accessed'] as number,
    strength: row['strength'] as number,
    importance: row['importance'] as number,
    summary: row['summary'] as string,
    detail: (row['detail'] as string) || null,
    triggerContext: (row['trigger_context'] as string) || null,
    emotionalValence: (row['emotional_valence'] as number) ?? 0,
    emotionalTrigger: (row['emotional_trigger'] as string) || null,
    sourceSessionId: (row['source_session_id'] as string) || null,
    sourceInteractionIndex: (row['source_interaction_index'] as number) ?? null,
    sourceToolsUsed: row['source_tools_used']
      ? JSON.parse(row['source_tools_used'] as string)
      : null,
    sourceContextSnapshot: (row['source_context_snapshot'] as string) || null,
    decayRate: (row['decay_rate'] as number) ?? 0.01,
    lastStrengthUpdate: row['last_strength_update'] as number,
    embeddingJson: (row['embedding_json'] as string) || null,
    embedding: row['embedding'] ? Array.from(new Float32Array(row['embedding'] as ArrayBuffer)) : undefined,
    createdAt: row['created_at'] as number,
    updatedAt: row['updated_at'] as number,
  }
}

function mapEdgeRow(row: Record<string, unknown>): MemoryEdge {
  return {
    id: row['id'] as string,
    tenantId: row['tenant_id'] as string,
    sourceNodeId: row['source_node_id'] as string,
    targetNodeId: row['target_node_id'] as string,
    type: row['type'] as MemoryEdgeType,
    strength: row['strength'] as number,
    description: (row['description'] as string) || null,
    createdAt: row['created_at'] as number,
  }
}

export class SQLiteMemoryManager implements MemoryManager {
  // ── Node CRUD ──────────────────────────────────────────────────────────

  async createNode(input: CreateMemoryNodeInput, ctx: MemoryContext): Promise<MemoryNode> {
    const db = getMemoryDb()
    const id = uuidv4()
    const now = Math.floor(Date.now() / 1000)
    const timestamp = input.timestamp ?? now

    const hasEmbedding = input.embedding !== undefined && input.embedding !== null

    await db.execute({
      sql: `INSERT INTO memory_nodes (
              id, tenant_id, session_id, type, timestamp,
              strength, importance, summary, detail, trigger_context,
              emotional_valence, emotional_trigger,
              source_session_id, source_interaction_index,
              source_tools_used, source_context_snapshot,
              decay_rate, last_strength_update,
              embedding_json, embedding,
              created_at, updated_at
            ) VALUES (
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?,
              ?, ?,
              ?, ?,
              ?, ?,
              ?, ?,
              ?, ${hasEmbedding ? 'vector32(?)' : 'NULL'},
              ?, ?
            )`,
      args: [
        id,
        ctx.tenantId,
        ctx.sessionId,
        input.type,
        timestamp,
        input.strength ?? 1.0,
        input.importance ?? 0.5,
        input.summary,
        input.detail ?? null,
        input.triggerContext ?? null,
        input.emotionalValence ?? 0,
        input.emotionalTrigger ?? null,
        input.sourceSessionId ?? null,
        input.sourceInteractionIndex ?? null,
        input.sourceToolsUsed ? JSON.stringify(input.sourceToolsUsed) : null,
        input.sourceContextSnapshot ?? null,
        input.decayRate ?? 0.01,
        now,
        input.embedding ? JSON.stringify(input.embedding) : null,
        ...(hasEmbedding ? [JSON.stringify(input.embedding)] : []),
        now,
        now,
      ],
    })

    if (input.tags && input.tags.length > 0) {
      await this._attachTags(id, input.tags, ctx)
    }

    return (await this.getNode(id, ctx))!
  }

  async getNode(id: string, ctx: MemoryContext): Promise<MemoryNode | null> {
    const db = getMemoryDb()
    const result = await db.execute({
      sql: 'SELECT * FROM memory_nodes WHERE id = ? AND tenant_id = ?',
      args: [id, ctx.tenantId],
    })
    if (result.rows.length === 0) return null

    const node = mapNodeRow(result.rows[0] as unknown as Record<string, unknown>)
    node.tags = await this._readTags(id, ctx)
    return node
  }

  async updateNode(
    id: string,
    updates: UpdateMemoryNodeInput,
    ctx: MemoryContext,
  ): Promise<MemoryNode | null> {
    const db = getMemoryDb()
    const sets: string[] = []
    const args: InValue[] = []

    if (updates.type !== undefined) { sets.push('type = ?'); args.push(updates.type) }
    if (updates.strength !== undefined) { sets.push('strength = ?'); args.push(updates.strength) }
    if (updates.importance !== undefined) { sets.push('importance = ?'); args.push(updates.importance) }
    if (updates.summary !== undefined) { sets.push('summary = ?'); args.push(updates.summary) }
    if (updates.detail !== undefined) { sets.push('detail = ?'); args.push(updates.detail) }
    if (updates.triggerContext !== undefined) { sets.push('trigger_context = ?'); args.push(updates.triggerContext) }
    if (updates.emotionalValence !== undefined) { sets.push('emotional_valence = ?'); args.push(updates.emotionalValence) }
    if (updates.emotionalTrigger !== undefined) { sets.push('emotional_trigger = ?'); args.push(updates.emotionalTrigger) }
    if (updates.decayRate !== undefined) { sets.push('decay_rate = ?'); args.push(updates.decayRate) }
    if (updates.lastAccessed !== undefined) { sets.push('last_accessed = ?'); args.push(updates.lastAccessed) }
    if (updates.embeddingJson !== undefined) { sets.push('embedding_json = ?'); args.push(updates.embeddingJson) }
    if (updates.embedding !== undefined) { 
      if (updates.embedding === null) {
        sets.push('embedding = NULL'); 
      } else {
        sets.push('embedding = vector32(?)'); 
        args.push(JSON.stringify(updates.embedding));
      }
    }

    if (sets.length === 0) return this.getNode(id, ctx)

    sets.push('updated_at = (unixepoch())')
    args.push(id, ctx.tenantId)

    await db.execute({
      sql: `UPDATE memory_nodes SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`,
      args,
    })

    return this.getNode(id, ctx)
  }

  async deleteNode(id: string, ctx: MemoryContext): Promise<void> {
    const db = getMemoryDb()
    await db.execute({
      sql: 'DELETE FROM memory_nodes WHERE id = ? AND tenant_id = ?',
      args: [id, ctx.tenantId],
    })
  }

  // ── Node Queries ───────────────────────────────────────────────────────

  async listNodes(filter: MemoryNodeFilter, ctx: MemoryContext): Promise<MemoryNode[]> {
    const db = getMemoryDb()
    const conditions: string[] = ['tenant_id = ?']
    const args: InValue[] = [ctx.tenantId]

    if (filter.types && filter.types.length > 0) {
      conditions.push(`type IN (${filter.types.map(() => '?').join(',')})`)
      args.push(...filter.types)
    }
    if (filter.minStrength !== undefined) {
      conditions.push('strength >= ?')
      args.push(filter.minStrength)
    }
    if (filter.maxStrength !== undefined) {
      conditions.push('strength <= ?')
      args.push(filter.maxStrength)
    }
    if (filter.minImportance !== undefined) {
      conditions.push('importance >= ?')
      args.push(filter.minImportance)
    }
    if (filter.sessionId) {
      conditions.push('session_id = ?')
      args.push(filter.sessionId)
    }

    if (filter.tags && filter.tags.length > 0) {
      const placeholders = filter.tags.map(() => '?').join(',')
      conditions.push(`id IN (
        SELECT mnt.node_id FROM memory_node_tags mnt
        JOIN memory_tags mt ON mt.id = mnt.tag_id
        WHERE mt.name IN (${placeholders}) AND mt.tenant_id = ?
      )`)
      args.push(...filter.tags, ctx.tenantId)
    }

    const orderBy = filter.orderBy ?? 'timestamp'
    const columnMap: Record<string, string> = {
      timestamp: 'timestamp',
      strength: 'strength',
      importance: 'importance',
      last_accessed: 'last_accessed',
    }
    const orderDir = filter.orderDir ?? 'DESC'
    const limit = filter.limit ?? 50
    const offset = filter.offset ?? 0

    const result = await db.execute({
      sql: `SELECT * FROM memory_nodes
            WHERE ${conditions.join(' AND ')}
            ORDER BY ${columnMap[orderBy] || 'timestamp'} ${orderDir}
            LIMIT ? OFFSET ?`,
      args: [...args, limit, offset],
    })

    const nodes = result.rows.map((r) => mapNodeRow(r as unknown as Record<string, unknown>))
    for (const node of nodes) {
      node.tags = await this._readTags(node.id, ctx)
    }
    return nodes
  }

  async recallByTags(tags: string[], ctx: MemoryContext): Promise<MemoryNode[]> {
    return this.listNodes({ tags, orderBy: 'strength', limit: 30 }, ctx)
  }

  async recallRecent(limit: number, ctx: MemoryContext): Promise<MemoryNode[]> {
    return this.listNodes({ orderBy: 'timestamp', limit }, ctx)
  }

  async recallImportant(minImportance: number, ctx: MemoryContext): Promise<MemoryNode[]> {
    return this.listNodes({ minImportance, orderBy: 'importance', limit: 50 }, ctx)
  }

  async recallBySession(sessionId: string, ctx: MemoryContext): Promise<MemoryNode[]> {
    return this.listNodes({ sessionId, orderBy: 'timestamp', limit: 100 }, ctx)
  }

  async recallSimilar(embedding: number[], limit: number, ctx: MemoryContext): Promise<MemoryNode[]> {
    const db = getMemoryDb()
    const result = await db.execute({
      sql: `SELECT *, vector_distance_cos(embedding, vector32(?)) as distance
            FROM memory_nodes
            WHERE tenant_id = ?
            ORDER BY distance ASC
            LIMIT ?`,
      args: [JSON.stringify(embedding), ctx.tenantId, limit],
    })

    const nodes = result.rows.map((r) => mapNodeRow(r as unknown as Record<string, unknown>))
    for (const node of nodes) {
      node.tags = await this._readTags(node.id, ctx)
    }
    return nodes
  }

  // ── Edge CRUD ──────────────────────────────────────────────────────────

  async createEdge(input: CreateMemoryEdgeInput, ctx: MemoryContext): Promise<MemoryEdge> {
    const db = getMemoryDb()
    const id = uuidv4()
    const now = Math.floor(Date.now() / 1000)

    await db.execute({
      sql: `INSERT INTO memory_edges (id, tenant_id, source_node_id, target_node_id, type, strength, description, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        ctx.tenantId,
        input.sourceNodeId,
        input.targetNodeId,
        input.type,
        input.strength ?? 0.5,
        input.description ?? null,
        now,
      ],
    })

    const result = await db.execute({
      sql: 'SELECT * FROM memory_edges WHERE id = ? AND tenant_id = ?',
      args: [id, ctx.tenantId],
    })
    return mapEdgeRow(result.rows[0] as unknown as Record<string, unknown>)
  }

  async deleteEdge(id: string, ctx: MemoryContext): Promise<void> {
    const db = getMemoryDb()
    await db.execute({
      sql: 'DELETE FROM memory_edges WHERE id = ? AND tenant_id = ?',
      args: [id, ctx.tenantId],
    })
  }

  async getEdges(nodeId: string, ctx: MemoryContext): Promise<MemoryEdge[]> {
    const db = getMemoryDb()
    const result = await db.execute({
      sql: `SELECT * FROM memory_edges
            WHERE tenant_id = ? AND (source_node_id = ? OR target_node_id = ?)`,
      args: [ctx.tenantId, nodeId, nodeId],
    })
    return result.rows.map((r) => mapEdgeRow(r as unknown as Record<string, unknown>))
  }

  // ── Graph Traversal ────────────────────────────────────────────────────

  async getNeighbors(
    nodeId: string,
    edgeTypes?: MemoryEdgeType[],
    ctx?: MemoryContext,
  ): Promise<MemoryNode[]> {
    const db = getMemoryDb()
    const tenantId = ctx?.tenantId ?? 'default'

    let typeFilter = ''
    const args: InValue[] = [tenantId, nodeId, nodeId]
    if (edgeTypes && edgeTypes.length > 0) {
      typeFilter = `AND e.type IN (${edgeTypes.map(() => '?').join(',')})`
      args.push(...edgeTypes)
    }

    const result = await db.execute({
      sql: `SELECT DISTINCT n.* FROM memory_nodes n
            JOIN memory_edges e ON (
              (e.source_node_id = n.id OR e.target_node_id = n.id)
              AND (e.source_node_id = ? OR e.target_node_id = ?)
            )
            WHERE n.tenant_id = ? AND n.id != ? ${typeFilter}
            ORDER BY n.strength DESC`,
      args: [nodeId, nodeId, tenantId, nodeId, ...args.slice(1)],
    })

    const nodes = result.rows.map((r) => mapNodeRow(r as unknown as Record<string, unknown>))
    for (const node of nodes) {
      node.tags = await this._readTags(node.id, { tenantId, sessionId: '' })
    }
    return nodes
  }

  async traversePath(
    startNodeId: string,
    maxHops: number,
    edgeTypes?: MemoryEdgeType[],
    ctx?: MemoryContext,
  ): Promise<MemoryNode[]> {
    if (maxHops < 1) return []
    const db = getMemoryDb()
    const tenantId = ctx?.tenantId ?? 'default'

    let typeFilter = ''
    const args: InValue[] = [startNodeId, tenantId]
    if (edgeTypes && edgeTypes.length > 0) {
      typeFilter = `AND type IN (${edgeTypes.map(() => '?').join(',')})`
      args.push(...edgeTypes)
    }

    const sql = `
      WITH RECURSIVE traverse(node_id, hop) AS (
        SELECT ? AS node_id, 0 AS hop
        UNION
        SELECT CASE
                 WHEN e.source_node_id = t.node_id THEN e.target_node_id
                 ELSE e.source_node_id
               END AS next_node,
               t.hop + 1
        FROM traverse t
        JOIN memory_edges e ON (e.source_node_id = t.node_id OR e.target_node_id = t.node_id)
        WHERE e.tenant_id = ? ${typeFilter} AND t.hop < ?
      )
      SELECT DISTINCT n.* FROM traverse t
      JOIN memory_nodes n ON n.id = t.node_id
      WHERE t.node_id != ? AND n.tenant_id = ?
    `
    args.push(maxHops, startNodeId, tenantId)

    const result = await db.execute({ sql, args })
    const nodes = result.rows.map((r) => mapNodeRow(r as unknown as Record<string, unknown>))
    for (const node of nodes) {
      node.tags = await this._readTags(node.id, { tenantId, sessionId: '' })
    }
    return nodes
  }

  async getRelatedNodes(
    nodeIds: string[],
    edgeTypes?: MemoryEdgeType[],
    ctx?: MemoryContext,
  ): Promise<MemoryNode[]> {
    if (nodeIds.length === 0) return []

    const db = getMemoryDb()
    const tenantId = ctx?.tenantId ?? 'default'

    let typeFilter = ''
    const args: InValue[] = [tenantId]
    if (edgeTypes && edgeTypes.length > 0) {
      typeFilter = `AND e.type IN (${edgeTypes.map(() => '?').join(',')})`
      args.push(...edgeTypes)
    }

    const sourcePlaceholders = nodeIds.map(() => '?').join(',')
    const targetPlaceholders = nodeIds.map(() => '?').join(',')

    const result = await db.execute({
      sql: `SELECT DISTINCT n.* FROM memory_nodes n
            JOIN memory_edges e ON (
              e.source_node_id = n.id OR e.target_node_id = n.id
            )
            WHERE n.tenant_id = ?
              AND (e.source_node_id IN (${sourcePlaceholders})
                   OR e.target_node_id IN (${targetPlaceholders}))
              AND n.id NOT IN (${sourcePlaceholders})
              ${typeFilter}
            ORDER BY n.strength DESC`,
      args: [...args, ...nodeIds, ...nodeIds, ...nodeIds],
    })

    const nodes = result.rows.map((r) => mapNodeRow(r as unknown as Record<string, unknown>))
    for (const node of nodes) {
      node.tags = await this._readTags(node.id, { tenantId, sessionId: '' })
    }
    return nodes
  }

  // ── Tags ───────────────────────────────────────────────────────────────

  async addTag(nodeId: string, tag: string, ctx: MemoryContext): Promise<void> {
    const db = getMemoryDb()

    await db.execute({
      sql: 'INSERT OR IGNORE INTO memory_tags (tenant_id, name) VALUES (?, ?)',
      args: [ctx.tenantId, tag],
    })

    const tagResult = await db.execute({
      sql: 'SELECT id FROM memory_tags WHERE tenant_id = ? AND name = ?',
      args: [ctx.tenantId, tag],
    })
    if (tagResult.rows.length === 0) return

    const tagId = tagResult.rows[0]['id'] as number

    await db.execute({
      sql: 'INSERT OR IGNORE INTO memory_node_tags (node_id, tag_id) VALUES (?, ?)',
      args: [nodeId, tagId],
    })
  }

  async removeTag(nodeId: string, tag: string, ctx: MemoryContext): Promise<void> {
    const db = getMemoryDb()
    await db.execute({
      sql: `DELETE FROM memory_node_tags
            WHERE node_id = ?
              AND tag_id IN (SELECT id FROM memory_tags WHERE tenant_id = ? AND name = ?)`,
      args: [nodeId, ctx.tenantId, tag],
    })
  }

  async getTags(nodeId: string, ctx: MemoryContext): Promise<string[]> {
    return this._readTags(nodeId, ctx)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async decayNodes(ctx: MemoryContext): Promise<number> {
    const db = getMemoryDb()
    const now = Math.floor(Date.now() / 1000)

    const result = await db.execute({
      sql: `UPDATE memory_nodes
            SET strength = MAX(0.0, strength - (decay_rate * (? - last_strength_update) / 86400.0)),
                last_strength_update = ?,
                updated_at = ?
            WHERE tenant_id = ?
              AND strength > 0
              AND last_strength_update < ? - 3600`,
      args: [now, now, now, ctx.tenantId, now],
    })

    return result.rowsAffected
  }

  async consolidate(ctx: MemoryContext): Promise<string> {
    const db = getMemoryDb()
    const now = Math.floor(Date.now() / 1000)
    const iso = new Date(now * 1000).toISOString()

    const countResult = await db.execute({
      sql: `SELECT
              COUNT(*) AS total_nodes,
              COUNT(DISTINCT CASE WHEN strength < 0.2 THEN id END) AS weak_nodes
            FROM memory_nodes WHERE tenant_id = ?`,
      args: [ctx.tenantId],
    })

    const row = countResult.rows[0] as unknown as Record<string, number>
    const totalNodes = row['total_nodes'] ?? 0
    const weakNodes = row['weak_nodes'] ?? 0

    await db.execute({
      sql: `INSERT OR REPLACE INTO memory_graph_meta (key, value, updated_at)
            VALUES ('last_consolidation', ?, ?)`,
      args: [iso, now],
    })

    const entries = [
      `## Memory Graph Consolidation Report`,
      `- Timestamp: ${iso}`,
      `- Total Nodes: ${totalNodes}`,
      `- Weak Nodes (strength < 0.2): ${weakNodes}`,
      `- Tenant: ${ctx.tenantId}`,
    ]

    return entries.join('\n')
  }

  // ── Graph Meta ─────────────────────────────────────────────────────────

  async getGraphMeta(ctx: MemoryContext): Promise<MemoryGraphMeta> {
    const db = getMemoryDb()

    const nodeCount = await db.execute({
      sql: 'SELECT COUNT(*) AS cnt FROM memory_nodes WHERE tenant_id = ?',
      args: [ctx.tenantId],
    })
    const edgeCount = await db.execute({
      sql: 'SELECT COUNT(*) AS cnt FROM memory_edges WHERE tenant_id = ?',
      args: [ctx.tenantId],
    })
    const metaRows = await db.execute({
      sql: "SELECT key, value FROM memory_graph_meta WHERE key IN ('version','last_consolidation','owner','description')",
      args: [],
    })

    const metaMap: Record<string, string | null> = {}
    for (const r of metaRows.rows) {
      metaMap[r['key'] as string] = r['value'] as string
    }

    return {
      version: metaMap['version'] || '1.0',
      lastConsolidation: metaMap['last_consolidation'] || null,
      totalNodes: (nodeCount.rows[0] as unknown as Record<string, number>)['cnt'] ?? 0,
      totalEdges: (edgeCount.rows[0] as unknown as Record<string, number>)['cnt'] ?? 0,
      owner: metaMap['owner'] || null,
      description: metaMap['description'] || null,
    }
  }

  // ── Bulk Write ─────────────────────────────────────────────────────────

  async writeBatch(
    nodes: CreateMemoryNodeInput[],
    edges: CreateMemoryEdgeInput[],
    ctx: MemoryContext,
  ): Promise<{ nodes: MemoryNode[]; edges: MemoryEdge[] }> {
    const createdNodes: MemoryNode[] = []
    for (const nodeInput of nodes) {
      createdNodes.push(await this.createNode(nodeInput, ctx))
    }

    const createdEdges: MemoryEdge[] = []
    for (const edgeInput of edges) {
      createdEdges.push(await this.createEdge(edgeInput, ctx))
    }

    return { nodes: createdNodes, edges: createdEdges }
  }

  // ── Private Helpers ────────────────────────────────────────────────────

  private async _readTags(nodeId: string, ctx: MemoryContext): Promise<string[]> {
    const db = getMemoryDb()
    const result = await db.execute({
      sql: `SELECT mt.name FROM memory_tags mt
            JOIN memory_node_tags mnt ON mnt.tag_id = mt.id
            WHERE mnt.node_id = ? AND mt.tenant_id = ?`,
      args: [nodeId, ctx.tenantId],
    })
    return result.rows.map((r) => r['name'] as string)
  }

  private async _attachTags(
    nodeId: string,
    tags: string[],
    ctx: MemoryContext,
  ): Promise<void> {
    for (const tag of tags) {
      await this.addTag(nodeId, tag, ctx)
    }
  }
}

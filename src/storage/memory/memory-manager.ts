import { getMemoryDb } from './db.js'
import type { InValue } from '@libsql/client'
import type { MemoryManager, MemoryNode, MemoryEdge, MemoryGraphMeta, MemoryContext, MemoryScope, MemoryNodeType, MemoryEdgeType, MemoryNodeFilter, CreateMemoryNodeInput, UpdateMemoryNodeInput, CreateMemoryEdgeInput } from './types.js'
import { v4 as uuidv4 } from 'uuid'

type Executor = { execute(stmt: { sql: string; args: InValue[] } | string): Promise<any> }

function normalizeContext(ctx?: MemoryContext): Required<MemoryContext> {
  const tenantId = ctx?.tenantId || 'default'
  const scope: MemoryScope = ctx?.scope ?? 'global'
  const sessionId = ctx?.sessionId ?? ''
  if (scope === 'session' && sessionId.trim().length === 0) throw new Error('session scope requires a non-empty sessionId')
  return { tenantId, sessionId, scope }
}
function scoped(alias: string, ctx: Required<MemoryContext>): { sql: string; args: InValue[] } {
  const p = alias ? `${alias}.` : ''; const args: InValue[] = [ctx.tenantId, ctx.scope]
  let sql = `${p}tenant_id = ? AND ${p}scope = ?`
  if (ctx.scope === 'session') { sql += ` AND ${p}session_id = ?`; args.push(ctx.sessionId) }
  return { sql, args }
}
function mapNodeRow(row: Record<string, unknown>): MemoryNode {
  const embeddingJson = (row.embedding_json as string) || null
  let jsonEmbedding: number[] | undefined
  if (embeddingJson) { try { jsonEmbedding = JSON.parse(embeddingJson) } catch { jsonEmbedding = undefined } }
  return { id: row.id as string, tenantId: row.tenant_id as string, scope: (row.scope as MemoryScope) || 'global', sessionId: (row.session_id as string) || '', type: row.type as MemoryNodeType, timestamp: row.timestamp as number, lastAccessed: row.last_accessed as number, strength: row.strength as number, importance: row.importance as number, summary: row.summary as string, detail: (row.detail as string) || null, triggerContext: (row.trigger_context as string) || null, emotionalValence: (row.emotional_valence as number) ?? 0, emotionalTrigger: (row.emotional_trigger as string) || null, sourceSessionId: (row.source_session_id as string) || null, sourceInteractionIndex: (row.source_interaction_index as number) ?? null, sourceToolsUsed: row.source_tools_used ? JSON.parse(row.source_tools_used as string) : null, sourceContextSnapshot: (row.source_context_snapshot as string) || null, decayRate: (row.decay_rate as number) ?? 0.01, lastStrengthUpdate: row.last_strength_update as number, embeddingJson, embedding: row.embedding ? Array.from(new Float32Array(row.embedding as ArrayBuffer)) : jsonEmbedding, createdAt: row.created_at as number, updatedAt: row.updated_at as number }
}
function mapEdgeRow(row: Record<string, unknown>): MemoryEdge {
  return { id: row.id as string, tenantId: row.tenant_id as string, scope: (row.scope as MemoryScope) || 'global', sessionId: (row.session_id as string) || '', sourceNodeId: row.source_node_id as string, targetNodeId: row.target_node_id as string, type: row.type as MemoryEdgeType, strength: row.strength as number, description: (row.description as string) || null, createdAt: row.created_at as number }
}
function cosineDistance(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return Number.POSITIVE_INFINITY
  let dot = 0; let aa = 0; let bb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i] }
  if (aa === 0 || bb === 0) return Number.POSITIVE_INFINITY
  return 1 - dot / Math.sqrt(aa * bb)
}

export class SQLiteMemoryManager implements MemoryManager {
  async createNode(input: CreateMemoryNodeInput, ctx: MemoryContext, executor?: Executor): Promise<MemoryNode> {
    const c = normalizeContext(ctx)
    const db = executor ?? getMemoryDb()
    const id = uuidv4()
    const now = Math.floor(Date.now() / 1000)
    const commonArgs: InValue[] = [
      id, c.tenantId, c.scope, c.sessionId, input.type, input.timestamp ?? now,
      input.strength ?? 1, input.importance ?? 0.5, input.summary, input.detail ?? null,
      input.triggerContext ?? null, input.emotionalValence ?? 0, input.emotionalTrigger ?? null,
      input.sourceSessionId ?? null, input.sourceInteractionIndex ?? null,
      input.sourceToolsUsed ? JSON.stringify(input.sourceToolsUsed) : null,
      input.sourceContextSnapshot ?? null, input.decayRate ?? 0.01, now,
      input.embedding ? JSON.stringify(input.embedding) : null,
    ]
    const columns = 'id,tenant_id,scope,session_id,type,timestamp,strength,importance,summary,detail,trigger_context,emotional_valence,emotional_trigger,source_session_id,source_interaction_index,source_tools_used,source_context_snapshot,decay_rate,last_strength_update,embedding_json,embedding,created_at,updated_at'
    const values = '?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,vector32(?),?,?'
    const plainValues = '?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,NULL,?,?'
    try {
      await db.execute({ sql: `INSERT INTO memory_nodes (${columns}) VALUES (${input.embedding ? values : plainValues})`, args: input.embedding ? [...commonArgs, JSON.stringify(input.embedding), now, now] : [...commonArgs, now, now] })
    } catch (error) {
      // Local SQLite builds without the vector extension still support the
      // JSON embedding fallback.  Retry the insert with a NULL vector column.
      if (!input.embedding || !/vector32|vector/i.test(String((error as Error)?.message))) throw error
      await db.execute({ sql: `INSERT INTO memory_nodes (${columns}) VALUES (${plainValues})`, args: [...commonArgs, now, now] })
    }
    if (input.tags?.length) await this._attachTags(id, input.tags, c, db)
    return (await this.getNode(id, c, db))!
  }
  async getNode(id: string, ctx: MemoryContext, executor?: Executor): Promise<MemoryNode | null> { const c = normalizeContext(ctx); const db = executor ?? getMemoryDb(); const s = scoped('', c); const r = await db.execute({ sql: `SELECT * FROM memory_nodes WHERE id=? AND ${s.sql}`, args: [id, ...s.args] }); if (!r.rows.length) return null; const node = mapNodeRow(r.rows[0] as Record<string, unknown>); node.tags = await this._readTags(id, c, db); return node }
  async updateNode(id: string, updates: UpdateMemoryNodeInput, ctx: MemoryContext): Promise<MemoryNode | null> {
    const c = normalizeContext(ctx); const db = getMemoryDb(); const sets: string[] = []; const args: InValue[] = []; const add = (col: string, value: InValue) => { sets.push(`${col}=?`); args.push(value) }
    if (updates.type !== undefined) add('type', updates.type); if (updates.strength !== undefined) add('strength', updates.strength); if (updates.importance !== undefined) add('importance', updates.importance); if (updates.summary !== undefined) add('summary', updates.summary); if (updates.detail !== undefined) add('detail', updates.detail); if (updates.triggerContext !== undefined) add('trigger_context', updates.triggerContext); if (updates.emotionalValence !== undefined) add('emotional_valence', updates.emotionalValence); if (updates.emotionalTrigger !== undefined) add('emotional_trigger', updates.emotionalTrigger); if (updates.decayRate !== undefined) add('decay_rate', updates.decayRate); if (updates.lastAccessed !== undefined) add('last_accessed', updates.lastAccessed); if (updates.embeddingJson !== undefined) add('embedding_json', updates.embeddingJson)
    // A changed summary/detail invalidates an embedding generated from the old
    // text.  Clear both representations unless the caller supplied a fresh
    // embedding explicitly, preventing stale semantic recall.
    const textChanged = updates.summary !== undefined || updates.detail !== undefined
    if (textChanged && updates.embedding === undefined && updates.embeddingJson === undefined) {
      sets.push('embedding_json=NULL', 'embedding=NULL')
    }
    if (updates.embedding !== undefined) { if (updates.embedding === null) { sets.push('embedding=NULL', 'embedding_json=NULL') } else { sets.push('embedding=vector32(?)', 'embedding_json=?'); args.push(JSON.stringify(updates.embedding), JSON.stringify(updates.embedding)) } }
    const hasTags = updates.tags !== undefined
    if (!sets.length && !hasTags) return this.getNode(id, c)
    sets.push('updated_at=unixepoch()')
    const s = scoped('', c)
    try {
      if (sets.length) await db.execute({ sql: `UPDATE memory_nodes SET ${sets.join(',')} WHERE id=? AND ${s.sql}`, args: [...args, id, ...s.args] })
    } catch (error) {
      if (updates.embedding === undefined || updates.embedding === null || !/vector32|vector/i.test(String((error as Error)?.message))) throw error
      const fallbackSets = sets.map(set => set.startsWith('embedding=vector32(?)') ? 'embedding=NULL' : set)
      // embedding_json remains valid in vector-extension-free SQLite builds.
      const fallbackArgs = updates.embedding !== undefined && updates.embedding !== null
        ? [...args.slice(0, -2), args[args.length - 1]]
        : args
      await db.execute({ sql: `UPDATE memory_nodes SET ${fallbackSets.join(',')} WHERE id=? AND ${s.sql}`, args: [...fallbackArgs, id, ...s.args] })
    }
    if (hasTags) {
      // Verify ownership before replacing labels.  A scoped update must never
      // mutate a node visible only from another tenant/session.
      const owned = await this.getNode(id, c, db)
      if (!owned) return null
      const tags = Array.from(new Set((updates.tags ?? []).map(tag => String(tag).trim()).filter(Boolean)))
      const tx = await db.transaction('write')
      try {
        await tx.execute({ sql: 'DELETE FROM memory_node_tags WHERE node_id=?', args: [id] })
        if (tags.length) await this._attachTags(id, tags, c, tx)
        await tx.commit()
      } catch (error) {
        await tx.rollback()
        throw error
      }
    }
    return this.getNode(id, c)
  }
  async deleteNode(id: string, ctx: MemoryContext): Promise<void> { const c = normalizeContext(ctx); const db = getMemoryDb(); const s = scoped('', c); await db.execute({ sql: `DELETE FROM memory_nodes WHERE id=? AND ${s.sql}`, args: [id, ...s.args] }) }
  async listNodes(filter: MemoryNodeFilter, ctx: MemoryContext): Promise<MemoryNode[]> {
    const c = normalizeContext(ctx); const db = getMemoryDb(); const { cond, args } = this._nodeWhere(filter, c)
    const columns: Record<string, string> = { timestamp: 'timestamp', strength: 'strength', importance: 'importance', last_accessed: 'last_accessed' }; const order = columns[filter.orderBy ?? 'timestamp'] || 'timestamp'; const dir = filter.orderDir === 'ASC' ? 'ASC' : 'DESC'; const r = await db.execute({ sql: `SELECT * FROM memory_nodes WHERE ${cond.join(' AND ')} ORDER BY ${order} ${dir} LIMIT ? OFFSET ?`, args: [...args, filter.limit ?? 50, filter.offset ?? 0] }); return this._mapWithTags(r.rows, c)
  }
  async countNodes(filter: MemoryNodeFilter, ctx: MemoryContext): Promise<number> {
    const c = normalizeContext(ctx); const db = getMemoryDb(); const { cond, args } = this._nodeWhere(filter, c)
    const r = await db.execute({ sql: `SELECT COUNT(*) AS count FROM memory_nodes WHERE ${cond.join(' AND ')}`, args })
    return Number((r.rows[0] as any)?.count ?? 0)
  }
  async recallByTags(tags: string[], ctx: MemoryContext): Promise<MemoryNode[]> { return this.listNodes({ tags, orderBy: 'strength', limit: 30 }, ctx) }
  async recallRecent(limit: number, ctx: MemoryContext): Promise<MemoryNode[]> { return this.listNodes({ orderBy: 'timestamp', limit }, ctx) }
  async recallImportant(minImportance: number, ctx: MemoryContext): Promise<MemoryNode[]> { return this.listNodes({ minImportance, orderBy: 'importance', limit: 50 }, ctx) }
  async recallBySession(sessionId: string, ctx: MemoryContext): Promise<MemoryNode[]> { return this.listNodes({ sessionId, orderBy: 'timestamp', limit: 100 }, ctx) }
  async recallSimilar(embedding: number[], limit: number, ctx: MemoryContext, maxDistance = 0.4): Promise<MemoryNode[]> {
    const c = normalizeContext(ctx); const db = getMemoryDb(); const s = scoped('', c)
    const fallback = async (): Promise<MemoryNode[]> => {
      // The embedding_json column is intentionally scoped by the same
      // predicate. This path also handles databases where vector columns are
      // accepted by the schema but the vector extension is unavailable.
      const r = await db.execute({ sql: `SELECT * FROM memory_nodes WHERE ${s.sql} AND embedding_json IS NOT NULL`, args: s.args })
      const scored = r.rows.map((row: any) => {
        let candidate: number[] = []
        try { candidate = JSON.parse(String(row.embedding_json)) } catch { /* ignore malformed embeddings */ }
        return { row, distance: cosineDistance(embedding, candidate) }
      }).filter(item => Number.isFinite(item.distance) && item.distance <= maxDistance).sort((a, b) => a.distance - b.distance).slice(0, limit)
      return this._mapWithTags(scored.map(item => item.row), c)
    }
    try {
      const r = await db.execute({ sql: `WITH ranked AS (SELECT *,vector_distance_cos(embedding,vector32(?)) distance FROM memory_nodes WHERE ${s.sql} AND embedding IS NOT NULL) SELECT * FROM ranked WHERE distance<=? ORDER BY distance LIMIT ?`, args: [JSON.stringify(embedding), ...s.args, maxDistance, limit] })
      return r.rows.length ? this._mapWithTags(r.rows, c) : fallback()
    } catch (error) {
      if (!/vector32|vector/i.test(String((error as Error)?.message))) throw error
      return fallback()
    }
  }

  async createEdge(input: CreateMemoryEdgeInput, ctx: MemoryContext, executor?: Executor): Promise<MemoryEdge> {
    const c = normalizeContext(ctx); const db = executor ?? getMemoryDb(); const s = scoped('n', c); const nodes = await db.execute({ sql: `SELECT id FROM memory_nodes n WHERE n.id IN (?,?) AND ${s.sql}`, args: [input.sourceNodeId, input.targetNodeId, ...s.args] }); if (nodes.rows.length !== 2) throw new Error('both edge endpoints must be in the same tenant and memory scope')
    const id = uuidv4(); const now = Math.floor(Date.now() / 1000); await db.execute({ sql: 'INSERT INTO memory_edges (id,tenant_id,scope,session_id,source_node_id,target_node_id,type,strength,description,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', args: [id, c.tenantId, c.scope, c.scope === 'session' ? c.sessionId : '', input.sourceNodeId, input.targetNodeId, input.type, input.strength ?? 0.5, input.description ?? null, now] }); const es = scoped('', c); const r = await db.execute({ sql: `SELECT * FROM memory_edges WHERE id=? AND ${es.sql}`, args: [id, ...es.args] }); return mapEdgeRow(r.rows[0] as Record<string, unknown>)
  }
  async deleteEdge(id: string, ctx: MemoryContext): Promise<void> { const c = normalizeContext(ctx); const db = getMemoryDb(); const s = scoped('', c); await db.execute({ sql: `DELETE FROM memory_edges WHERE id=? AND ${s.sql}`, args: [id, ...s.args] }) }
  async getEdges(nodeId: string, ctx: MemoryContext): Promise<MemoryEdge[]> { const c = normalizeContext(ctx); const db = getMemoryDb(); const n = scoped('n', c); const e = scoped('e', c); const r = await db.execute({ sql: `SELECT e.* FROM memory_edges e JOIN memory_nodes n ON n.id=? AND ${n.sql} WHERE (e.source_node_id=? OR e.target_node_id=?) AND ${e.sql}`, args: [nodeId, ...n.args, nodeId, nodeId, ...e.args] }); return r.rows.map((row: any) => mapEdgeRow(row)) }
  async getNeighbors(nodeId: string, edgeTypes?: MemoryEdgeType[], ctx?: MemoryContext): Promise<MemoryNode[]> { const c = normalizeContext(ctx); const db = getMemoryDb(); const n = scoped('n', c); const e = scoped('e', c); let type = ''; const ta: InValue[] = []; if (edgeTypes?.length) { type = ` AND e.type IN (${edgeTypes.map(() => '?').join(',')})`; ta.push(...edgeTypes) }; const r = await db.execute({ sql: `SELECT DISTINCT n.* FROM memory_nodes n JOIN memory_edges e ON ${e.sql} AND (e.source_node_id=n.id OR e.target_node_id=n.id) AND (e.source_node_id=? OR e.target_node_id=?) WHERE ${n.sql} AND n.id!=?${type} ORDER BY n.strength DESC`, args: [...e.args, nodeId, nodeId, ...n.args, nodeId, ...ta] }); return this._mapWithTags(r.rows, c) }
  async traversePath(startNodeId: string, maxHops: number, edgeTypes?: MemoryEdgeType[], ctx?: MemoryContext): Promise<MemoryNode[]> { if (maxHops < 1) return []; const c = normalizeContext(ctx); const db = getMemoryDb(); const start = scoped('start', c); const e = scoped('e', c); const next = scoped('next', c); let type = ''; const ta: InValue[] = []; if (edgeTypes?.length) { type = ` AND e.type IN (${edgeTypes.map(() => '?').join(',')})`; ta.push(...edgeTypes) }; const end = scoped('n', c); const sql = `WITH RECURSIVE traverse(node_id,hop) AS (SELECT start.id,0 FROM memory_nodes start WHERE start.id=? AND ${start.sql} UNION SELECT next.id,t.hop+1 FROM traverse t JOIN memory_edges e ON ${e.sql} AND (e.source_node_id=t.node_id OR e.target_node_id=t.node_id) JOIN memory_nodes next ON next.id=CASE WHEN e.source_node_id=t.node_id THEN e.target_node_id ELSE e.source_node_id END AND ${next.sql} WHERE t.hop<?${type}) SELECT DISTINCT n.* FROM traverse t JOIN memory_nodes n ON n.id=t.node_id WHERE t.node_id!=? AND ${end.sql}`; const r = await db.execute({ sql, args: [startNodeId, ...start.args, ...e.args, ...next.args, maxHops, ...ta, startNodeId, ...end.args] }); return this._mapWithTags(r.rows, c) }
  async getRelatedNodes(nodeIds: string[], edgeTypes?: MemoryEdgeType[], ctx?: MemoryContext): Promise<MemoryNode[]> { if (!nodeIds.length) return []; const c = normalizeContext(ctx); const db = getMemoryDb(); const n = scoped('n', c); const e = scoped('e', c); const p = nodeIds.map(() => '?').join(','); let type = ''; const ta: InValue[] = []; if (edgeTypes?.length) { type = ` AND e.type IN (${edgeTypes.map(() => '?').join(',')})`; ta.push(...edgeTypes) }; const r = await db.execute({ sql: `SELECT DISTINCT n.* FROM memory_nodes n JOIN memory_edges e ON ${e.sql} AND (e.source_node_id=n.id OR e.target_node_id=n.id) WHERE ${n.sql} AND (e.source_node_id IN (${p}) OR e.target_node_id IN (${p})) AND n.id NOT IN (${p})${type} ORDER BY n.strength DESC`, args: [...e.args, ...n.args, ...nodeIds, ...nodeIds, ...nodeIds, ...ta] }); return this._mapWithTags(r.rows, c) }

  async addTag(nodeId: string, tag: string, ctx: MemoryContext): Promise<void> { const c = normalizeContext(ctx); await this._attachTags(nodeId, [tag], c) }
  async removeTag(nodeId: string, tag: string, ctx: MemoryContext): Promise<void> { const c = normalizeContext(ctx); const db = getMemoryDb(); const s = scoped('n', c); await db.execute({ sql: `DELETE FROM memory_node_tags WHERE node_id=? AND EXISTS (SELECT 1 FROM memory_nodes n WHERE n.id=? AND ${s.sql}) AND tag_id IN (SELECT id FROM memory_tags WHERE tenant_id=? AND name=?)`, args: [nodeId, nodeId, ...s.args, c.tenantId, tag] }) }
  async getTags(nodeId: string, ctx: MemoryContext): Promise<string[]> { return this._readTags(nodeId, normalizeContext(ctx)) }
  async decayNodes(ctx: MemoryContext): Promise<number> { const c = normalizeContext(ctx); const db = getMemoryDb(); const now = Math.floor(Date.now() / 1000); const s = scoped('', c); const r = await db.execute({ sql: `UPDATE memory_nodes SET strength=MAX(0.0,strength-(decay_rate*(?-last_strength_update)/86400.0)),last_strength_update=?,updated_at=? WHERE ${s.sql} AND strength>0 AND last_strength_update<?-3600`, args: [now, now, now, ...s.args, now] }); return r.rowsAffected }
  async consolidate(ctx: MemoryContext): Promise<string> { const c = normalizeContext(ctx); const db = getMemoryDb(); const now = Math.floor(Date.now() / 1000); const iso = new Date(now * 1000).toISOString(); const s = scoped('', c); const r = await db.execute({ sql: `SELECT COUNT(*) total_nodes,COUNT(DISTINCT CASE WHEN strength<0.2 THEN id END) weak_nodes FROM memory_nodes WHERE ${s.sql}`, args: s.args }); const row = r.rows[0] as any; await db.execute({ sql: "INSERT OR REPLACE INTO memory_graph_meta(key,value,updated_at) VALUES ('last_consolidation',?,?)", args: [iso, now] }); return [`## Memory Graph Consolidation Report`, `- Timestamp: ${iso}`, `- Total Nodes: ${row.total_nodes ?? 0}`, `- Weak Nodes (strength < 0.2): ${row.weak_nodes ?? 0}`, `- Tenant: ${c.tenantId}`, `- Scope: ${c.scope}${c.scope === 'session' ? ` (${c.sessionId})` : ''}`].join('\n') }
  async getGraphMeta(ctx: MemoryContext): Promise<MemoryGraphMeta> { const c = normalizeContext(ctx); const db = getMemoryDb(); const n = scoped('n', c); const e = scoped('e', c); const nr = await db.execute({ sql: `SELECT COUNT(*) cnt FROM memory_nodes n WHERE ${n.sql}`, args: n.args }); const er = await db.execute({ sql: `SELECT COUNT(*) cnt FROM memory_edges e WHERE ${e.sql}`, args: e.args }); const mr = await db.execute({ sql: "SELECT key,value FROM memory_graph_meta WHERE key IN ('version','last_consolidation','owner','description')", args: [] }); const m: Record<string, string | null> = {}; mr.rows.forEach((x: any) => { m[x.key] = x.value }); return { version: m.version || '1.0', lastConsolidation: m.last_consolidation || null, totalNodes: Number((nr.rows[0] as any).cnt || 0), totalEdges: Number((er.rows[0] as any).cnt || 0), owner: m.owner || null, description: m.description || null } }

  private _nodeWhere(filter: MemoryNodeFilter, c: Required<MemoryContext>): { cond: string[]; args: InValue[] } {
    const s = scoped('', c); const cond = [s.sql]; const args: InValue[] = [...s.args]
    if (filter.types?.length) { cond.push(`type IN (${filter.types.map(() => '?').join(',')})`); args.push(...filter.types) }
    if (filter.minStrength !== undefined) { cond.push('strength>=?'); args.push(filter.minStrength) }
    if (filter.maxStrength !== undefined) { cond.push('strength<=?'); args.push(filter.maxStrength) }
    if (filter.minImportance !== undefined) { cond.push('importance>=?'); args.push(filter.minImportance) }
    if (filter.sessionId) { cond.push('session_id=?'); args.push(filter.sessionId) }
    if (filter.keyword) { const words = filter.keyword.split(/[\s,，.。?？!！;；、]+/).map(w => w.trim()).filter(w => w.length > 1); const terms = words.length ? words : [filter.keyword]; cond.push(`(${terms.map(() => '(summary LIKE ? OR detail LIKE ?)').join(' OR ')})`); for (const word of terms) args.push(`%${word}%`, `%${word}%`) }
    if (filter.tags?.length) { const p = filter.tags.map(() => '?').join(','); cond.push(`id IN (SELECT mnt.node_id FROM memory_node_tags mnt JOIN memory_tags mt ON mt.id=mnt.tag_id WHERE mt.name IN (${p}) AND mt.tenant_id=?)`); args.push(...filter.tags, c.tenantId) }
    return { cond, args }
  }
  async writeBatch(nodes: CreateMemoryNodeInput[], edges: CreateMemoryEdgeInput[], ctx: MemoryContext): Promise<{ nodes: MemoryNode[]; edges: MemoryEdge[] }> { const db = getMemoryDb(); const tx = await db.transaction('write'); try { const createdNodes: MemoryNode[] = []; for (const input of nodes) createdNodes.push(await this.createNode(input, ctx, tx)); const createdEdges: MemoryEdge[] = []; for (const input of edges) createdEdges.push(await this.createEdge(input, ctx, tx)); await tx.commit(); return { nodes: createdNodes, edges: createdEdges } } catch (error) { await tx.rollback(); throw error } }
  private async _mapWithTags(rows: any[], ctx: Required<MemoryContext>): Promise<MemoryNode[]> { const nodes = rows.map((r: any) => mapNodeRow(r)); if (nodes.length) { const tags = await this._readTagsBatch(nodes.map(n => n.id), ctx); nodes.forEach(n => { n.tags = tags[n.id] || [] }) }; return nodes }
  private async _readTagsBatch(ids: string[], ctx: Required<MemoryContext>): Promise<Record<string, string[]>> { if (!ids.length) return {}; const db = getMemoryDb(); const p = ids.map(() => '?').join(','); const s = scoped('n', ctx); const r = await db.execute({ sql: `SELECT mnt.node_id,mt.name FROM memory_tags mt JOIN memory_node_tags mnt ON mnt.tag_id=mt.id JOIN memory_nodes n ON n.id=mnt.node_id WHERE mnt.node_id IN (${p}) AND mt.tenant_id=? AND ${s.sql}`, args: [...ids, ctx.tenantId, ...s.args] }); const out: Record<string, string[]> = {}; r.rows.forEach((x: any) => { (out[x.node_id] ||= []).push(x.name) }); return out }
  private async _readTags(id: string, ctx: Required<MemoryContext>, executor?: Executor): Promise<string[]> { const db = executor ?? getMemoryDb(); const s = scoped('n', ctx); const r = await db.execute({ sql: `SELECT mt.name FROM memory_tags mt JOIN memory_node_tags mnt ON mnt.tag_id=mt.id JOIN memory_nodes n ON n.id=mnt.node_id WHERE mnt.node_id=? AND mt.tenant_id=? AND ${s.sql}`, args: [id, ctx.tenantId, ...s.args] }); return r.rows.map((x: any) => x.name as string) }
  private async _attachTags(id: string, tags: string[], ctx: Required<MemoryContext>, executor?: Executor): Promise<void> { if (!tags.length) return; const db = executor ?? getMemoryDb(); const s = scoped('n', ctx); const a = await db.execute({ sql: `SELECT 1 FROM memory_nodes n WHERE n.id=? AND ${s.sql}`, args: [id, ...s.args] }); if (!a.rows.length) throw new Error('memory node is outside the requested tenant and scope'); for (const tag of tags) await db.execute({ sql: 'INSERT OR IGNORE INTO memory_tags(tenant_id,name) VALUES (?,?)', args: [ctx.tenantId, tag] }); const p = tags.map(() => '?').join(','); const r = await db.execute({ sql: `SELECT id FROM memory_tags WHERE tenant_id=? AND name IN (${p})`, args: [ctx.tenantId, ...tags] }); for (const row of r.rows) await db.execute({ sql: 'INSERT OR IGNORE INTO memory_node_tags(node_id,tag_id) VALUES (?,?)', args: [id, row.id as number] }) }
}

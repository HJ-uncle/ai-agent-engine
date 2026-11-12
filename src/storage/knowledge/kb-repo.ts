import { getKnowledgeDb } from './db.js'
import { v4 as uuidv4 } from 'uuid'
import { estimateTokens } from '../../core/utils/tokens.js'
import { throwIfAborted } from '../../core/utils/abort.js'
import type { Client, InValue, InStatement, InArgs, Transaction } from '@libsql/client'
import type { DocumentPatch, KBDocument, KBDocumentDetail, KnowledgeBase, SearchResult } from './types.js'
export type { SearchResult } from './types.js'
import { KnowledgeError } from './types.js'

const ready = new WeakMap<Client, Promise<void>>()
async function ensureSchema(): Promise<void> {
  const db = getKnowledgeDb()
  let task = ready.get(db)
  if (!task) {
    task = (async () => {
      await db.execute('CREATE TABLE IF NOT EXISTS knowledge_bases (id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT "",created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(tenant_id,name))')
      await db.execute('CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL DEFAULT "default",filename TEXT NOT NULL,content_type TEXT NOT NULL DEFAULT "text/plain",chunk_count INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL DEFAULT (unixepoch()))')
      await db.execute('CREATE TABLE IF NOT EXISTS document_chunks (id TEXT PRIMARY KEY,document_id TEXT NOT NULL,tenant_id TEXT NOT NULL DEFAULT "default",chunk_index INTEGER NOT NULL,content TEXT NOT NULL,token_count INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL DEFAULT (unixepoch()))')
      await db.execute('CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content,chunk_id UNINDEXED,document_id UNINDEXED,tenant_id UNINDEXED)')
      const columns = new Set((await db.execute('PRAGMA table_info(documents)')).rows.map(row => String(row.name)))
      if (!columns.has('knowledge_base_id')) await db.execute('ALTER TABLE documents ADD COLUMN knowledge_base_id TEXT')
      if (!columns.has('updated_at')) await db.execute('ALTER TABLE documents ADD COLUMN updated_at INTEGER')
      if (!columns.has('content')) await db.execute('ALTER TABLE documents ADD COLUMN content TEXT')
      if (!columns.has('revision')) await db.execute('ALTER TABLE documents ADD COLUMN revision INTEGER NOT NULL DEFAULT 1')
      const baseColumns = new Set((await db.execute('PRAGMA table_info(knowledge_bases)')).rows.map(row => String(row.name)))
      if (!baseColumns.has('revision')) await db.execute('ALTER TABLE knowledge_bases ADD COLUMN revision INTEGER NOT NULL DEFAULT 1')
      await db.execute('CREATE INDEX IF NOT EXISTS idx_kb_tenant ON knowledge_bases(tenant_id)')
      await db.execute('CREATE INDEX IF NOT EXISTS idx_documents_kb ON documents(tenant_id,knowledge_base_id)')
    })()
    ready.set(db, task)
    task.catch(() => { if (ready.get(db) === task) ready.delete(db) })
  }
  await task
}
function baseRow(row: Record<string, unknown>): KnowledgeBase {
  return { id: String(row.id), revision: Number(row.revision ?? 1), tenantId: String(row.tenant_id), name: String(row.name), description: String(row.description ?? ''), documentCount: Number(row.document_count ?? 0), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }
}
function docRow(row: Record<string, unknown>, content?: string, exact = row.content !== undefined && row.content !== null): KBDocument | KBDocumentDetail {
  const base = { id: String(row.id), revision: Number(row.revision ?? 1), tenantId: String(row.tenant_id), knowledgeBaseId: row.knowledge_base_id == null ? null : String(row.knowledge_base_id), filename: String(row.filename), contentType: String(row.content_type), chunkCount: Number(row.chunk_count), status: 'ready' as const, contentExact: exact, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at ?? row.created_at) }
  return content === undefined ? base : { ...base, content }
}
function splitLines(text: string): string[] { return text.replace(/\r\n/g, '\n').split(/\n{2,}/).map(x => x.trim()).filter(Boolean) }
export function splitIntoChunks(text: string, chunkSize = 500, overlap = 50): string[] {
  if (!text || !text.trim()) return []
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || !Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize) throw new KnowledgeError('Invalid chunk size')
  const chunks: string[] = []; let current: string[] = []
  const flush = () => { if (current.length) chunks.push(current.join(' ')); current = overlap ? current.slice(-overlap) : [] }
  for (const paragraph of splitLines(text)) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    for (const word of words) {
      const chars = Array.from(word)
      if (chars.length > chunkSize) {
        if (current.length) flush()
        let start = 0
        while (start < chars.length) { const end = Math.min(start + chunkSize, chars.length); chunks.push(chars.slice(start, end).join('')); if (end === chars.length) break; start = end - overlap }
      } else { current.push(word); if (current.length >= chunkSize) flush() }
    }
    if (current.length >= chunkSize * 0.8) flush()
  }
  if (current.length > overlap || (current.length && !chunks.length)) chunks.push(current.join(' '))
  return chunks
}
type KnowledgeReader = Pick<Client, 'execute'>
async function validBase(db: KnowledgeReader, tenantId: string, id?: string | null): Promise<void> {
  if (id && !(await db.execute({ sql: 'SELECT 1 FROM knowledge_bases WHERE id=? AND tenant_id=?', args: [id, tenantId] })).rows.length) throw new KnowledgeError('Knowledge base not found', 40400)
}
function insertStatements(id: string, tenantId: string, filename: string, type: string, text: string, kb: string | null, createdAt: number, updatedAt = createdAt): Array<{ sql: string; args: InValue[] }> {
  const chunks = splitIntoChunks(text); const statements: Array<{ sql: string; args: InValue[] }> = [{ sql: 'INSERT INTO documents(id,tenant_id,knowledge_base_id,filename,content_type,content,chunk_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', args: [id, tenantId, kb, filename, type, text, chunks.length, createdAt, updatedAt] }]
  chunks.forEach((chunk, index) => { const cid = uuidv4(); statements.push({ sql: 'INSERT INTO document_chunks(id,document_id,tenant_id,chunk_index,content,token_count,created_at) VALUES(?,?,?,?,?,?,?)', args: [cid, id, tenantId, index, chunk, estimateTokens(chunk), createdAt] }, { sql: 'INSERT INTO chunks_fts(content,chunk_id,document_id,tenant_id) VALUES(?,?,?,?)', args: [chunk, cid, id, tenantId] }) })
  return statements
}
async function writeTransaction<T>(operation: (db: Pick<Transaction, 'execute' | 'batch'>) => Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  await ensureSchema()
  throwIfAborted(signal)
  const tx = await getKnowledgeDb().transaction('write')
  try {
    // Admission can wait behind another writer. Check again after acquiring
    // ownership, before every SQL dispatch, and before publishing the commit.
    // Cancellation during a multi-statement batch rolls the entire edit back.
    throwIfAborted(signal)
    const db: Pick<Transaction, 'execute' | 'batch'> = {
      execute(statement: InStatement, args?: InArgs) {
        throwIfAborted(signal)
        return tx.execute(typeof statement === 'string' && args !== undefined ? { sql: statement, args } : statement)
      },
      batch(statements) { throwIfAborted(signal); return tx.batch(statements) },
    }
    const result = await operation(db)
    throwIfAborted(signal)
    await tx.commit()
    return result
  } catch (error) {
    try { await tx.rollback() }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Knowledge transaction rollback failed', { cause: error }) }
    throw error
  } finally { tx.close() }
}
function checkRevision(actual: number | undefined, expected?: number): void {
  if (expected !== undefined && actual !== expected) throw new KnowledgeError('Knowledge resource changed after preview; read it again and request a new confirmation', 40901)
}
async function readBase(db: KnowledgeReader, tenantId: string, id: string): Promise<KnowledgeBase | null> {
  const result = await db.execute({ sql: 'SELECT b.*,(SELECT COUNT(*) FROM documents d WHERE d.knowledge_base_id=b.id AND d.tenant_id=b.tenant_id) document_count FROM knowledge_bases b WHERE b.id=? AND b.tenant_id=?', args: [id, tenantId] })
  return result.rows[0] ? baseRow(result.rows[0] as Record<string, unknown>) : null
}
async function readDocument(db: KnowledgeReader, tenantId: string, id: string): Promise<KBDocumentDetail | null> {
  const result = await db.execute({ sql: 'SELECT * FROM documents WHERE id=? AND tenant_id=?', args: [id, tenantId] })
  if (!result.rows[0]) return null
  const row = result.rows[0] as Record<string, unknown>
  const exact = row.content != null
  const content = exact ? String(row.content) : (await db.execute({ sql: 'SELECT content FROM document_chunks WHERE document_id=? AND tenant_id=? ORDER BY chunk_index', args: [id, tenantId] })).rows.map(chunk => String(chunk.content)).join('\n')
  return docRow(row, content, exact) as KBDocumentDetail
}
async function touchBase(db: KnowledgeReader, tenantId: string, id: string | null): Promise<void> {
  if (id) await db.execute({ sql: 'UPDATE knowledge_bases SET updated_at=?,revision=revision+1 WHERE id=? AND tenant_id=?', args: [Math.floor(Date.now() / 1000), id, tenantId] })
}
async function removeDocument(db: KnowledgeReader, tenantId: string, id: string): Promise<void> {
  await db.execute({ sql: 'DELETE FROM chunks_fts WHERE document_id=? AND tenant_id=?', args: [id, tenantId] })
  await db.execute({ sql: 'DELETE FROM document_chunks WHERE document_id=? AND tenant_id=?', args: [id, tenantId] })
  await db.execute({ sql: 'DELETE FROM documents WHERE id=? AND tenant_id=?', args: [id, tenantId] })
}
export async function createKnowledgeBase(tenantId: string, name: string, description = '', id = uuidv4(), signal?: AbortSignal): Promise<KnowledgeBase> {
  return writeTransaction(async db => {
    const clean = name.trim()
    if (!clean) throw new KnowledgeError('name is required')
    const now = Math.floor(Date.now() / 1000)
    await db.execute({ sql: 'INSERT INTO knowledge_bases(id,tenant_id,name,description,created_at,updated_at,revision) VALUES(?,?,?,?,?,?,1)', args: [id, tenantId, clean, description, now, now] })
    return { id, revision: 1, tenantId, name: clean, description, documentCount: 0, createdAt: now, updatedAt: now }
  }, signal)
}
export async function listKnowledgeBases(tenantId: string): Promise<KnowledgeBase[]> { await ensureSchema(); const db = getKnowledgeDb(); const r = await db.execute({ sql: 'SELECT b.*,COUNT(d.id) document_count FROM knowledge_bases b LEFT JOIN documents d ON d.knowledge_base_id=b.id AND d.tenant_id=b.tenant_id WHERE b.tenant_id=? GROUP BY b.id ORDER BY b.updated_at DESC', args: [tenantId] }); return r.rows.map(r => baseRow(r as Record<string, unknown>)) }
export async function getKnowledgeBase(tenantId: string, id: string): Promise<KnowledgeBase | null> { await ensureSchema(); return readBase(getKnowledgeDb(), tenantId, id) }
export async function updateKnowledgeBase(tenantId: string, id: string, patch: { name?: string; description?: string }, expectedRevision?: number, signal?: AbortSignal): Promise<KnowledgeBase | null> {
  return writeTransaction(async db => {
    const old = await readBase(db, tenantId, id)
    checkRevision(old?.revision, expectedRevision)
    if (!old) return null
    const name = patch.name?.trim() ?? old.name
    if (!name) throw new KnowledgeError('name is required')
    const now = Math.floor(Date.now() / 1000)
    await db.execute({ sql: 'UPDATE knowledge_bases SET name=?,description=?,updated_at=?,revision=revision+1 WHERE id=? AND tenant_id=?', args: [name, patch.description ?? old.description, now, id, tenantId] })
    return { ...old, name, description: patch.description ?? old.description, updatedAt: now, revision: old.revision + 1 }
  }, signal)
}
export async function deleteKnowledgeBase(tenantId: string, id: string, expectedRevision?: number, signal?: AbortSignal): Promise<boolean> {
  return writeTransaction(async db => {
    const old = await readBase(db, tenantId, id)
    checkRevision(old?.revision, expectedRevision)
    if (!old) return false
    // Subqueries avoid SQLite's variable limit for a large knowledge base.
    for (const table of ['chunks_fts', 'document_chunks']) await db.execute({ sql: `DELETE FROM ${table} WHERE tenant_id=? AND document_id IN (SELECT id FROM documents WHERE tenant_id=? AND knowledge_base_id=?)`, args: [tenantId, tenantId, id] })
    await db.execute({ sql: 'DELETE FROM documents WHERE knowledge_base_id=? AND tenant_id=?', args: [id, tenantId] })
    await db.execute({ sql: 'DELETE FROM knowledge_bases WHERE id=? AND tenant_id=?', args: [id, tenantId] })
    return true
  }, signal)
}
export async function addDocument(tenantId: string, filename: string, contentType: string, text: string, knowledgeBaseId?: string | null, options: { id?: string; expectedBaseRevision?: number; signal?: AbortSignal } = {}): Promise<KBDocumentDetail> {
  return writeTransaction(async db => {
    await validBase(db, tenantId, knowledgeBaseId)
    if (knowledgeBaseId && options.expectedBaseRevision !== undefined) checkRevision((await readBase(db, tenantId, knowledgeBaseId))?.revision, options.expectedBaseRevision)
    const id = options.id ?? uuidv4()
    const now = Math.floor(Date.now() / 1000)
    await db.batch(insertStatements(id, tenantId, filename, contentType || 'text/plain', text, knowledgeBaseId ?? null, now))
    await touchBase(db, tenantId, knowledgeBaseId ?? null)
    return (await readDocument(db, tenantId, id))!
  }, options.signal)
}
export async function listDocuments(tenantId: string, knowledgeBaseId?: string): Promise<KBDocument[]> {
  await ensureSchema()
  const db = getKnowledgeDb()
  const result = await db.execute({ sql: `SELECT id,tenant_id,knowledge_base_id,filename,content_type,content IS NOT NULL AS content_exact,chunk_count,created_at,updated_at,revision FROM documents WHERE tenant_id=?${knowledgeBaseId === undefined ? '' : ' AND knowledge_base_id=?'} ORDER BY created_at DESC`, args: knowledgeBaseId === undefined ? [tenantId] : [tenantId, knowledgeBaseId] })
  return result.rows.map(row => docRow(row as Record<string, unknown>, undefined, Boolean(row.content_exact)) as KBDocument)
}
export async function getDocument(tenantId: string, id: string): Promise<KBDocumentDetail | null> { await ensureSchema(); return readDocument(getKnowledgeDb(), tenantId, id) }
/** Catalogue and authorization checks must not materialize document bodies or legacy chunks. */
export async function getDocumentMetadata(tenantId: string, id: string): Promise<KBDocument | null> {
  await ensureSchema()
  const result = await getKnowledgeDb().execute({ sql: 'SELECT id,tenant_id,knowledge_base_id,filename,content_type,content IS NOT NULL AS content_exact,chunk_count,created_at,updated_at,revision FROM documents WHERE id=? AND tenant_id=?', args: [id, tenantId] })
  const row = result.rows[0]
  return row ? docRow(row as Record<string, unknown>, undefined, Boolean(row.content_exact)) as KBDocument : null
}
export async function updateDocument(tenantId: string, id: string, patch: DocumentPatch, expectedRevision?: number, signal?: AbortSignal): Promise<KBDocumentDetail | null> {
  return writeTransaction(async db => {
    const old = await readDocument(db, tenantId, id)
    checkRevision(old?.revision, expectedRevision)
    if (!old) return null
    const kb = patch.knowledgeBaseId === undefined ? old.knowledgeBaseId : patch.knowledgeBaseId
    await validBase(db, tenantId, kb)
    await removeDocument(db, tenantId, id)
    await db.batch(insertStatements(id, tenantId, patch.filename ?? old.filename, patch.contentType ?? old.contentType, patch.content ?? old.content, kb, old.createdAt, Math.floor(Date.now() / 1000)))
    await db.execute({ sql: 'UPDATE documents SET revision=? WHERE id=? AND tenant_id=?', args: [old.revision + 1, id, tenantId] })
    for (const baseId of new Set([old.knowledgeBaseId, kb])) await touchBase(db, tenantId, baseId)
    return (await readDocument(db, tenantId, id))!
  }, signal)
}
export async function deleteDocument(tenantId: string, id: string, expectedRevision?: number, signal?: AbortSignal): Promise<boolean> {
  return writeTransaction(async db => {
    const old = await readDocument(db, tenantId, id)
    checkRevision(old?.revision, expectedRevision)
    if (!old) return false
    await removeDocument(db, tenantId, id)
    await touchBase(db, tenantId, old.knowledgeBaseId)
    return true
  }, signal)
}
function like(value: string): string { return value.replace(/[\\%_]/g, c => `\\${c}`) }
export async function searchChunks(tenantId: string, query: unknown, limit = 5, scopes?: readonly string[], ceiling?: readonly string[]): Promise<SearchResult[]> {
  await ensureSchema()
  const q = typeof query === 'string' ? query.trim() : ''
  if (!q) return []
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new KnowledgeError('limit must be an integer between 1 and 100')
  const limits = [scopes, ceiling].filter((value): value is readonly string[] => value !== undefined)
  if (limits.some(value => value.length === 0)) return []
  const db = getKnowledgeDb()
  // Apply every permission ceiling to the actual document row before LIMIT.
  // This preserves base -> document grants without a stale pre-query ID list,
  // and avoids SQLite's placeholder limit for large bound knowledge bases.
  const scope = limits.map(() => ' AND (d.id IN (SELECT value FROM json_each(?)) OR d.knowledge_base_id IN (SELECT value FROM json_each(?)))').join('')
  const scopeArgs = limits.flatMap(value => [JSON.stringify(value), JSON.stringify(value)])
  const terms = q.split(/\s+/).filter(Boolean); const ascii = terms.filter(t => /^[\x00-\x7F]+$/.test(t)); const nonAscii = terms.filter(t => !/^[\x00-\x7F]+$/.test(t))
  const rows: Record<string, unknown>[] = []; const seen = new Set<string>()
  if (ascii.length) {
    const safe = ascii.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ')
    const found = await db.execute({ sql: `SELECT f.chunk_id,f.document_id,d.knowledge_base_id,d.filename,f.content,f.rank score,dc.chunk_index FROM chunks_fts f JOIN documents d ON d.id=f.document_id JOIN document_chunks dc ON dc.id=f.chunk_id WHERE chunks_fts MATCH ? AND f.tenant_id=? AND d.tenant_id=?${scope} ORDER BY rank LIMIT ?`, args: [safe, tenantId, tenantId, ...scopeArgs, limit] }).catch(() => ({ rows: [] }))
    for (const row of found.rows) if (!seen.has(String(row.chunk_id))) { seen.add(String(row.chunk_id)); rows.push(row as Record<string, unknown>) }
  }
  const termsLike = nonAscii.length ? nonAscii : rows.length ? [] : ascii
  if (termsLike.length) {
    // Large Work messages also reach automatic RAG. Bind a term table so SQL
    // depth and placeholder count stay constant; keep all terms and escaping.
    const patterns = JSON.stringify([...new Set(termsLike)].map(x => `%${like(x)}%`))
    const conditions = "EXISTS (SELECT 1 FROM json_each(?) AS search_term WHERE dc.content LIKE search_term.value ESCAPE '\\')"
    const found = await db.execute({ sql: `SELECT dc.id chunk_id,dc.document_id,d.knowledge_base_id,d.filename,dc.content,0.0 score,dc.chunk_index FROM document_chunks dc JOIN documents d ON d.id=dc.document_id WHERE dc.tenant_id=? AND d.tenant_id=? AND ${conditions}${scope} ORDER BY dc.chunk_index LIMIT ?`, args: [tenantId, tenantId, patterns, ...scopeArgs, limit] })
    for (const row of found.rows) if (!seen.has(String(row.chunk_id))) { seen.add(String(row.chunk_id)); rows.push(row as Record<string, unknown>) }
  }
  return rows.slice(0, limit).map(row => ({ chunkId: String(row.chunk_id), documentId: String(row.document_id), knowledgeBaseId: row.knowledge_base_id == null ? null : String(row.knowledge_base_id), filename: String(row.filename), content: String(row.content), score: Number(row.score), chunkIndex: Number(row.chunk_index) }))
}

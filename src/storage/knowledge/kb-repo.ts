import { getKnowledgeDb } from './db.js'
import { v4 as uuidv4 } from 'uuid'
import { estimateTokens } from '../../core/utils/tokens.js'
import type { Client, InValue } from '@libsql/client'
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
      await db.execute('CREATE INDEX IF NOT EXISTS idx_kb_tenant ON knowledge_bases(tenant_id)')
      await db.execute('CREATE INDEX IF NOT EXISTS idx_documents_kb ON documents(tenant_id,knowledge_base_id)')
    })()
    ready.set(db, task)
    task.catch(() => { if (ready.get(db) === task) ready.delete(db) })
  }
  await task
}
function baseRow(row: Record<string, unknown>): KnowledgeBase {
  return { id: String(row.id), tenantId: String(row.tenant_id), name: String(row.name), description: String(row.description ?? ''), documentCount: Number(row.document_count ?? 0), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }
}
function docRow(row: Record<string, unknown>, content?: string, exact = row.content !== undefined && row.content !== null): KBDocument | KBDocumentDetail {
  const base = { id: String(row.id), tenantId: String(row.tenant_id), knowledgeBaseId: row.knowledge_base_id == null ? null : String(row.knowledge_base_id), filename: String(row.filename), contentType: String(row.content_type), chunkCount: Number(row.chunk_count), status: 'ready' as const, contentExact: exact, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at ?? row.created_at) }
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
async function validBase(db: Client, tenantId: string, id?: string | null): Promise<void> {
  if (id && !(await db.execute({ sql: 'SELECT 1 FROM knowledge_bases WHERE id=? AND tenant_id=?', args: [id, tenantId] })).rows.length) throw new KnowledgeError('Knowledge base not found', 40400)
}
function insertStatements(id: string, tenantId: string, filename: string, type: string, text: string, kb: string | null, createdAt: number, updatedAt = createdAt): Array<{ sql: string; args: InValue[] }> {
  const chunks = splitIntoChunks(text); const statements: Array<{ sql: string; args: InValue[] }> = [{ sql: 'INSERT INTO documents(id,tenant_id,knowledge_base_id,filename,content_type,content,chunk_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', args: [id, tenantId, kb, filename, type, text, chunks.length, createdAt, updatedAt] }]
  chunks.forEach((chunk, index) => { const cid = uuidv4(); statements.push({ sql: 'INSERT INTO document_chunks(id,document_id,tenant_id,chunk_index,content,token_count,created_at) VALUES(?,?,?,?,?,?,?)', args: [cid, id, tenantId, index, chunk, estimateTokens(chunk), createdAt] }, { sql: 'INSERT INTO chunks_fts(content,chunk_id,document_id,tenant_id) VALUES(?,?,?,?)', args: [chunk, cid, id, tenantId] }) })
  return statements
}
export async function createKnowledgeBase(tenantId: string, name: string, description = ''): Promise<KnowledgeBase> { await ensureSchema(); const db = getKnowledgeDb(); const clean = name.trim(); if (!clean) throw new KnowledgeError('name is required'); const id = uuidv4(); const now = Math.floor(Date.now() / 1000); await db.execute({ sql: 'INSERT INTO knowledge_bases VALUES(?,?,?,?,?,?)', args: [id, tenantId, clean, description, now, now] }); return { id, tenantId, name: clean, description, documentCount: 0, createdAt: now, updatedAt: now } }
export async function listKnowledgeBases(tenantId: string): Promise<KnowledgeBase[]> { await ensureSchema(); const db = getKnowledgeDb(); const r = await db.execute({ sql: 'SELECT b.*,COUNT(d.id) document_count FROM knowledge_bases b LEFT JOIN documents d ON d.knowledge_base_id=b.id AND d.tenant_id=b.tenant_id WHERE b.tenant_id=? GROUP BY b.id ORDER BY b.updated_at DESC', args: [tenantId] }); return r.rows.map(r => baseRow(r as Record<string, unknown>)) }
export async function getKnowledgeBase(tenantId: string, id: string): Promise<KnowledgeBase | null> { return (await listKnowledgeBases(tenantId)).find(x => x.id === id) ?? null }
export async function updateKnowledgeBase(tenantId: string, id: string, patch: { name?: string; description?: string }): Promise<KnowledgeBase | null> { const old = await getKnowledgeBase(tenantId, id); if (!old) return null; const name = patch.name?.trim() ?? old.name; if (!name) throw new KnowledgeError('name is required'); const now = Math.floor(Date.now() / 1000); await (getKnowledgeDb()).execute({ sql: 'UPDATE knowledge_bases SET name=?,description=?,updated_at=? WHERE id=? AND tenant_id=?', args: [name, patch.description ?? old.description, now, id, tenantId] }); return { ...old, name, description: patch.description ?? old.description, updatedAt: now } }
export async function deleteKnowledgeBase(tenantId: string, id: string): Promise<boolean> { await ensureSchema(); const db = getKnowledgeDb(); const docs = await db.execute({ sql: 'SELECT id FROM documents WHERE knowledge_base_id=? AND tenant_id=?', args: [id, tenantId] }); const ids = docs.rows.map(x => String(x.id)); if (!ids.length) { const r = await db.execute({ sql: 'DELETE FROM knowledge_bases WHERE id=? AND tenant_id=?', args: [id, tenantId] }); return Number(r.rowsAffected) > 0 } const p = ids.map(() => '?').join(','); const statements = [{ sql: `DELETE FROM chunks_fts WHERE document_id IN (${p}) AND tenant_id=?`, args: [...ids, tenantId] }, { sql: `DELETE FROM document_chunks WHERE document_id IN (${p}) AND tenant_id=?`, args: [...ids, tenantId] }, { sql: 'DELETE FROM documents WHERE knowledge_base_id=? AND tenant_id=?', args: [id, tenantId] }, { sql: 'DELETE FROM knowledge_bases WHERE id=? AND tenant_id=?', args: [id, tenantId] }]; const r = await db.batch(statements, 'write'); return Number(r[3]?.rowsAffected ?? 0) > 0 }
export async function addDocument(tenantId: string, filename: string, contentType: string, text: string, knowledgeBaseId?: string | null): Promise<KBDocumentDetail> {
  await ensureSchema()
  const db = getKnowledgeDb()
  await validBase(db, tenantId, knowledgeBaseId)
  const id = uuidv4()
  const now = Math.floor(Date.now() / 1000)
  const statements = insertStatements(id, tenantId, filename, contentType || 'text/plain', text, knowledgeBaseId ?? null, now)
  if (knowledgeBaseId) statements.push({ sql: 'UPDATE knowledge_bases SET updated_at=? WHERE id=? AND tenant_id=?', args: [now, knowledgeBaseId, tenantId] })
  await db.batch(statements, 'write')
  return docRow({ id, tenant_id: tenantId, knowledge_base_id: knowledgeBaseId ?? null, filename, content_type: contentType || 'text/plain', chunk_count: splitIntoChunks(text).length, created_at: now, updated_at: now }, text, true) as KBDocumentDetail
}
export async function listDocuments(tenantId: string, knowledgeBaseId?: string): Promise<KBDocument[]> { await ensureSchema(); const db = getKnowledgeDb(); const r = await db.execute({ sql: `SELECT id,tenant_id,knowledge_base_id,filename,content_type,content,chunk_count,created_at,updated_at FROM documents WHERE tenant_id=?${knowledgeBaseId === undefined ? '' : ' AND knowledge_base_id=?'} ORDER BY created_at DESC`, args: knowledgeBaseId === undefined ? [tenantId] : [tenantId, knowledgeBaseId] }); return r.rows.map(x => docRow(x as Record<string, unknown>) as KBDocument) }
export async function getDocument(tenantId: string, id: string): Promise<KBDocumentDetail | null> { await ensureSchema(); const db = getKnowledgeDb(); const r = await db.execute({ sql: "SELECT d.*,d.content AS exact_content,(SELECT GROUP_CONCAT(content,char(10)) FROM document_chunks WHERE document_id=d.id ORDER BY chunk_index) AS fallback_content FROM documents d WHERE d.id=? AND d.tenant_id=?", args: [id, tenantId] }); if (!r.rows[0]) return null; const row = r.rows[0] as Record<string, unknown>; const content = row.exact_content == null ? String(row.fallback_content ?? '') : String(row.exact_content); return docRow(row, content, row.exact_content != null) as KBDocumentDetail }
export async function updateDocument(tenantId: string, id: string, patch: DocumentPatch): Promise<KBDocumentDetail | null> {
  const old = await getDocument(tenantId, id)
  if (!old) return null
  const db = getKnowledgeDb()
  const kb = patch.knowledgeBaseId === undefined ? old.knowledgeBaseId : patch.knowledgeBaseId
  await validBase(db, tenantId, kb)
  const filename = patch.filename ?? old.filename
  const type = patch.contentType ?? old.contentType
  const text = patch.content ?? old.content
  const now = Math.floor(Date.now() / 1000)
  const statements = [
    { sql: 'DELETE FROM chunks_fts WHERE document_id=? AND tenant_id=?', args: [id, tenantId] as InValue[] },
    { sql: 'DELETE FROM document_chunks WHERE document_id=? AND tenant_id=?', args: [id, tenantId] as InValue[] },
    { sql: 'DELETE FROM documents WHERE id=? AND tenant_id=?', args: [id, tenantId] as InValue[] },
    ...insertStatements(id, tenantId, filename, type, text, kb, old.createdAt, now),
  ]
  const touched = new Set([old.knowledgeBaseId, kb])
  for (const baseId of touched) if (baseId) statements.push({ sql: 'UPDATE knowledge_bases SET updated_at=? WHERE id=? AND tenant_id=?', args: [now, baseId, tenantId] })
  await db.batch(statements, 'write')
  return (await getDocument(tenantId, id))!
}
export async function deleteDocument(tenantId: string, id: string): Promise<boolean> {
  await ensureSchema()
  const db = getKnowledgeDb()
  const own = await db.execute({ sql: 'SELECT knowledge_base_id FROM documents WHERE id=? AND tenant_id=?', args: [id, tenantId] })
  if (!own.rows.length) return false
  const baseId = own.rows[0].knowledge_base_id == null ? null : String(own.rows[0].knowledge_base_id)
  const now = Math.floor(Date.now() / 1000)
  const statements = [
    { sql: 'DELETE FROM chunks_fts WHERE document_id=? AND tenant_id=?', args: [id, tenantId] as InValue[] },
    { sql: 'DELETE FROM document_chunks WHERE document_id=? AND tenant_id=?', args: [id, tenantId] as InValue[] },
    { sql: 'DELETE FROM documents WHERE id=? AND tenant_id=?', args: [id, tenantId] as InValue[] },
  ]
  if (baseId) statements.push({ sql: 'UPDATE knowledge_bases SET updated_at=? WHERE id=? AND tenant_id=?', args: [now, baseId, tenantId] })
  const r = await db.batch(statements, 'write')
  return Number(r[2]?.rowsAffected ?? 0) > 0
}
function like(value: string): string { return value.replace(/[\\%_]/g, c => `\\${c}`) }
export async function searchChunks(tenantId: string, query: unknown, limit = 5, scopes?: readonly string[]): Promise<SearchResult[]> {
  await ensureSchema()
  const q = typeof query === 'string' ? query.trim() : ''
  if (!q) return []
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new KnowledgeError('limit must be an integer between 1 and 100')
  if (scopes && scopes.length === 0) return []
  const db = getKnowledgeDb(); let ids: string[] | undefined
  if (scopes) {
    const p = scopes.map(() => '?').join(',')
    const scopedRows = await db.execute({ sql: `SELECT id FROM documents WHERE tenant_id=? AND (id IN (${p}) OR knowledge_base_id IN (${p}))`, args: [tenantId, ...scopes, ...scopes] })
    ids = scopedRows.rows.map(x => String(x.id)); if (!ids.length) return []
  }
  const scope = ids ? ` AND d.id IN (${ids.map(() => '?').join(',')})` : ''
  const terms = q.split(/\s+/).filter(Boolean); const ascii = terms.filter(t => /^[\x00-\x7F]+$/.test(t)); const nonAscii = terms.filter(t => !/^[\x00-\x7F]+$/.test(t))
  const rows: Record<string, unknown>[] = []; const seen = new Set<string>()
  if (ascii.length) {
    const safe = ascii.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ')
    const found = await db.execute({ sql: `SELECT f.chunk_id,f.document_id,d.knowledge_base_id,d.filename,f.content,f.rank score,dc.chunk_index FROM chunks_fts f JOIN documents d ON d.id=f.document_id JOIN document_chunks dc ON dc.id=f.chunk_id WHERE chunks_fts MATCH ? AND f.tenant_id=? AND d.tenant_id=?${scope} ORDER BY rank LIMIT ?`, args: [safe, tenantId, tenantId, ...(ids ?? []), limit] }).catch(() => ({ rows: [] }))
    for (const row of found.rows) if (!seen.has(String(row.chunk_id))) { seen.add(String(row.chunk_id)); rows.push(row as Record<string, unknown>) }
  }
  const termsLike = nonAscii.length ? nonAscii : rows.length ? [] : ascii
  if (termsLike.length) {
    const conditions = termsLike.map(() => "dc.content LIKE ? ESCAPE '\\'").join(' OR ')
    const found = await db.execute({ sql: `SELECT dc.id chunk_id,dc.document_id,d.knowledge_base_id,d.filename,dc.content,0.0 score,dc.chunk_index FROM document_chunks dc JOIN documents d ON d.id=dc.document_id WHERE dc.tenant_id=? AND d.tenant_id=? AND (${conditions})${scope} ORDER BY dc.chunk_index LIMIT ?`, args: [tenantId, tenantId, ...termsLike.map(x => `%${like(x)}%`), ...(ids ?? []), limit] })
    for (const row of found.rows) if (!seen.has(String(row.chunk_id))) { seen.add(String(row.chunk_id)); rows.push(row as Record<string, unknown>) }
  }
  return rows.slice(0, limit).map(row => ({ chunkId: String(row.chunk_id), documentId: String(row.document_id), knowledgeBaseId: row.knowledge_base_id == null ? null : String(row.knowledge_base_id), filename: String(row.filename), content: String(row.content), score: Number(row.score), chunkIndex: Number(row.chunk_index) }))
}

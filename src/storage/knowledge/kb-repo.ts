import { getDb } from '../sqlite/db.js'
import { v4 as uuidv4 } from 'uuid'
import { estimateTokens } from '../../core/utils/tokens.js'

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface KBDocument {
  id: string
  tenantId: string
  filename: string
  contentType: string
  chunkCount: number
  createdAt: number
}

export interface KBChunk {
  id: string
  documentId: string
  tenantId: string
  chunkIndex: number
  content: string
  tokenCount: number
}

export interface SearchResult {
  chunkId: string
  documentId: string
  filename: string
  content: string
  /** BM25 relevance score from FTS5 (negative: lower = better match) */
  score: number
  chunkIndex: number
}

// ─── Text chunking ────────────────────────────────────────────────────────────

/**
 * Split text into chunks of ~500 words with 50-word overlap.
 * Splits on paragraph boundaries first, then by word count.
 */
export function splitIntoChunks(text: string, chunkSize = 500, overlap = 50): string[] {
  if (!text || text.trim().length === 0) return []

  // Normalise line endings and split into paragraphs
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  const chunks: string[] = []
  let currentWords: string[] = []

  const flush = () => {
    if (currentWords.length === 0) return
    chunks.push(currentWords.join(' '))
    // Keep last `overlap` words for next chunk
    currentWords = currentWords.slice(-overlap)
  }

  for (const para of paragraphs) {
    const words = para.split(/\s+/)

    for (const word of words) {
      currentWords.push(word)
      if (currentWords.length >= chunkSize) {
        flush()
      }
    }

    // Treat paragraph boundaries as natural split points if we're close to the limit
    if (currentWords.length >= chunkSize * 0.8) {
      flush()
    }
  }

  // Flush remaining words
  if (currentWords.length > overlap) {
    chunks.push(currentWords.join(' '))
  } else if (chunks.length === 0 && currentWords.length > 0) {
    // Very short document — emit whatever we have
    chunks.push(currentWords.join(' '))
  }

  return chunks
}

// ─── Repository functions ─────────────────────────────────────────────────────

/**
 * Add a document, split it into chunks, and index in FTS5.
 */
export async function addDocument(
  tenantId: string,
  filename: string,
  contentType: string,
  text: string,
): Promise<KBDocument> {
  const db = await getDb()
  const docId = uuidv4()
  const chunks = splitIntoChunks(text)
  const now = Math.floor(Date.now() / 1000)

  // Insert parent document
  await db.execute({
    sql: `INSERT INTO documents (id, tenant_id, filename, content_type, chunk_count, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [docId, tenantId, filename, contentType, chunks.length, now],
  })

  // Insert each chunk + FTS entry
  for (let i = 0; i < chunks.length; i++) {
    const chunkId = uuidv4()
    const content = chunks[i]
    const tokenCount = estimateTokens(content)

    await db.execute({
      sql: `INSERT INTO document_chunks (id, document_id, tenant_id, chunk_index, content, token_count, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [chunkId, docId, tenantId, i, content, tokenCount, now],
    })

    await db.execute({
      sql: `INSERT INTO chunks_fts (content, chunk_id, document_id, tenant_id)
            VALUES (?, ?, ?, ?)`,
      args: [content, chunkId, docId, tenantId],
    })
  }

  return {
    id: docId,
    tenantId,
    filename,
    contentType,
    chunkCount: chunks.length,
    createdAt: now,
  }
}

/**
 * Search chunks using FTS5 BM25 ranking, scoped to a tenant.
 * Fallback: if FTS5 returns 0 results (e.g. Chinese text without spaces),
 * use LIKE-based search on document_chunks directly.
 */
export async function searchChunks(
  tenantId: string,
  query: unknown,
  limit = 5,
  documentIds?: readonly string[],
): Promise<SearchResult[]> {
  const queryStr = typeof query === 'string' ? query : ''
  if (!queryStr || queryStr.trim().length === 0) return []
  const scopedIds = documentIds === undefined ? undefined : [...new Set(documentIds)]
  if (scopedIds?.length === 0) return []
  const scopeSql = scopedIds ? ` AND d.id IN (${scopedIds.map(() => '?').join(',')})` : ''

  const db = await getDb()

  const terms = queryStr.trim().split(/\s+/).filter(Boolean)

  // Separate ASCII-safe terms (→ FTS5) from CJK/other terms (→ LIKE)
  const asciiTerms = terms.filter((t) => /^[\x00-\x7F]+$/.test(t))
  const cjkTerms   = terms.filter((t) => !/^[\x00-\x7F]+$/.test(t))

  const seenIds = new Set<string>()
  const allRows: Array<Record<string, unknown>> = []

  // ── Strategy 1: FTS5 MATCH for ASCII terms ────────────────────────────────
  if (asciiTerms.length > 0) {
    const safeQuery = asciiTerms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
    const ftsResult = await db.execute({
      sql: `
        SELECT f.chunk_id, f.document_id, d.filename, f.content, f.rank AS score, dc.chunk_index
        FROM chunks_fts f
        JOIN documents d        ON d.id = f.document_id
        JOIN document_chunks dc ON dc.id = f.chunk_id
        WHERE chunks_fts MATCH ?
          AND f.tenant_id = ?
          AND d.tenant_id = f.tenant_id AND dc.tenant_id = f.tenant_id
          ${scopeSql}
        ORDER BY rank
        LIMIT ?
      `,
      args: [safeQuery, tenantId, ...(scopedIds ?? []), limit],
    }).catch(() => ({ rows: [] }))

    for (const row of ftsResult.rows) {
      const id = row.chunk_id as string
      if (!seenIds.has(id)) { seenIds.add(id); allRows.push(row as Record<string, unknown>) }
    }
  }

  // ── Strategy 2: LIKE for CJK terms (or fallback if FTS5 found nothing) ─────
  const likeTerms = cjkTerms.length > 0 ? cjkTerms
    : allRows.length === 0 ? asciiTerms   // fallback: retry all terms via LIKE
    : []

  if (likeTerms.length > 0) {
    const likeConditions = likeTerms.map(() => `dc.content LIKE ?`).join(' OR ')
    const likeArgs = likeTerms.map((t) => `%${t}%`)
    const likeResult = await db.execute({
      sql: `
        SELECT dc.id AS chunk_id, dc.document_id, d.filename, dc.content, 0.0 AS score, dc.chunk_index
        FROM document_chunks dc
        JOIN documents d ON d.id = dc.document_id
        WHERE dc.tenant_id = ? AND d.tenant_id = dc.tenant_id AND (${likeConditions}) ${scopeSql}
        ORDER BY dc.chunk_index
        LIMIT ?
      `,
      args: [tenantId, ...likeArgs, ...(scopedIds ?? []), limit],
    })
    for (const row of likeResult.rows) {
      const id = row.chunk_id as string
      if (!seenIds.has(id)) { seenIds.add(id); allRows.push(row as Record<string, unknown>) }
    }
  }

  // Trim to limit
  const result = { rows: allRows.slice(0, limit) }

  return result.rows.map((row) => ({
    chunkId: row.chunk_id as string,
    documentId: row.document_id as string,
    filename: row.filename as string,
    content: row.content as string,
    score: row.score as number,
    chunkIndex: row.chunk_index as number,
  }))
}

/**
 * List all documents for a tenant.
 */
export async function listDocuments(tenantId: string): Promise<KBDocument[]> {
  const db = await getDb()

  const result = await db.execute({
    sql: `SELECT id, tenant_id, filename, content_type, chunk_count, created_at
          FROM documents
          WHERE tenant_id = ?
          ORDER BY created_at DESC`,
    args: [tenantId],
  })

  return result.rows.map((row) => ({
    id: row.id as string,
    tenantId: row.tenant_id as string,
    filename: row.filename as string,
    contentType: row.content_type as string,
    chunkCount: row.chunk_count as number,
    createdAt: row.created_at as number,
  }))
}

/**
 * Delete a document and all its chunks (cascade) plus FTS index entries.
 * Returns true if the document existed and was deleted.
 */
export async function deleteDocument(tenantId: string, documentId: string): Promise<boolean> {
  const db = await getDb()

  // Verify ownership before deletion
  const check = await db.execute({
    sql: `SELECT id FROM documents WHERE id = ? AND tenant_id = ?`,
    args: [documentId, tenantId],
  })

  if (check.rows.length === 0) return false

  // Delete FTS entries first (not covered by CASCADE)
  await db.execute({
    sql: `DELETE FROM chunks_fts WHERE document_id = ?`,
    args: [documentId],
  })

  // Delete document — cascades to document_chunks
  await db.execute({
    sql: `DELETE FROM documents WHERE id = ? AND tenant_id = ?`,
    args: [documentId, tenantId],
  })

  return true
}

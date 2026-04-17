import type { FastifyInstance } from 'fastify'
import {
  addDocument,
  listDocuments,
  deleteDocument,
  searchChunks,
  type KBDocument,
  type SearchResult,
} from '../../../storage/knowledge/kb-repo.js'

interface UploadJsonBody {
  filename: string
  content: string
}

interface SearchBody {
  query: string
  limit?: number
}

export async function knowledgeRoutes(fastify: FastifyInstance) {
  // Allow text/plain bodies so raw document text can be posted directly
  fastify.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body)
  })

  // Helper: extract tenantId from auth context
  const getTenantId = (request: unknown): string =>
    (request as { authContext?: { tenantId: string } }).authContext?.tenantId ?? 'default'

  // ── POST /knowledge/documents ─────────────────────────────────────────────
  // Accepts:
  //   Content-Type: application/json  → { filename, content }
  //   Content-Type: text/plain        → raw text (filename from header or default)
  fastify.post<{ Body: UploadJsonBody | string }>('/knowledge/documents', async (request, reply) => {
    const tenantId = getTenantId(request)
    const contentType = request.headers['content-type'] ?? ''

    let filename: string
    let text: string
    let mimeType: string

    if (contentType.startsWith('text/plain')) {
      // Plain text upload
      text = request.body as string
      filename =
        (request.headers['x-filename'] as string | undefined) ??
        `document-${Date.now()}.txt`
      mimeType = 'text/plain'
    } else {
      // JSON upload
      const body = request.body as UploadJsonBody
      if (!body?.filename || !body?.content) {
        return reply.code(400).send({ error: 'filename and content are required' })
      }
      filename = body.filename
      text = body.content
      mimeType = 'text/plain'
    }

    if (!text || text.trim().length === 0) {
      return reply.code(400).send({ error: 'Document content must not be empty' })
    }

    const doc = await addDocument(tenantId, filename, mimeType, text)
    return reply.code(201).send(doc)
  })

  // ── GET /knowledge/documents ──────────────────────────────────────────────
  fastify.get('/knowledge/documents', async (request, reply) => {
    const tenantId = getTenantId(request)
    const docs = await listDocuments(tenantId)
    return reply.send(docs)
  })

  // ── DELETE /knowledge/documents/:id ──────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>('/knowledge/documents/:id', async (request, reply) => {
    const tenantId = getTenantId(request)
    const { id } = request.params
    const deleted = await deleteDocument(tenantId, id)
    if (!deleted) {
      return reply.code(404).send({ error: 'Document not found' })
    }
    return reply.code(200).send({ deleted: true })
  })

  // ── POST /knowledge/search ────────────────────────────────────────────────
  fastify.post<{ Body: SearchBody }>('/knowledge/search', async (request, reply) => {
    const tenantId = getTenantId(request)
    const { query, limit = 5 } = request.body ?? {}

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return reply.code(400).send({ error: 'query must be a non-empty string' })
    }

    const results: SearchResult[] = await searchChunks(tenantId, query, limit)
    return reply.send(results)
  })
}

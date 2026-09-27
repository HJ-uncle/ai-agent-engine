import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  addDocument,
  listDocuments,
  deleteDocument,
  searchChunks,
  type KBDocument,
  type SearchResult,
} from '../../../storage/knowledge/kb-repo.js'
import { success, fail, paginateArray } from '../response.js'

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
  const getTenantId = (req: FastifyRequest) => (req as any).authContext?.tenantId ?? 'default'

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
        return reply.code(200).send(fail(40001, 'filename and content are required'))
      }
      filename = body.filename
      text = body.content
      mimeType = 'text/plain'
    }

    if (!text || text.trim().length === 0) {
      return reply.code(200).send(fail(40001, 'Document content must not be empty'))
    }

    try {
      const doc = await addDocument(tenantId, filename, mimeType, text)
      return reply.code(200).send(success(doc))
    } catch (err: any) {
      return reply.code(200).send(fail(50000, err.message))
    }
  })

  // ── GET /knowledge/documents ──────────────────────────────────────────────
  fastify.get<{ Querystring: { current?: number; pageSize?: number } }>('/knowledge/documents', async (request, reply) => {
    const tenantId = getTenantId(request)
    const { current, pageSize } = request.query
    const docs = await listDocuments(tenantId)
    return reply.code(200).send(paginateArray(docs, current, pageSize))
  })

  // ── DELETE /knowledge/documents/:id ──────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>('/knowledge/documents/:id', async (request, reply) => {
    const tenantId = getTenantId(request)
    const { id } = request.params
    try {
      const deleted = await deleteDocument(tenantId, id)
      if (!deleted) {
        return reply.code(200).send(fail(40400, 'Document not found'))
      }
      return reply.code(200).send(success({ deleted: true }))
    } catch (err: any) {
      return reply.code(200).send(fail(50000, err.message))
    }
  })

  // ── POST /knowledge/search ────────────────────────────────────────────────
  fastify.post<{ Body: SearchBody }>('/knowledge/search', async (request, reply) => {
    const tenantId = getTenantId(request)
    const { query, limit = 5 } = request.body ?? {}

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return reply.code(200).send(fail(40001, 'query must be a non-empty string'))
    }

    try {
      const results: SearchResult[] = await searchChunks(tenantId, query, limit)
      return reply.code(200).send(success(results))
    } catch (err: any) {
      return reply.code(200).send(fail(50000, err.message))
    }
  })
}

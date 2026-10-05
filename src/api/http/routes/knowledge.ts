import type { FastifyInstance, FastifyRequest } from 'fastify'
import { success, fail, paginateArray } from '../response.js'
import { createKnowledgeBase, listKnowledgeBases, getKnowledgeBase, updateKnowledgeBase, deleteKnowledgeBase, addDocument, listDocuments, getDocument, updateDocument, deleteDocument, searchChunks } from '../../../storage/knowledge/kb-repo.js'
import { KnowledgeError, MAX_KNOWLEDGE_BODY_BYTES, MAX_KNOWLEDGE_QUERY_LENGTH, MAX_KNOWLEDGE_TEXT_BYTES, validateBaseId, validateContent, validateLimit, validateScopes, validateText } from '../../../storage/knowledge/types.js'
import { extractKnowledgeContent, KNOWLEDGE_SUPPORTED_EXTENSIONS, supportedKnowledgeFormatsDescription } from '../../../storage/knowledge/content-extractor.js'

const tenant = (req: FastifyRequest): string => (req as any).authContext?.tenantId ?? 'default'
const bad = (error: unknown, fallback = 40001) => fail(error instanceof KnowledgeError ? error.code : fallback, error instanceof Error ? error.message : String(error))
export async function knowledgeRoutes(fastify: FastifyInstance) {
  fastify.addContentTypeParser('text/plain', { parseAs: 'string', bodyLimit: MAX_KNOWLEDGE_BODY_BYTES }, (_req, body, done) => done(null, body))
  fastify.get('/knowledge/formats', async (_req, reply) => reply.send(success({ extensions: [...KNOWLEDGE_SUPPORTED_EXTENSIONS], description: supportedKnowledgeFormatsDescription() })))
  fastify.get('/knowledge/bases', async (req, reply) => reply.send(success(await listKnowledgeBases(tenant(req)))))
  fastify.post<{ Body: { name?: string; description?: string } }>('/knowledge/bases', async (req, reply) => {
    try { validateText(req.body?.name, 'name', 200); if (req.body?.description !== undefined) validateText(req.body.description, 'description', 4000, true); return reply.send(success(await createKnowledgeBase(tenant(req), req.body.name, req.body.description ?? ''))) } catch (e) { return reply.send(bad(e, String(e).includes('UNIQUE') ? 40901 : 40001)) }
  })
  fastify.get<{ Params: { id: string } }>('/knowledge/bases/:id', async (req, reply) => { const item = await getKnowledgeBase(tenant(req), req.params.id); return item ? reply.send(success(item)) : reply.send(fail(40400, 'Knowledge base not found')) })
  fastify.put<{ Params: { id: string }; Body: { name?: string; description?: string } }>('/knowledge/bases/:id', async (req, reply) => { try { if (req.body?.name !== undefined) validateText(req.body.name, 'name', 200); if (req.body?.description !== undefined) validateText(req.body.description, 'description', 4000, true); const item = await updateKnowledgeBase(tenant(req), req.params.id, req.body ?? {}); return item ? reply.send(success(item)) : reply.send(fail(40400, 'Knowledge base not found')) } catch (e) { return reply.send(bad(e, String(e).includes('UNIQUE') ? 40901 : 40001)) } })
  fastify.delete<{ Params: { id: string } }>('/knowledge/bases/:id', async (req, reply) => { try { return (await deleteKnowledgeBase(tenant(req), req.params.id)) ? reply.send(success({ deleted: true })) : reply.send(fail(40400, 'Knowledge base not found')) } catch (e) { return reply.send(bad(e, 50000)) } })

  fastify.post<{ Querystring: { knowledgeBaseId?: string }; Body: { filename?: string; content?: string; knowledgeBaseId?: string; contentType?: string } | string }>('/knowledge/documents', async (req, reply) => {
    try {
      const body = req.body
      let filename: unknown; let content: unknown; let contentType: unknown = 'text/plain'; let knowledgeBaseId: unknown
      const requestContentType = String(req.headers['content-type'] ?? '')
      if (requestContentType.startsWith('multipart/form-data')) {
        const file = await req.file()
        if (!file) throw new KnowledgeError('缺少上传文件')
        const chunks: Buffer[] = []; let totalBytes = 0
        for await (const chunk of file.file) { const part = Buffer.from(chunk); totalBytes += part.byteLength; if (totalBytes > MAX_KNOWLEDGE_BODY_BYTES) throw new KnowledgeError('文档文件不能超过 2 MiB'); chunks.push(part) }
        const extracted = await extractKnowledgeContent(file.filename, Buffer.concat(chunks), file.mimetype)
        filename = file.filename
        content = extracted.content
        contentType = extracted.contentType
        knowledgeBaseId = (file.fields as any)?.knowledgeBaseId?.value ?? req.query.knowledgeBaseId
      } else if (requestContentType.startsWith('text/plain')) { content = body; filename = req.headers['x-filename'] ?? `document-${Date.now()}.txt`; knowledgeBaseId = req.headers['x-knowledge-base-id'] ?? req.query.knowledgeBaseId } else { if (!body || typeof body !== 'object' || Array.isArray(body)) throw new KnowledgeError('JSON body must be an object'); filename = (body as any).filename; content = (body as any).content; contentType = (body as any).contentType ?? 'text/plain'; knowledgeBaseId = (body as any).knowledgeBaseId }
      validateText(filename, 'filename', 512); validateContent(content); validateText(contentType, 'contentType', 128); validateBaseId(knowledgeBaseId)
      return reply.send(success(await addDocument(tenant(req), filename, contentType, content, knowledgeBaseId)))
    } catch (e) { return reply.send(bad(e)) }
  })
  fastify.get<{ Querystring: { current?: number; pageSize?: number; knowledgeBaseId?: string } }>('/knowledge/documents', async (req, reply) => reply.send(paginateArray(await listDocuments(tenant(req), req.query.knowledgeBaseId), req.query.current, req.query.pageSize)))
  fastify.get<{ Params: { id: string } }>('/knowledge/documents/:id', async (req, reply) => { const item = await getDocument(tenant(req), req.params.id); return item ? reply.send(success(item)) : reply.send(fail(40400, 'Document not found')) })
  fastify.put<{ Params: { id: string }; Body: { filename?: string; content?: string; contentType?: string; knowledgeBaseId?: string | null } }>('/knowledge/documents/:id', async (req, reply) => { try { const body = req.body ?? {}; if (typeof body !== 'object' || Array.isArray(body)) throw new KnowledgeError('JSON body must be an object'); if (body.filename !== undefined) validateText(body.filename, 'filename', 512); if (body.content !== undefined) validateContent(body.content); if (body.contentType !== undefined) validateText(body.contentType, 'contentType', 128); validateBaseId(body.knowledgeBaseId); const item = await updateDocument(tenant(req), req.params.id, body); return item ? reply.send(success(item)) : reply.send(fail(40400, 'Document not found')) } catch (e) { return reply.send(bad(e)) } })
  fastify.delete<{ Params: { id: string } }>('/knowledge/documents/:id', async (req, reply) => { try { return (await deleteDocument(tenant(req), req.params.id)) ? reply.send(success({ deleted: true })) : reply.send(fail(40400, 'Document not found')) } catch (e) { return reply.send(bad(e, 50000)) } })
  fastify.post<{ Body: { query?: string; limit?: number; knowledgeBaseIds?: string[] } }>('/knowledge/search', async (req, reply) => { try { validateText(req.body?.query, 'query', MAX_KNOWLEDGE_QUERY_LENGTH); const limit = req.body?.limit ?? 5; validateLimit(limit); validateScopes(req.body?.knowledgeBaseIds); return reply.send(success(await searchChunks(tenant(req), req.body.query, limit, req.body.knowledgeBaseIds))) } catch (e) { return reply.send(bad(e)) } })
}

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AgentContext, JSONSchema, Tool, ToolResult } from '../../core/agent-context/index.js'
import { throwIfAborted } from '../../core/utils/abort.js'
import { createApprovedMutationTool } from '../management/approved-mutation.js'
import * as repository from '../../storage/knowledge/kb-repo.js'
import { extractKnowledgeContent, KNOWLEDGE_SUPPORTED_EXTENSIONS } from '../../storage/knowledge/content-extractor.js'
import { KnowledgeError, MAX_KNOWLEDGE_BODY_BYTES, MAX_KNOWLEDGE_QUERY_LENGTH, validateContent, validateText,
  type DocumentPatch, type KBDocument, type KnowledgeBase } from '../../storage/knowledge/types.js'
import { canonicalFilePathSync, hashFileContent } from '../../shared/file-version.js'
import { workspaceManager } from '../../workspace/index.js'

const id = z.string().trim().min(1).max(128).refine(value => !value.includes('\0'))
const text = (label: string, max: number, empty = false) => z.string().superRefine((value, ctx) => {
  try { validateText(value, label, max, empty) } catch (error) { ctx.addIssue({ code: 'custom', message: (error as Error).message }) }
})
const content = z.string().superRefine((value, ctx) => {
  try { validateContent(value) } catch (error) { ctx.addIssue({ code: 'custom', message: (error as Error).message }) }
})
const pagination = { offset: z.number().int().min(0).max(1_000_000).default(0), limit: z.number().int().min(1).max(100).default(30) }
const baseFields = { name: text('name', 200), description: text('description', 4000, true).optional() }
const documentFields = { filename: text('filename', 512).optional(), content: content.optional(), contentType: text('contentType', 128).optional(), knowledgeBaseId: id.nullable().optional() }
const schemas = {
  create: z.object(baseFields).strict(),
  update: z.object({ id, name: baseFields.name.optional(), description: baseFields.description }).strict().refine(value => value.name !== undefined || value.description !== undefined, 'Provide a name or description change'),
  delete: z.object({ id }).strict(),
  import: z.object({ knowledgeBaseId: id, filename: documentFields.filename, content: documentFields.content, contentType: documentFields.contentType, path: text('path', 4096).optional() }).strict()
    .refine(value => (value.path !== undefined) !== (value.content !== undefined), 'Provide exactly one of path or content')
    .refine(value => value.path !== undefined || value.filename !== undefined, 'Text imports require filename'),
  document_update: z.object({ id, ...documentFields }).strict().refine(value => Object.keys(value).length > 1, 'Provide a document change'),
  document_delete: z.object({ id }).strict(),
}
type Action = keyof typeof schemas
type SourceSnapshot = { path: string; submittedPath: string; hash: string }
type Operation = {
  version: 1; tenantId: string; action: Action; id: string; expectedRevision?: number
  before?: KnowledgeBase | KBDocument
  input: { name?: string; description?: string; filename?: string; content?: string; contentType?: string; knowledgeBaseId?: string | null }
  source?: SourceSnapshot; warning?: string
}

function assertAuthority(ctx: AgentContext): void {
  if (!ctx.tenantId || !ctx.managementPrincipal || ctx.managementPrincipal.tenantId !== ctx.tenantId)
    throw new KnowledgeError('Knowledge management requires the current authenticated tenant context', 40300)
  throwIfAborted(ctx.signal)
}
function scopes(ctx: AgentContext): readonly string[] | undefined { return ctx.resourceScope?.knowledgeBases ?? undefined }
function scopeLimits(ctx: AgentContext): readonly (readonly string[])[] {
  return [scopes(ctx), ctx.managementKnowledgeScope].filter((scope): scope is readonly string[] => scope != null)
}
function baseAllowed(ctx: AgentContext, baseId: string | null): boolean {
  return scopeLimits(ctx).every(scope => baseId !== null && scope.includes(baseId))
}
function assertBaseScope(ctx: AgentContext, baseId: string | null): void {
  if (!baseAllowed(ctx, baseId)) throw new KnowledgeError('Knowledge base is outside the explicitly bound resource scope', 40300)
}
function documentAllowed(ctx: AgentContext, document: KBDocument): boolean {
  // Intersect permissions at the document level: a base grants its documents,
  // while a document binding never grants its siblings or the containing base.
  return scopeLimits(ctx).every(scope => scope.includes(document.id)
    || document.knowledgeBaseId !== null && scope.includes(document.knowledgeBaseId))
}
async function requireBase(ctx: AgentContext, baseId: string): Promise<KnowledgeBase> {
  assertBaseScope(ctx, baseId)
  const base = await repository.getKnowledgeBase(ctx.tenantId, baseId)
  if (!base) throw new KnowledgeError('Knowledge base not found', 40400)
  return base
}
async function requireDocument(ctx: AgentContext, documentId: string) {
  const document = await repository.getDocument(ctx.tenantId, documentId)
  if (!document || !documentAllowed(ctx, document)) throw new KnowledgeError('Document not found in the bound resource scope', 40400)
  return document
}
function documentSummary(document: KBDocument): KBDocument {
  const { id, revision, tenantId, knowledgeBaseId, filename, contentType, chunkCount, status, contentExact, createdAt, updatedAt } = document
  return { id, revision, tenantId, knowledgeBaseId, filename, contentType, chunkCount, status, contentExact, createdAt, updatedAt }
}
function readWorkspaceFile(ctx: AgentContext, submittedPath: string): { path: string; bytes: Buffer; hash: string } {
  const safe = workspaceManager.resolveSafePath(ctx, submittedPath)
  const canonical = canonicalFilePathSync(safe)
  workspaceManager.resolveSafePath(ctx, canonical)
  const inside = workspaceManager.getPaths(ctx).some(root => {
    const relative = path.relative(canonicalFilePathSync(root), canonical)
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  })
  if (!inside) throw new KnowledgeError('Knowledge imports must stay inside the current workspace', 40300)
  // A bounded read also protects against a file growing after stat().
  const handle = fs.openSync(canonical, 'r')
  try {
    const stat = fs.fstatSync(handle)
    if (!stat.isFile()) throw new KnowledgeError('Import source must be a regular file')
    if (stat.size > MAX_KNOWLEDGE_BODY_BYTES) throw new KnowledgeError('Import file exceeds 2 MiB')
    const buffer = Buffer.alloc(MAX_KNOWLEDGE_BODY_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      const count = fs.readSync(handle, buffer, size, buffer.length - size, null)
      if (!count) break
      size += count
    }
    if (size > MAX_KNOWLEDGE_BODY_BYTES) throw new KnowledgeError('Import file exceeds 2 MiB')
    const bytes = buffer.subarray(0, size)
    return { path: canonical, bytes, hash: hashFileContent(bytes) }
  } finally { fs.closeSync(handle) }
}

async function prepare(action: Action, raw: unknown, ctx: AgentContext): Promise<Operation> {
  assertAuthority(ctx)
  const operation: Operation = { version: 1, tenantId: ctx.tenantId, action, id: randomUUID(), input: {} }
  if (action === 'create') {
    if (scopeLimits(ctx).length) throw new KnowledgeError('Cannot create a knowledge base under an explicit binding whitelist. Adjust the Agent/session knowledge scope first; creating a base does not expand permissions.', 40300)
    operation.input = schemas.create.parse(raw)
  } else if (action === 'update' || action === 'delete') {
    const parsed = action === 'update' ? schemas.update.parse(raw) : schemas.delete.parse(raw)
    const { id: baseId, ...patch } = parsed
    const base = await requireBase(ctx, baseId)
    Object.assign(operation, { id: baseId, before: base, expectedRevision: base.revision, input: patch })
  } else if (action === 'import') {
    const parsed = schemas.import.parse(raw)
    const base = await requireBase(ctx, parsed.knowledgeBaseId)
    operation.expectedRevision = base.revision
    operation.before = base
    if (parsed.path !== undefined) {
      const guard = workspaceManager.bindingReadGuard(ctx)
      const snapshot = readWorkspaceFile(ctx, parsed.path)
      const filename = parsed.filename ?? path.basename(snapshot.path)
      validateText(filename, 'filename', 512)
      const extension = path.extname(snapshot.path).toLowerCase()
      if (!(KNOWLEDGE_SUPPORTED_EXTENSIONS as readonly string[]).includes(extension)) throw new KnowledgeError(`Unsupported knowledge file format: ${extension || '(none)'}`)
      const extracted = await extractKnowledgeContent(snapshot.path, snapshot.bytes, parsed.contentType)
      guard.assertCurrent()
      validateContent(extracted.content)
      operation.input = { knowledgeBaseId: base.id, filename, content: extracted.content, contentType: extracted.contentType }
      operation.source = { path: snapshot.path, submittedPath: parsed.path, hash: snapshot.hash }
      operation.warning = extracted.warning
    } else operation.input = { knowledgeBaseId: base.id, filename: parsed.filename!, content: parsed.content!, contentType: parsed.contentType ?? 'text/plain' }
  } else {
    const parsed = action === 'document_update' ? schemas.document_update.parse(raw) : schemas.document_delete.parse(raw)
    const { id: documentId, ...fields } = parsed
    const patch: DocumentPatch = fields
    const document = await requireDocument(ctx, documentId)
    if ('knowledgeBaseId' in patch && patch.knowledgeBaseId !== undefined) {
      assertBaseScope(ctx, patch.knowledgeBaseId)
      if (patch.knowledgeBaseId) await requireBase(ctx, patch.knowledgeBaseId)
    }
    Object.assign(operation, { id: documentId, before: documentSummary(document), expectedRevision: document.revision, input: patch })
  }
  return operation
}

async function apply(operation: Operation, ctx: AgentContext): Promise<ToolResult> {
  assertAuthority(ctx)
  if (operation.tenantId !== ctx.tenantId) throw new KnowledgeError('Knowledge tenant changed', 40300)
  let result: unknown
  const { action, input, id: resourceId } = operation
  if (action === 'create') {
    if (scopeLimits(ctx).length) throw new KnowledgeError('The current Agent/session resource scope does not permit creation', 40300)
    result = await repository.createKnowledgeBase(ctx.tenantId, input.name!, input.description, resourceId, ctx.signal)
  } else if (action === 'update' || action === 'delete') {
    await requireBase(ctx, resourceId)
    result = action === 'update'
      ? await repository.updateKnowledgeBase(ctx.tenantId, resourceId, input, operation.expectedRevision, ctx.signal)
      : { deleted: await repository.deleteKnowledgeBase(ctx.tenantId, resourceId, operation.expectedRevision, ctx.signal) }
  } else if (action === 'import') {
    await requireBase(ctx, input.knowledgeBaseId!)
    if (operation.source) {
      const current = readWorkspaceFile(ctx, operation.source.submittedPath)
      if (current.path !== operation.source.path || current.hash !== operation.source.hash) throw new KnowledgeError('Import source changed after preview; request a new confirmation', 40901)
    }
    const document = await repository.addDocument(ctx.tenantId, input.filename!, input.contentType!, input.content!, input.knowledgeBaseId,
      { id: resourceId, expectedBaseRevision: operation.expectedRevision, signal: ctx.signal })
    result = { ...documentSummary(document), ...(operation.warning ? { warning: operation.warning } : {}) }
  } else {
    await requireDocument(ctx, resourceId)
    if (input.knowledgeBaseId !== undefined) assertBaseScope(ctx, input.knowledgeBaseId)
    if (action === 'document_update') {
      const document = await repository.updateDocument(ctx.tenantId, resourceId, input as DocumentPatch, operation.expectedRevision, ctx.signal)
      result = document ? documentSummary(document) : null
    } else result = { deleted: await repository.deleteDocument(ctx.tenantId, resourceId, operation.expectedRevision, ctx.signal) }
  }
  return { success: true, status: 'succeeded', output: JSON.stringify(result),
    metadata: { resourceChange: { kind: 'knowledge', action, id: resourceId } } }
}
function preview(operation: Operation): unknown {
  const { content: body, ...input } = operation.input
  return { action: operation.action, id: operation.id, before: operation.before, input: { ...input,
    ...(body !== undefined ? { content: body, bytes: Buffer.byteLength(body, 'utf8'), sha256: hashFileContent(body) } : {}) },
    ...(operation.source ? { source: operation.source } : {}), ...(operation.warning ? { warning: operation.warning } : {}) }
}
const stringProperty: JSONSchema = { type: 'string' }
const idProperties: Record<string, JSONSchema> = { id: { type: 'string', description: 'Use the full ID returned by the knowledge tools.' } }
const baseProperties = { name: stringProperty, description: stringProperty }
const documentProperties = { filename: stringProperty, content: stringProperty, contentType: stringProperty, knowledgeBaseId: { type: ['string', 'null'] } }
const pageProperties = { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }
function parameters(properties: Record<string, JSONSchema>, required: string[] = []): JSONSchema { return { type: 'object', properties, required, additionalProperties: false } }
type ReadAccess = 'management' | 'selected-resources'
const readScopeGuidance = 'Knowledge IDs refer to knowledge bases or documents, not workspace files. Use the knowledge tools within the selected scope; do not inspect application databases to bypass access restrictions.'
function readContext(ctx: AgentContext, access: ReadAccess, scopeCeiling?: readonly string[]): AgentContext {
  if (access === 'management') { assertAuthority(ctx); return ctx }
  throwIfAborted(ctx.signal)
  if (!ctx.tenantId) throw new KnowledgeError('Knowledge reading requires the current tenant context', 40300)
  if (!scopes(ctx)?.length) throw new KnowledgeError('No knowledge base or document is selected for reading. Select a knowledge resource through the resource picker before reading it.', 40300)
  // An explicit user resource selection grants reading, independently of the
  // bound Agent's management ceiling. Intersect the current selection with the
  // immutable registration-time read ceiling, preserving base/document hierarchy.
  // Mutation tools never receive this view.
  return { ...ctx, managementKnowledgeScope: scopeCeiling ?? null }
}
function readTool(access: ReadAccess, scopeCeiling: readonly string[] | undefined, name: string, displayName: string, description: string, parameters: JSONSchema, execute: (raw: unknown, ctx: AgentContext) => Promise<unknown>): Tool {
  const resourceRead = access === 'selected-resources'
  const accessMetadata = (ctx: AgentContext) => ({ knowledgeScope: { mode: 'read-only', resourceIds: [...(scopes(ctx) ?? [])] } })
  return { name, displayName, description: description + (resourceRead ? ' Read-only access to the explicitly selected knowledge resources; knowledge IDs are not file paths.' : ''), parameters, executionMode: 'readonly', async execute(raw, ctx) {
    try { return { success: true, output: JSON.stringify(await execute(raw, readContext(ctx, access, scopeCeiling))), ...(resourceRead ? { metadata: accessMetadata(ctx) } : {}) } }
    catch (error) {
      const message = (error instanceof Error ? error.message : String(error)) + (resourceRead ? ` ${readScopeGuidance}` : '')
      return { success: false, status: 'failed', output: message, error: message,
        metadata: { code: error instanceof KnowledgeError ? error.code : 40001, ...(resourceRead ? accessMetadata(ctx) : {}) } }
    }
  } }
}
function page<T>(items: T[], offset: number, limit: number) { return { items: items.slice(offset, offset + limit), total: items.length, offset, limit, hasMore: offset + limit < items.length } }

function knowledgeReadTools(access: ReadAccess, scopeCeiling?: readonly string[]): Tool[] {
  return [
    readTool(access, scopeCeiling, 'knowledge_list', '列出知识库', 'List tenant knowledge bases within current explicit bindings.', parameters({ ...pageProperties, search: stringProperty }), async (raw, ctx) => {
      const input = z.object({ ...pagination, search: text('search', 200, true).optional() }).strict().parse(raw)
      const found = (await repository.listKnowledgeBases(ctx.tenantId)).filter(base => baseAllowed(ctx, base.id) && (!input.search || base.name.toLowerCase().includes(input.search.toLowerCase())))
      return page(found, input.offset, input.limit)
    }),
    readTool(access, scopeCeiling, 'knowledge_get', '查看知识库', 'Read a knowledge base and its current revision.', parameters(idProperties, ['id']), async (raw, ctx) => requireBase(ctx, schemas.delete.parse(raw).id)),
    readTool(access, scopeCeiling, 'knowledge_documents', '列出知识文档', 'List document metadata in the allowed knowledge scope.', parameters({ ...pageProperties, knowledgeBaseId: stringProperty }), async (raw, ctx) => {
      const input = z.object({ ...pagination, knowledgeBaseId: id.optional() }).strict().parse(raw)
      if (input.knowledgeBaseId) await requireBase(ctx, input.knowledgeBaseId)
      return page((await repository.listDocuments(ctx.tenantId, input.knowledgeBaseId)).filter(document => documentAllowed(ctx, document)), input.offset, input.limit)
    }),
    readTool(access, scopeCeiling, 'knowledge_document_get', '读取知识文档', 'Read document metadata and a bounded content slice. Continue from nextOffset when hasMore is true.', parameters({ ...idProperties, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 64000 } }, ['id']), async (raw, ctx) => {
      const input = z.object({ id, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(64000).default(16000) }).strict().parse(raw)
      const document = await requireDocument(ctx, input.id)
      const nextOffset = Math.min(document.content.length, input.offset + input.limit)
      return { ...documentSummary(document), content: document.content.slice(input.offset, nextOffset), contentLength: document.content.length, offset: input.offset, nextOffset, hasMore: nextOffset < document.content.length }
    }),
    readTool(access, scopeCeiling, 'knowledge_search', '搜索知识库', 'Search indexed knowledge using FTS and multilingual text matching, restricted before limiting results.', parameters({ query: stringProperty, limit: { type: 'integer', minimum: 1, maximum: 100 }, knowledgeBaseIds: { type: 'array', items: stringProperty, maxItems: 100 } }, ['query']), async (raw, ctx) => {
      const input = z.object({ query: text('query', MAX_KNOWLEDGE_QUERY_LENGTH), limit: z.number().int().min(1).max(100).default(5), knowledgeBaseIds: z.array(id).max(100).optional() }).strict().parse(raw)
      if (input.knowledgeBaseIds && scopes(ctx)) for (const scope of input.knowledgeBaseIds) {
        if (!scopes(ctx)!.includes(scope)) await requireDocument(ctx, scope)
      }
      return repository.searchChunks(ctx.tenantId, input.query, input.limit, input.knowledgeBaseIds ?? scopes(ctx), ctx.managementKnowledgeScope ?? undefined)
    }),
  ]
}

/** Reading selected knowledge does not grant any persistent management capability. */
export function createKnowledgeReadTools(scopeCeiling?: readonly string[] | null): Tool[] {
  return knowledgeReadTools('selected-resources', scopeCeiling == null ? undefined : [...scopeCeiling])
}

export function createKnowledgeManagementTools(): Tool[] {
  const mutations: Array<[Action, string, string, JSONSchema]> = [
    ['create', '创建知识库', 'Create a tenant knowledge base. Explicit binding whitelists cannot grant access to a new ID.', parameters(baseProperties, ['name'])],
    ['update', '更新知识库', 'Update knowledge base name or description with version checks.', parameters({ ...idProperties, ...baseProperties }, ['id'])],
    ['delete', '删除知识库', 'Delete a knowledge base and all its documents and search entries.', parameters(idProperties, ['id'])],
    ['import', '导入知识文档', 'Import text or a workspace file into a bound knowledge base. Supply exactly one of content or path. Source files are limited to 2 MiB; extracted text to 1 MiB.', parameters({ knowledgeBaseId: stringProperty, filename: stringProperty, content: stringProperty, contentType: stringProperty, path: stringProperty }, ['knowledgeBaseId'])],
    ['document_update', '更新知识文档', 'Update document text, filename or base binding and rebuild the search index.', parameters({ ...idProperties, ...documentProperties }, ['id'])],
    ['document_delete', '删除知识文档', 'Delete a knowledge document and its search index.', parameters(idProperties, ['id'])],
  ]
  return [
    ...knowledgeReadTools('management'),
    ...mutations.map(([action, displayName, description, schema]) => createApprovedMutationTool<Operation>({ name: `knowledge_${action}`, displayName, description, parameters: schema,
      prepare: (raw, ctx) => prepare(action, raw, ctx), preview,
      apply: (operation, ctx) => { if (operation.action !== action) throw new KnowledgeError('Approval action mismatch', 40300); return apply(operation, ctx) },
    })),
  ]
}

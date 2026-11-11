import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Tool, ToolResult } from '../../../core/agent-context/index.js'
import { createKnowledgeManagementTools } from '../../../tools/knowledge/management-tools.js'
import { WorkspaceManager, workspaceManager } from '../../../workspace/manager.js'
import * as database from '../../sqlite/db.js'
import * as repository from '../kb-repo.js'
import { knowledgeFixture } from './fixture.js'

let fixture: ReturnType<typeof knowledgeFixture>
let ctx: AgentContext
let tools: Tool[]
let project: string
beforeEach(() => {
  fixture = knowledgeFixture()
  vi.spyOn(database, 'getDb').mockReturnValue(fixture.db)
  vi.stubEnv('AUTH_ENABLED', 'false')
  project = path.join(fixture.root, 'project')
  fs.mkdirSync(project)
  const manager = new WorkspaceManager(path.join(fixture.root, 'private-workspaces'))
  vi.spyOn(workspaceManager, 'resolveSafePath').mockImplementation((scope, value) => manager.resolveSafePath(scope, value))
  vi.spyOn(workspaceManager, 'getPaths').mockImplementation(scope => manager.getPaths(scope))
  vi.spyOn(workspaceManager, 'bindingReadGuard').mockImplementation((scope, expected) => manager.bindingReadGuard(scope, expected))
  ctx = { tenantId: 'tenant-a', sessionId: 'session-a', cwd: project, workspacePaths: [project],
    managementPrincipal: { tenantId: 'tenant-a', method: 'none' } } as AgentContext
  tools = createKnowledgeManagementTools()
})
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fixture.close() })
const tool = (name: string) => tools.find(item => item.name === name)!
const read = (name: string, args: unknown = {}, scope = ctx) => tool(name).execute(args, scope)
const body = (result: ToolResult) => { expect(result.success, result.output).toBe(true); return JSON.parse(result.output) }
async function pending(name: string, args: Record<string, unknown>, scope = ctx) {
  const preview = await tool(name).preflight!(args, scope)
  expect(preview, preview?.output).toMatchObject({ success: false, status: 'waiting', needsConfirmation: true })
  return { ...scope, currentToolCallId: 'mutation-call', approvedToolCallId: 'mutation-call',
    resumeToolCall: { toolCall: { id: 'mutation-call', name, args }, decision: 'approved' as const, pendingAction: preview!.pendingAction } } as AgentContext
}
async function mutate(name: string, args: Record<string, unknown>, scope = ctx) { return read(name, args, await pending(name, args, scope)) }

describe('knowledge management tools', () => {
  it('exposes the complete package and requires tenant authority for reads and writes', async () => {
    expect(tools.map(item => item.name).sort()).toEqual(['knowledge_create', 'knowledge_delete', 'knowledge_document_delete', 'knowledge_document_get', 'knowledge_document_update', 'knowledge_documents', 'knowledge_get', 'knowledge_import', 'knowledge_list', 'knowledge_search', 'knowledge_update'])
    expect(await read('knowledge_list', {}, { ...ctx, managementPrincipal: undefined })).toMatchObject({ success: false })
    expect(await read('knowledge_create', { name: 'invalid' }, { ...ctx, managementPrincipal: { tenantId: 'other', method: 'none' } })).toMatchObject({ success: false })
    expect(await repository.listKnowledgeBases(ctx.tenantId)).toEqual([])
  })

  it('creates, updates and deletes only the exact approved operation and emits refresh receipts', async () => {
    const args = { name: 'Docs', description: 'Reference' }
    const approval = await pending('knowledge_create', args)
    expect(await repository.listKnowledgeBases(ctx.tenantId)).toEqual([])
    expect(await read('knowledge_create', { ...args, name: 'injected' }, approval)).toMatchObject({ success: false })
    const created = await read('knowledge_create', args, approval)
    const base = body(created)
    expect(created.metadata).toEqual({ resourceChange: { kind: 'knowledge', action: 'create', id: base.id } })
    expect(body(await read('knowledge_get', { id: base.id }))).toMatchObject({ name: 'Docs', revision: 1 })
    expect(await read('knowledge_create', args, approval)).toMatchObject({ success: false })
    expect(body(await read('knowledge_list')).items).toHaveLength(1)
    expect(body(await mutate('knowledge_update', { id: base.id, name: 'Renamed' }))).toMatchObject({ name: 'Renamed', revision: 2 })
    expect(body(await mutate('knowledge_delete', { id: base.id }))).toEqual({ deleted: true })
    expect(body(await read('knowledge_list')).items).toEqual([])
  })

  it('keeps tenant and explicit empty resource scopes closed', async () => {
    const a = await repository.createKnowledgeBase(ctx.tenantId, 'A')
    const b = await repository.createKnowledgeBase('other', 'B')
    const doc = await repository.addDocument('other', 'secret.txt', 'text/plain', 'private needle', b.id)
    expect(body(await read('knowledge_list')).items.map((item: { id: string }) => item.id)).toEqual([a.id])
    expect(await read('knowledge_get', { id: b.id })).toMatchObject({ success: false })
    expect(await read('knowledge_document_get', { id: doc.id })).toMatchObject({ success: false })
    expect(await read('knowledge_delete', { id: b.id })).toMatchObject({ success: false, status: 'failed' })
    const empty = { ...ctx, resourceScope: { knowledgeBases: [] } }
    expect(body(await read('knowledge_list', {}, empty)).items).toEqual([])
    expect(body(await read('knowledge_documents', {}, empty)).items).toEqual([])
    expect(body(await read('knowledge_search', { query: 'needle' }, empty))).toEqual([])
    expect(await read('knowledge_create', { name: 'No widening' }, empty)).toMatchObject({ success: false, status: 'failed' })
    expect(await read('knowledge_import', { knowledgeBaseId: a.id, filename: 'x.txt', content: 'text' }, empty)).toMatchObject({ success: false, status: 'failed' })
  })

  it('preserves document-level bindings without granting the containing base or sibling documents', async () => {
    const base = await repository.createKnowledgeBase(ctx.tenantId, 'Docs')
    const allowed = await repository.addDocument(ctx.tenantId, 'allowed.md', 'text/plain', 'needle alpha', base.id)
    const denied = await repository.addDocument(ctx.tenantId, 'denied.md', 'text/plain', 'needle beta', base.id)
    const bound = { ...ctx, resourceScope: { knowledgeBases: [allowed.id] } }
    expect(body(await read('knowledge_list', {}, bound)).items).toEqual([])
    expect(body(await read('knowledge_documents', {}, bound)).items.map((item: { id: string }) => item.id)).toEqual([allowed.id])
    expect(body(await read('knowledge_search', { query: 'needle' }, bound)).map((item: { documentId: string }) => item.documentId)).toEqual([allowed.id])
    expect(await read('knowledge_search', { query: 'needle', knowledgeBaseIds: [base.id] }, bound)).toMatchObject({ success: false })
    expect(await read('knowledge_delete', { id: base.id }, bound)).toMatchObject({ success: false, status: 'failed' })
    expect(await read('knowledge_document_get', { id: denied.id }, bound)).toMatchObject({ success: false })
    expect(body(await mutate('knowledge_document_update', { id: allowed.id, content: 'bound replacement' }, bound))).toMatchObject({ revision: 2 })
    expect((await repository.getDocument(ctx.tenantId, denied.id))?.content).toBe('needle beta')
  })

  it('does not let a request knowledge selection widen the stored Agent management ceiling', async () => {
    const allowed = await repository.createKnowledgeBase(ctx.tenantId, 'Allowed')
    const denied = await repository.createKnowledgeBase(ctx.tenantId, 'Denied')
    const document = await repository.addDocument(ctx.tenantId, 'private.txt', 'text/plain', 'private needle', denied.id)
    const widened = { ...ctx, managementKnowledgeScope: [allowed.id], resourceScope: { knowledgeBases: [denied.id] } }
    expect(body(await read('knowledge_list', {}, widened)).items).toEqual([])
    expect(body(await read('knowledge_documents', {}, widened)).items).toEqual([])
    expect(body(await read('knowledge_search', { query: 'needle', knowledgeBaseIds: [denied.id] }, widened))).toEqual([])
    for (const [name, args] of [
      ['knowledge_get', { id: denied.id }],
      ['knowledge_update', { id: denied.id, name: 'No' }],
      ['knowledge_delete', { id: denied.id }],
      ['knowledge_import', { knowledgeBaseId: denied.id, filename: 'no.txt', content: 'no' }],
      ['knowledge_document_get', { id: document.id }],
      ['knowledge_document_update', { id: document.id, content: 'no' }],
      ['knowledge_document_delete', { id: document.id }],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await read(name, args, widened)
      expect(result).toMatchObject({ success: false, status: 'failed' })
      expect(result.needsConfirmation).not.toBe(true)
    }
    expect((await repository.getDocument(ctx.tenantId, document.id))?.content).toBe('private needle')
    // The existing repository/RAG caller still honors its own request selection.
    expect((await repository.searchChunks(ctx.tenantId, 'needle', 1, [denied.id]))[0].documentId).toBe(document.id)
    const onlyCeiling = { ...ctx, managementKnowledgeScope: [allowed.id] }
    expect(body(await read('knowledge_list', {}, onlyCeiling)).items.map((value: { id: string }) => value.id)).toEqual([allowed.id])
  })

  it.each(['base-to-document', 'document-to-base'])('intersects %s grants before search limits without granting siblings', async direction => {
    const base = await repository.createKnowledgeBase(ctx.tenantId, 'Docs')
    const sibling = await repository.addDocument(ctx.tenantId, 'sibling.txt', 'text/plain', 'needle 关键资料', base.id)
    const selected = await repository.addDocument(ctx.tenantId, 'selected.txt', 'text/plain', 'needle 关键资料', base.id)
    const bounded = { ...ctx,
      managementKnowledgeScope: [direction === 'base-to-document' ? base.id : selected.id],
      resourceScope: { knowledgeBases: [direction === 'base-to-document' ? selected.id : base.id] } }
    expect(body(await read('knowledge_documents', {}, bounded)).items.map((value: { id: string }) => value.id)).toEqual([selected.id])
    expect(body(await read('knowledge_document_get', { id: selected.id }, bounded)).id).toBe(selected.id)
    expect(await read('knowledge_document_get', { id: sibling.id }, bounded)).toMatchObject({ success: false })
    expect(await read('knowledge_delete', { id: base.id }, bounded)).toMatchObject({ success: false, status: 'failed' })
    for (const query of ['needle', '关键资料']) {
      expect(body(await read('knowledge_search', { query, limit: 1 }, bounded)).map((value: { documentId: string }) => value.documentId)).toEqual([selected.id])
      expect(body(await read('knowledge_search', { query, limit: 1, knowledgeBaseIds: [selected.id] }, bounded)).map((value: { documentId: string }) => value.documentId)).toEqual([selected.id])
    }
    expect(body(await mutate('knowledge_document_update', { id: selected.id, content: 'authorized change' }, bounded))).toMatchObject({ id: selected.id, revision: 2 })
  })

  it('treats an empty Agent ceiling as no management access, including pending creation', async () => {
    const base = await repository.createKnowledgeBase(ctx.tenantId, 'Docs')
    await repository.addDocument(ctx.tenantId, 'doc.txt', 'text/plain', 'needle', base.id)
    const empty = { ...ctx, managementKnowledgeScope: [] }
    expect(body(await read('knowledge_list', {}, empty)).items).toEqual([])
    expect(body(await read('knowledge_documents', {}, empty)).items).toEqual([])
    expect(body(await read('knowledge_search', { query: 'needle' }, empty))).toEqual([])
    expect(await read('knowledge_create', { name: 'Blocked' }, empty)).toMatchObject({ success: false, status: 'failed' })
    const args = { name: 'Pending create' }
    const approved = await pending('knowledge_create', args)
    expect(await read('knowledge_create', args, { ...approved, managementKnowledgeScope: [] })).toMatchObject({ success: false })
    expect(await repository.listKnowledgeBases(ctx.tenantId)).toHaveLength(1)
  })

  it('rechecks a revoked Agent ceiling on approval and cannot move a document past that ceiling', async () => {
    const base = await repository.createKnowledgeBase(ctx.tenantId, 'Allowed')
    const destination = await repository.createKnowledgeBase(ctx.tenantId, 'Unbound destination')
    const document = await repository.addDocument(ctx.tenantId, 'doc.txt', 'text/plain', 'keep', base.id)
    const bounded = { ...ctx, managementKnowledgeScope: [base.id], resourceScope: { knowledgeBases: [base.id, destination.id] } }
    const args = { id: document.id, content: 'Approved replacement' }
    const approved = await pending('knowledge_document_update', args, bounded)
    expect(await read('knowledge_document_update', args, { ...approved, managementKnowledgeScope: [] })).toMatchObject({ success: false })
    expect(await read('knowledge_document_update', { id: document.id, knowledgeBaseId: destination.id }, bounded)).toMatchObject({ success: false, status: 'failed' })
    expect((await repository.getDocument(ctx.tenantId, document.id))?.content).toBe('keep')
    expect((await repository.getDocument(ctx.tenantId, document.id))?.knowledgeBaseId).toBe(base.id)
  })

  it('imports, pages, reindexes and deletes documents through the shared repository', async () => {
    const base = await repository.createKnowledgeBase(ctx.tenantId, 'Docs')
    const bound = { ...ctx, resourceScope: { knowledgeBases: [base.id] } }
    const args = { knowledgeBaseId: base.id, filename: 'guide.md', content: 'first needle\n\n  exact content  \n' }
    const approval = await pending('knowledge_import', args, bound)
    const imported = body(await read('knowledge_import', args, approval))
    expect(await read('knowledge_import', args, approval)).toMatchObject({ success: false })
    expect(body(await read('knowledge_documents', {}, bound)).items).toHaveLength(1)
    const first = body(await read('knowledge_document_get', { id: imported.id, limit: 5 }, bound))
    expect(first).toMatchObject({ content: 'first', nextOffset: 5, hasMore: true, contentExact: true })
    expect(body(await read('knowledge_document_get', { id: imported.id, offset: 5 }, bound)).content).toBe(args.content.slice(5))
    expect(body(await read('knowledge_search', { query: 'needle', knowledgeBaseIds: [imported.id] }, bound))[0].documentId).toBe(imported.id)
    body(await mutate('knowledge_document_update', { id: imported.id, filename: 'edited.md', content: 'replacement searchable' }, bound))
    expect(body(await read('knowledge_search', { query: 'needle' }, bound))).toEqual([])
    expect(body(await read('knowledge_search', { query: 'replacement' }, bound))[0].documentId).toBe(imported.id)
    body(await mutate('knowledge_document_delete', { id: imported.id }, bound))
    expect(body(await read('knowledge_search', { query: 'replacement' }, bound))).toEqual([])
    expect(body(await read('knowledge_documents', {}, bound)).items).toEqual([])
  })

  it('rejects same-second stale document/base approvals including changes to base contents', async () => {
    const base = await repository.createKnowledgeBase(ctx.tenantId, 'Docs')
    const doc = await repository.addDocument(ctx.tenantId, 'doc.md', 'text/plain', 'old', base.id)
    const args = { id: doc.id, content: 'approved old replacement' }
    const approval = await pending('knowledge_document_update', args)
    await repository.updateDocument(ctx.tenantId, doc.id, { content: 'newer external content' })
    expect(await read('knowledge_document_update', args, approval)).toMatchObject({ success: false, output: expect.stringContaining('changed after preview') })
    expect((await repository.getDocument(ctx.tenantId, doc.id))?.content).toBe('newer external content')
    const deletion = await pending('knowledge_delete', { id: base.id })
    await repository.addDocument(ctx.tenantId, 'later.md', 'text/plain', 'keep this too', base.id)
    expect(await read('knowledge_delete', { id: base.id }, deletion)).toMatchObject({ success: false, output: expect.stringContaining('changed after preview') })
    expect(await repository.listDocuments(ctx.tenantId, base.id)).toHaveLength(2)
  })

  it('rechecks the current scope and principal when resuming an approval', async () => {
    const base = await repository.createKnowledgeBase(ctx.tenantId, 'Docs')
    const args = { id: base.id, name: 'Should not happen' }
    const approval = await pending('knowledge_update', args)
    expect(await read('knowledge_update', args, { ...approval, resourceScope: { knowledgeBases: [] } })).toMatchObject({ success: false })
    expect(await read('knowledge_update', args, { ...approval, managementPrincipal: undefined })).toMatchObject({ success: false })
    expect((await repository.getKnowledgeBase(ctx.tenantId, base.id))?.name).toBe('Docs')
  })

  it('freezes workspace file content and rejects approval after a source change', async () => {
    const base = await repository.createKnowledgeBase(ctx.tenantId, 'Docs')
    const source = path.join(project, 'source.md')
    fs.writeFileSync(source, '# Workspace content\n\noriginal needle')
    const args = { knowledgeBaseId: base.id, path: 'source.md' }
    const approval = await pending('knowledge_import', args)
    fs.writeFileSync(source, '# Changed file')
    expect(await read('knowledge_import', args, approval)).toMatchObject({ success: false, output: expect.stringContaining('source changed') })
    expect(await repository.listDocuments(ctx.tenantId)).toEqual([])
    const imported = body(await mutate('knowledge_import', args))
    expect(imported.filename).toBe('source.md')
    expect((await repository.getDocument(ctx.tenantId, imported.id))?.content).toBe('# Changed file')
  })

  it('rejects imports outside the workspace, unsupported files and oversized input', async () => {
    const base = await repository.createKnowledgeBase(ctx.tenantId, 'Docs')
    fs.writeFileSync(path.join(fixture.root, 'private.txt'), 'outside secret')
    fs.writeFileSync(path.join(project, 'program.exe'), 'binary')
    fs.writeFileSync(path.join(project, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 65))
    fs.mkdirSync(path.join(project, 'folder.txt'))
    for (const file of ['../private.txt', 'program.exe', 'large.txt', 'folder.txt']) {
      expect(await read('knowledge_import', { knowledgeBaseId: base.id, path: file })).toMatchObject({ success: false, status: 'failed' })
    }
    for (const args of [
      { knowledgeBaseId: base.id, filename: 'huge.txt', content: '中'.repeat(400000) },
      { knowledgeBaseId: base.id, filename: 'x.txt', content: 'safe', tenantId: 'other' },
      { knowledgeBaseId: base.id, path: 'large.txt', content: 'ambiguous' },
    ]) expect(await read('knowledge_import', args)).toMatchObject({ success: false, status: 'failed' })
    expect(await repository.listDocuments(ctx.tenantId)).toEqual([])
  })

  it('rejects directory junction escapes during workspace import', async () => {
    const base = await repository.createKnowledgeBase(ctx.tenantId, 'Docs')
    const external = path.join(fixture.root, 'external')
    fs.mkdirSync(external)
    fs.writeFileSync(path.join(external, 'secret.txt'), 'outside')
    fs.symlinkSync(external, path.join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await read('knowledge_import', { knowledgeBaseId: base.id, path: 'linked/secret.txt' })).toMatchObject({ success: false, status: 'failed' })
    expect(await repository.listDocuments(ctx.tenantId)).toEqual([])
  })

  it.each(['create', 'update', 'delete', 'import', 'document_update', 'document_delete'])('cancels queued %s after acquiring the SQLite transaction without writing', async action => {
    const base = await repository.createKnowledgeBase(ctx.tenantId, 'Original')
    const document = await repository.addDocument(ctx.tenantId, 'original.txt', 'text/plain', 'original needle', base.id)
    const input: Record<string, Record<string, unknown>> = {
      create: { name: 'Cancelled create' }, update: { id: base.id, name: 'Cancelled update' }, delete: { id: base.id },
      import: { knowledgeBaseId: base.id, filename: 'cancelled.txt', content: 'cancelled insertion' },
      document_update: { id: document.id, content: 'cancelled edit' }, document_delete: { id: document.id },
    }
    const name = `knowledge_${action}`, args = input[action]
    const approval = await pending(name, args)
    const original = { base: await repository.getKnowledgeBase(ctx.tenantId, base.id), document: await repository.getDocument(ctx.tenantId, document.id) }
    const controller = new AbortController()
    const transaction = fixture.db.transaction.bind(fixture.db)
    let queued = false
    // Use a real active transaction in the fixture worker. The management
    // transaction is already queued when cancellation arrives, then acquires
    // ownership after the blocker releases it.
    vi.spyOn(fixture.db, 'transaction').mockImplementationOnce(async mode => {
      const blocker = await transaction('write')
      try {
        const waiting = transaction(mode)
        queued = true
        controller.abort(new DOMException('Cancelled while queued', 'AbortError'))
        await blocker.rollback()
        return await waiting
      } finally { blocker.close() }
    })
    const result = await read(name, args, { ...approval, signal: controller.signal })
    expect(queued).toBe(true)
    expect(result).toMatchObject({ success: false, status: 'cancelled', output: 'Cancelled while queued' })
    expect(result.metadata?.resourceChange).toBeUndefined()
    expect(await repository.listKnowledgeBases(ctx.tenantId)).toEqual([original.base])
    expect(await repository.listDocuments(ctx.tenantId)).toHaveLength(1)
    expect(await repository.getDocument(ctx.tenantId, document.id)).toEqual(original.document)
    expect(await repository.searchChunks(ctx.tenantId, 'cancelled')).toEqual([])
    expect((await repository.searchChunks(ctx.tenantId, 'needle'))[0].documentId).toBe(document.id)
  })

  it('rolls back an import cancelled after its document and FTS batch has executed', async () => {
    const base = await repository.createKnowledgeBase(ctx.tenantId, 'Original')
    const args = { knowledgeBaseId: base.id, filename: 'cancelled.txt', content: 'cancelled needle' }
    const approval = await pending('knowledge_import', args)
    const controller = new AbortController()
    const transaction = fixture.db.transaction.bind(fixture.db)
    let batchExecuted = false
    vi.spyOn(fixture.db, 'transaction').mockImplementationOnce(async mode => {
      const tx = await transaction(mode)
      const batch = tx.batch.bind(tx)
      vi.spyOn(tx, 'batch').mockImplementation(async statements => {
        const result = await batch(statements)
        batchExecuted = true
        controller.abort(new DOMException('Cancelled during import', 'AbortError'))
        return result
      })
      return tx
    })
    expect(await read('knowledge_import', args, { ...approval, signal: controller.signal })).toMatchObject({ success: false, status: 'cancelled' })
    expect(batchExecuted).toBe(true)
    expect(await repository.listDocuments(ctx.tenantId)).toEqual([])
    expect(await repository.searchChunks(ctx.tenantId, 'needle')).toEqual([])
    expect(await repository.getKnowledgeBase(ctx.tenantId, base.id)).toEqual(base)
  })

  it('rolls back creation when cancellation arrives after INSERT but before COMMIT', async () => {
    await repository.listKnowledgeBases(ctx.tenantId)
    const args = { name: 'Cancelled before commit' }
    const approval = await pending('knowledge_create', args)
    const controller = new AbortController()
    const transaction = fixture.db.transaction.bind(fixture.db)
    let inserted = false
    vi.spyOn(fixture.db, 'transaction').mockImplementationOnce(async mode => {
      const tx = await transaction(mode)
      const execute = tx.execute.bind(tx)
      vi.spyOn(tx, 'execute').mockImplementation(async (statement: any, values?: any) => {
        const result = await execute(typeof statement === 'string' && values !== undefined ? { sql: statement, args: values } : statement)
        if ((typeof statement === 'string' ? statement : statement.sql).startsWith('INSERT INTO knowledge_bases')) {
          inserted = true
          controller.abort(new DOMException('Cancelled before commit', 'AbortError'))
        }
        return result
      })
      return tx
    })
    expect(await read('knowledge_create', args, { ...approval, signal: controller.signal })).toMatchObject({ success: false, status: 'cancelled' })
    expect(inserted).toBe(true)
    expect(await repository.listKnowledgeBases(ctx.tenantId)).toEqual([])
  })

  it('allows only one concurrent update of the same approved revision', async () => {
    const base = await repository.createKnowledgeBase(ctx.tenantId, 'Docs')
    const doc = await repository.addDocument(ctx.tenantId, 'doc.txt', 'text/plain', 'old text', base.id)
    const results = await Promise.allSettled([
      repository.updateDocument(ctx.tenantId, doc.id, { content: 'first writer' }, doc.revision),
      repository.updateDocument(ctx.tenantId, doc.id, { content: 'second writer' }, doc.revision),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((await repository.getDocument(ctx.tenantId, doc.id))?.revision).toBe(doc.revision + 1)
  })
})

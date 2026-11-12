import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, ToolResult } from '../../../core/agent-context/index.js'
import { createKnowledgeManagementTools, createKnowledgeReadTools } from '../management-tools.js'
import * as database from '../../../storage/sqlite/db.js'
import * as repository from '../../../storage/knowledge/kb-repo.js'
import { knowledgeFixture } from '../../../storage/knowledge/__tests__/fixture.js'

let fixture: ReturnType<typeof knowledgeFixture>
const tools = createKnowledgeReadTools()
const context = (ids?: readonly string[] | null): AgentContext => ({
  tenantId: 'reader-tenant', sessionId: 'reading-session', parentSessionId: 'parent-session',
  workspaceDir: fixture.root, resourceScope: { knowledgeBases: ids }, managementKnowledgeScope: [] as readonly string[],
}) as AgentContext
const run = (name: string, raw: unknown, ctx: AgentContext) => tools.find(tool => tool.name === name)!.execute(raw, ctx)
const body = (result: ToolResult) => { expect(result.success, result.output).toBe(true); return JSON.parse(result.output) }

beforeEach(() => {
  fixture = knowledgeFixture()
  vi.spyOn(database, 'getDb').mockReturnValue(fixture.db)
})
afterEach(async () => { vi.restoreAllMocks(); await fixture.close() })

describe('selected knowledge read tools', () => {
  it('provides only five reads and reads an explicitly selected base despite an empty Agent management ceiling', async () => {
    expect(tools.map(tool => tool.name)).toEqual(['knowledge_list', 'knowledge_get', 'knowledge_documents', 'knowledge_document_get', 'knowledge_search'])
    expect(tools.every(tool => tool.executionMode === 'readonly' && !tool.preflight)).toBe(true)
    const base = await repository.createKnowledgeBase('reader-tenant', '笑话集')
    const doc = await repository.addDocument('reader-tenant', '笑话.md', 'text/markdown', '熊猫去买冰淇淋。', base.id)
    const ctx = context([base.id])
    expect(ctx.managementPrincipal).toBeUndefined()
    const listed = await run('knowledge_list', {}, ctx)
    expect(body(listed).items.map((item: { id: string }) => item.id)).toEqual([base.id])
    expect(listed.metadata).toEqual({ knowledgeScope: { mode: 'read-only', resourceIds: [base.id] } })
    expect(body(await run('knowledge_get', { id: base.id }, ctx)).name).toBe('笑话集')
    expect(body(await run('knowledge_documents', { knowledgeBaseId: base.id }, ctx)).items.map((item: { id: string }) => item.id)).toEqual([doc.id])
    expect(body(await run('knowledge_document_get', { id: doc.id }, ctx)).content).toBe('熊猫去买冰淇淋。')
    expect(body(await run('knowledge_search', { query: '熊猫' }, ctx)).map((item: { documentId: string }) => item.documentId)).toEqual([doc.id])
    // The read implementation must not change the caller's management authority.
    expect(ctx.managementKnowledgeScope).toEqual([])
    const management = createKnowledgeManagementTools()
    const managedCtx = { ...ctx, managementPrincipal: { tenantId: ctx.tenantId, method: 'none' as const } }
    expect(await management.find(tool => tool.name === 'knowledge_import')!.execute({ knowledgeBaseId: base.id, filename: 'forbidden.txt', content: 'Must not be saved' }, managedCtx))
      .toMatchObject({ success: false, status: 'failed' })
    expect(await repository.listDocuments(ctx.tenantId, base.id)).toHaveLength(1)
  })

  it.each([undefined, null, []] as const)('fails closed without a nonempty explicit resource selection (%s)', async ids => {
    const ctx = context(ids)
    for (const [name, raw] of [
      ['knowledge_list', {}], ['knowledge_get', { id: 'unselected' }], ['knowledge_documents', {}],
      ['knowledge_document_get', { id: 'unselected' }], ['knowledge_search', { query: 'secret' }],
    ] as const) {
      const result = await run(name, raw, ctx)
      expect(result).toMatchObject({ success: false, metadata: { code: 40300, knowledgeScope: { mode: 'read-only', resourceIds: [] } } })
      expect(result.output).toContain('No knowledge base or document is selected')
      expect(result.output).toContain('not workspace files')
      expect(result.output).toContain('do not inspect application databases')
    }
  })

  it('keeps document selection narrow without granting the containing base or sibling documents', async () => {
    const base = await repository.createKnowledgeBase('reader-tenant', 'Docs')
    const selected = await repository.addDocument('reader-tenant', 'selected.md', 'text/plain', 'needle selected', base.id)
    const sibling = await repository.addDocument('reader-tenant', 'sibling.md', 'text/plain', 'needle sibling', base.id)
    const ctx = context([selected.id])
    expect(body(await run('knowledge_list', {}, ctx)).items).toEqual([])
    expect(body(await run('knowledge_documents', {}, ctx)).items.map((item: { id: string }) => item.id)).toEqual([selected.id])
    expect(body(await run('knowledge_document_get', { id: selected.id }, ctx)).content).toBe('needle selected')
    for (const [name, args] of [['knowledge_get', { id: base.id }], ['knowledge_documents', { knowledgeBaseId: base.id }],
      ['knowledge_document_get', { id: sibling.id }], ['knowledge_search', { query: 'needle', knowledgeBaseIds: [base.id] }]] as const) {
      expect(await run(name, args, ctx)).toMatchObject({ success: false })
    }
    expect(body(await run('knowledge_search', { query: 'needle', limit: 1 }, ctx)).map((item: { documentId: string }) => item.documentId)).toEqual([selected.id])
  })

  it('isolates tenants even if another tenant resource ID appears in the selected scope', async () => {
    const foreign = await repository.createKnowledgeBase('foreign-tenant', 'Foreign')
    const secret = await repository.addDocument('foreign-tenant', 'secret.txt', 'text/plain', 'private needle', foreign.id)
    const ctx = context([foreign.id, secret.id])
    expect(body(await run('knowledge_list', {}, ctx)).items).toEqual([])
    expect(body(await run('knowledge_documents', {}, ctx)).items).toEqual([])
    expect(body(await run('knowledge_search', { query: 'needle' }, ctx))).toEqual([])
    expect(await run('knowledge_get', { id: foreign.id }, ctx)).toMatchObject({ success: false })
    expect(await run('knowledge_document_get', { id: secret.id }, ctx)).toMatchObject({ success: false })
  })

  it('filters before search limits and preserves bounded directory/content pagination', async () => {
    const denied = await repository.createKnowledgeBase('reader-tenant', 'Denied')
    await repository.addDocument('reader-tenant', 'first-match.txt', 'text/plain', 'needle', denied.id)
    const selected = await repository.createKnowledgeBase('reader-tenant', 'Selected')
    const first = await repository.addDocument('reader-tenant', 'first.txt', 'text/plain', 'needle abcdefghij', selected.id)
    const second = await repository.addDocument('reader-tenant', 'second.txt', 'text/plain', 'needle second', selected.id)
    const ctx = context([selected.id])
    const found = body(await run('knowledge_search', { query: 'needle', limit: 1 }, ctx))
    expect(found).toHaveLength(1)
    expect([first.id, second.id]).toContain(found[0].documentId)
    const all = body(await run('knowledge_documents', {}, ctx))
    const paged = body(await run('knowledge_documents', { offset: 1, limit: 1 }, ctx))
    expect(paged).toMatchObject({ total: 2, offset: 1, limit: 1, hasMore: false })
    expect(paged.items).toEqual(all.items.slice(1, 2))
    const sliced = body(await run('knowledge_document_get', { id: first.id, offset: 7, limit: 4 }, ctx))
    expect(sliced).toMatchObject({ content: 'abcd', nextOffset: 11, hasMore: true })
    expect(await run('knowledge_search', { query: 'needle', knowledgeBaseIds: [denied.id] }, ctx)).toMatchObject({ success: false })
    expect(await run('knowledge_document_get', { id: first.id, limit: 64001 }, ctx)).toMatchObject({ success: false })
  })

  it('freezes the registration read ceiling even when caller context or the original array expands', async () => {
    const selected = await repository.createKnowledgeBase('reader-tenant', 'Selected')
    const denied = await repository.createKnowledgeBase('reader-tenant', 'Not selected at registration')
    const readable = await repository.addDocument('reader-tenant', 'readable.txt', 'text/plain', 'needle selected', selected.id)
    const hidden = await repository.addDocument('reader-tenant', 'hidden.txt', 'text/plain', 'needle hidden', denied.id)
    const ceiling = [selected.id]
    const scoped = createKnowledgeReadTools(ceiling)
    ceiling.push(denied.id)
    const runScoped = (name: string, raw: unknown) => scoped.find(tool => tool.name === name)!.execute(raw, context([selected.id, denied.id]))
    expect(body(await runScoped('knowledge_list', {})).items.map((item: { id: string }) => item.id)).toEqual([selected.id])
    expect(body(await runScoped('knowledge_documents', {})).items.map((item: { id: string }) => item.id)).toEqual([readable.id])
    expect(body(await runScoped('knowledge_search', { query: 'needle', limit: 1 })).map((item: { documentId: string }) => item.documentId)).toEqual([readable.id])
    expect(await runScoped('knowledge_get', { id: denied.id })).toMatchObject({ success: false })
    expect(await runScoped('knowledge_document_get', { id: hidden.id })).toMatchObject({ success: false })
  })

  it('intersects registration and context scopes at the document level in either direction', async () => {
    const base = await repository.createKnowledgeBase('reader-tenant', 'Document hierarchy')
    const selected = await repository.addDocument('reader-tenant', 'selected.txt', 'text/plain', 'needle selected', base.id)
    const sibling = await repository.addDocument('reader-tenant', 'sibling.txt', 'text/plain', 'needle sibling', base.id)
    for (const [registered, current] of [[[base.id], [selected.id]], [[selected.id], [base.id]]] as const) {
      const scoped = createKnowledgeReadTools(registered)
      const runScoped = (name: string, raw: unknown) => scoped.find(tool => tool.name === name)!.execute(raw, context(current))
      expect(body(await runScoped('knowledge_documents', {})).items.map((item: { id: string }) => item.id)).toEqual([selected.id])
      expect(body(await runScoped('knowledge_search', { query: 'needle' })).map((item: { documentId: string }) => item.documentId)).toEqual([selected.id])
      expect(await runScoped('knowledge_get', { id: base.id })).toMatchObject({ success: false })
      expect(await runScoped('knowledge_document_get', { id: sibling.id })).toMatchObject({ success: false })
    }
  })
})

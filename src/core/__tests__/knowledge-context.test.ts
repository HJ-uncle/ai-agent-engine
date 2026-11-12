import { describe, expect, it, vi } from 'vitest'
import { buildKnowledgeReadContext, knowledgeSearchQuery } from '../knowledge-context.js'

vi.mock('../../storage/knowledge/kb-repo.js', () => ({
  getKnowledgeBase: vi.fn(async (tenant: string, id: string) => tenant === 'owner' && id === 'base' ? { id, name: '笑话集', documentCount: 2 } : null),
  getDocumentMetadata: vi.fn(async (tenant: string, id: string) => tenant === 'owner' && id === 'doc' ? { id, filename: '笑话.txt' } : null),
}))

describe('knowledge reading runtime context', () => {
  it('describes selected bases and documents without presenting them as read content', async () => {
    const context = await buildKnowledgeReadContext('owner', ['base', 'doc', 'missing'], true)
    expect(context).toContain('笑话集')
    expect(context).toContain('"kind":"document","id":"doc","filename":"笑话.txt"')
    expect(context).toContain('knowledge_document_get')
    expect(context).toContain('unavailable-in-current-tenant')
    expect(await buildKnowledgeReadContext('other', ['base'], true)).not.toContain('笑话集')
  })

  it('explains a missing selection without confusing a search miss with an empty library', async () => {
    const context = await buildKnowledgeReadContext('owner', [], false)
    expect(context).toContain('没有显式选择')
    expect(context).toContain('不能据此断言知识库为空')
    const management = await buildKnowledgeReadContext('owner', null, true)
    expect(management).toContain('先使用 knowledge_list')
    expect(management).not.toContain('请用户重新选择')
    expect(await buildKnowledgeReadContext('owner', [], true)).toContain('没有显式选择')
  })

  it('excludes reference identifiers and metadata from automatic retrieval terms', () => {
    const input = '/kb:abc-123 /toolkit:knowledge-management 再看看\n<!--aether-refs:[{"t":"kb","p":"abc-123","d":"笑话集"}]-->'
    expect(knowledgeSearchQuery(input)).toBe('再看看')
    expect(knowledgeSearchQuery('正文知识')).toBe('正文知识')
  })
})

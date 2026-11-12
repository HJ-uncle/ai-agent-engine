import type { Client } from '@libsql/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as database from '../../sqlite/db.js'
import { createKnowledgeBase, addDocument, getDocument, getDocumentMetadata, listKnowledgeBases, searchChunks, updateDocument, deleteKnowledgeBase, splitIntoChunks } from '../kb-repo.js'
import { knowledgeFixture } from './fixture.js'

let db: Client
let fixture: ReturnType<typeof knowledgeFixture>
beforeEach(() => { fixture = knowledgeFixture(); db = fixture.db; vi.spyOn(database, 'getDb').mockReturnValue(db) })
afterEach(async () => { await fixture.close(); vi.restoreAllMocks() })

it('creates tenant-scoped bases and atomically indexes editable documents', async () => {
  const base = await createKnowledgeBase('tenant-a', '产品资料', '说明')
  const doc = await addDocument('tenant-a', 'guide.txt', 'text/plain', '这是一个中文检索片段。', base.id)
  expect((await listKnowledgeBases('tenant-b'))).toEqual([])
  expect((await getDocument('tenant-a', doc.id))?.content).toContain('中文检索')
  expect((await searchChunks('tenant-a', '中文检索', 5, [base.id]))[0]?.documentId).toBe(doc.id)
  const edited = await updateDocument('tenant-a', doc.id, { content: '新的正文', filename: 'new.txt' })
  expect(edited?.filename).toBe('new.txt')
  expect(await searchChunks('tenant-a', '中文检索', 5, [base.id])).toEqual([])
  expect((await searchChunks('tenant-a', '新的正文', 5, [base.id]))[0]?.documentId).toBe(edited?.id)
})

it('deleting a base removes its documents and search index without crossing tenants', async () => {
  const a = await createKnowledgeBase('tenant-a', 'A')
  const b = await createKnowledgeBase('tenant-b', 'B')
  await addDocument('tenant-a', 'a.txt', 'text/plain', 'private needle', a.id)
  await addDocument('tenant-b', 'b.txt', 'text/plain', 'private needle', b.id)
  expect(await deleteKnowledgeBase('tenant-a', a.id)).toBe(true)
  expect(await searchChunks('tenant-a', 'needle')).toEqual([])
  expect((await searchChunks('tenant-b', 'needle')).length).toBe(1)
})

it('reads tenant-scoped catalogue metadata without materializing stored or legacy document content', async () => {
  const base = await createKnowledgeBase('tenant-a', 'catalogue')
  const doc = await addDocument('tenant-a', 'large.txt', 'text/plain', 'private body '.repeat(1000), base.id)
  expect(await getDocumentMetadata('tenant-a', doc.id)).toEqual(expect.objectContaining({ id: doc.id, filename: 'large.txt', knowledgeBaseId: base.id, contentExact: true }))
  expect(await getDocumentMetadata('tenant-a', doc.id)).not.toHaveProperty('content')
  expect(await getDocumentMetadata('tenant-b', doc.id)).toBeNull()
  await db.execute({ sql: 'UPDATE documents SET content=NULL WHERE id=?', args: [doc.id] })
  expect(await getDocumentMetadata('tenant-a', doc.id)).toEqual(expect.objectContaining({ id: doc.id, contentExact: false }))
  expect(await getDocumentMetadata('tenant-a', doc.id)).not.toHaveProperty('content')
})

it('bounds CJK and zero-overlap chunking without dropping a preceding short word', () => {
  const chunks = splitIntoChunks('prefix ' + '中文'.repeat(800), 50, 0)
  expect(chunks.join('')).toContain('prefix')
  expect(chunks.every(chunk => Array.from(chunk).length <= 50)).toBe(true)
  expect(splitIntoChunks('a b c', 2, 0)).toEqual(['a b', 'c'])
})

it('rolls back an edited document when a later index insert fails', async () => {
  const base = await createKnowledgeBase('tenant-a', 'rollback')
  const doc = await addDocument('tenant-a', 'old.txt', 'text/plain', 'old needle', base.id)
  await db.execute("CREATE TRIGGER fail_kb_insert BEFORE INSERT ON document_chunks WHEN NEW.content='new needle' BEGIN SELECT RAISE(ABORT, 'forced index failure'); END")
  await expect(updateDocument('tenant-a', doc.id, { content: 'new needle' })).rejects.toThrow('forced index failure')
  expect((await getDocument('tenant-a', doc.id))?.content).toBe('old needle')
  expect((await searchChunks('tenant-a', 'old needle', 5, [base.id]))[0]?.documentId).toBe(doc.id)
})


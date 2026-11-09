import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as database from '../../sqlite/db.js'
import { up } from '../../sqlite/migrations/001_initial.js'
import { addDocument, searchChunks } from '../kb-repo.js'

let db: Client
beforeEach(async () => { db = createClient({ url: 'file::memory:' }); vi.spyOn(database, 'getDb').mockReturnValue(db); await up(db) })
afterEach(() => { db.close(); vi.restoreAllMocks() })

it.each(['needle', '关键约束'])('filters document bindings inside retrieval before the limit for %s', async term => {
  for (let index = 0; index < 7; index++) await addDocument('tenant', `unbound-${index}.txt`, 'text/plain', term)
  const bound = await addDocument('tenant', 'bound.txt', 'text/plain', term)
  const other = await addDocument('other', 'other.txt', 'text/plain', term)
  const scoped = await searchChunks('tenant', term, 1, [bound.id, other.id])
  expect(scoped).toHaveLength(1)
  expect(scoped[0].documentId).toBe(bound.id)
  expect(scoped[0].filename).toBe('bound.txt')
  expect(await searchChunks('tenant', term, 5, [])).toEqual([])
  expect(await searchChunks('tenant', term, 5, ['missing', other.id])).toEqual([])
  expect((await searchChunks('tenant', term, 5)).length).toBe(5)
})

it('searches every term of long multilingual input without a SQL expression-depth failure', async () => {
  const terms = Array.from({ length: 2000 }, (_, index) => `资料段${String(index).padStart(4, '0')}：唯一记录`)
  const first = await addDocument('tenant', 'first.txt', 'text/plain', terms[0])
  const middle = await addDocument('tenant', 'middle.txt', 'text/plain', terms[1000])
  const last = await addDocument('tenant', 'last.txt', 'text/plain', terms[1999])
  await addDocument('other', 'foreign.txt', 'text/plain', terms[1999])
  await addDocument('tenant', 'unbound.txt', 'text/plain', terms[1999])
  const scopes = [first.id, middle.id, last.id]

  expect(new Set((await searchChunks('tenant', terms.join('\n'), 5, scopes)).map(row => row.documentId)))
    .toEqual(new Set(scopes))
  expect((await searchChunks('tenant', terms.join('\n'), 1, [last.id])).map(row => row.documentId)).toEqual([last.id])
  expect(await searchChunks('empty-tenant', terms.join('\n'))).toEqual([])
})

it('keeps the long ASCII fallback and escaped LIKE characters as literal search data', async () => {
  const absent = Array.from({ length: 2000 }, (_, index) => `missing${String(index).padStart(4, '0')}`).join(' ')
  expect(await searchChunks('tenant', absent)).toEqual([])
  const literal = await addDocument('tenant', 'literal.txt', 'text/plain', '资料路径 C:\\资料\\a_100%')
  await addDocument('tenant', 'wildcard.txt', 'text/plain', '资料路径 C:\\资料\\ab1000')
  const query = `C:\\资料\\a_100% ${absent}`

  expect((await searchChunks('tenant', query)).map(row => row.documentId)).toEqual([literal.id])
  expect(await searchChunks('tenant', "资料')OR(1=1)--")).toEqual([])
})

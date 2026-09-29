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

import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { paginateArray } from '../response.js'

describe('query-string pagination', () => {
  it('returns exact disjoint pages through a real HTTP query parser', async () => {
    const app = Fastify()
    const rows = Array.from({ length: 1158 }, (_, index) => ({ id: `message-${index}` }))
    app.get<{ Querystring: { current: string; pageSize: string } }>('/archive', request =>
      paginateArray(rows, request.query.current, request.query.pageSize))
    try {
      const recovered: string[] = []
      for (let page = 1; page <= 6; page++) {
        const response = await app.inject(`/archive?current=${page}&pageSize=200`)
        const body = response.json()
        expect(body.code).toBe(200)
        expect(body.pagination).toEqual({ current: page, pageSize: 200, total: 1158, totalPages: 6 })
        expect(body.data).toEqual(rows.slice((page - 1) * 200, page * 200))
        recovered.push(...body.data.map((row: { id: string }) => row.id))
      }
      expect(recovered).toEqual(rows.map(row => row.id))
      expect(new Set(recovered).size).toBe(rows.length)
      expect((await app.inject('/archive?current=7&pageSize=200')).json().data).toEqual([])
    } finally {
      await app.close()
    }
  })

  it('keeps numeric callers, empty collections and unpaginated reads compatible', () => {
    expect(paginateArray([1, 2, 3, 4, 5], 2, 2).data).toEqual([3, 4])
    expect(paginateArray([], '1', '200').pagination).toEqual({ current: 1, pageSize: 200, total: 0, totalPages: 0 })
    expect(paginateArray([1, 2]).data).toEqual([1, 2])
    expect(paginateArray([1, 2]).pagination).toBeUndefined()
  })

  it('rejects invalid or overflowing pages without reporting a successful slice', () => {
    for (const [page, size] of [['0', '2'], ['-1', '2'], ['1.5', '2'], ['NaN', '2'], ['1', ''], ['1', 'Infinity'], ['1', '0'], ['1', '-2'], [Number.MAX_SAFE_INTEGER, 2]] as const) {
      const response = paginateArray([1, 2, 3], page, size)
      expect(response.code).toBe(40001)
      expect(response.data).toBeNull()
      expect(response.pagination).toBeUndefined()
    }
  })
})

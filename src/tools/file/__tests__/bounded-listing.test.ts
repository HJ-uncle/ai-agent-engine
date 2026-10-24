import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createListingBudget, listDirectoryEntries } from '../bounded-listing.js'

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-bounded-list-')) })
afterEach(() => {
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('aether-bounded-list-')) throw new Error('Unsafe cleanup')
  fs.rmSync(root, { recursive: true, force: true })
})
describe('bounded asynchronous file listing', () => {
  it('stops before materializing a wide tree and yields to the event loop', async () => {
    for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(root, `f-${i}.txt`), '')
    let heartbeat = false
    setImmediate(() => { heartbeat = true })
    const budget = createListingBudget(20)
    const entries = await listDirectoryEntries(root, true, budget)
    expect(heartbeat).toBe(true)
    expect(entries).toHaveLength(20)
    expect(budget).toMatchObject({ count: 20, truncated: true, reason: 'results' })
  })
  it('shares a single result budget across multiple roots', async () => {
    const a = path.join(root, 'a'), b = path.join(root, 'b')
    fs.mkdirSync(a); fs.mkdirSync(b)
    for (const directory of [a, b]) for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(directory, `f${i}`), '')
    const budget = createListingBudget(8)
    const first = await listDirectoryEntries(a, false, budget)
    const second = await listDirectoryEntries(b, false, budget)
    expect(first.length + second.length).toBe(8)
    expect(budget.truncated).toBe(true)
  })
  it('honors cancellation before and during traversal', async () => {
    const early = new AbortController(); early.abort(new Error('cancel-list'))
    await expect(listDirectoryEntries(root, true, createListingBudget(), early.signal)).rejects.toThrow('cancel-list')
    for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(root, `f${i}`), '')
    const during = new AbortController()
    setImmediate(() => during.abort(new Error('cancel-during-list')))
    await expect(listDirectoryEntries(root, true, createListingBudget(), during.signal)).rejects.toThrow('cancel-during-list')
  })
  it('does not follow a directory junction cycle', async () => {
    fs.writeFileSync(path.join(root, 'leaf.txt'), '')
    fs.symlinkSync(root, path.join(root, 'loop'), process.platform === 'win32' ? 'junction' : 'dir')
    const budget = createListingBudget()
    expect((await listDirectoryEntries(root, true, budget)).sort()).toEqual(['leaf.txt', 'loop@'])
    expect(budget.truncated).toBe(false)
  })
  it('bounds nesting and validates caller result limits', async () => {
    let directory = root
    for (let i = 0; i < 70; i++) { directory = path.join(directory, 'd'); fs.mkdirSync(directory) }
    const budget = createListingBudget()
    await listDirectoryEntries(root, true, budget)
    expect(budget).toMatchObject({ truncated: true, reason: 'depth', count: 65 })
    for (const limit of [0, -1, 1.5, Infinity, 2001]) expect(() => createListingBudget(limit)).toThrow('maxResults')
  })
})

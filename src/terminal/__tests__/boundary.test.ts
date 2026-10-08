import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

const fake = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() }
vi.mock('node-pty', () => ({ spawn: vi.fn(() => fake) }))
const { terminalManager } = await import('../index.js')

describe('terminal resource boundary', () => {
  beforeEach(() => { fake.write.mockClear(); fake.resize.mockClear(); terminalManager.killAll() })
  it('fails closed for a missing cwd and bounds input/resize', () => {
    expect(() => terminalManager.create('t1', 'Z:/path-that-does-not-exist', 120, 30, [], { tenantId: 'a' })).toThrow('does not exist')
    const cwd = process.cwd()
    const session = terminalManager.create('t2', cwd, 120, 30, [cwd], { tenantId: 'a', userId: 'u' })
    expect(session.tenantId).toBe('a')
    expect(terminalManager.write('t2', 'ok')).toBe(true)
    expect(terminalManager.write('t2', 'x'.repeat(64 * 1024 + 1))).toBe(false)
    expect(terminalManager.resize('t2', 0, 30)).toBe(false)
    expect(terminalManager.resize('t2', 120, 30)).toBe(true)
  })
})

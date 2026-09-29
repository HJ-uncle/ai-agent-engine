import path from 'node:path'
import { isCommandAllowed, resetWhitelist } from '../cmd-whitelist.js'
import { WorkspaceManager } from '../../workspace/manager.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(tenantId = 'tenant-test', sessionId = 'session-test') {
  return { tenantId, sessionId }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('isCommandAllowed (cmd-whitelist)', () => {
  beforeEach(() => {
    resetWhitelist()
  })

  it('allows "ls" (whitelisted command)', () => {
    expect(isCommandAllowed('ls')).toBe(true)
  })

  it('blocks "rm" (not in whitelist)', () => {
    expect(isCommandAllowed('rm')).toBe(false)
  })

  it('allows "cat" (whitelisted command)', () => {
    expect(isCommandAllowed('cat')).toBe(true)
  })
})

describe('WorkspaceManager.resolveSafePath', () => {
  let manager: WorkspaceManager
  const ctx = makeCtx()

  beforeEach(() => {
    // Use a fixed temp-like root so paths are deterministic
    manager = new WorkspaceManager(path.join(process.cwd(), '.test-workspace'))
  })

  it('resolves a normal relative path inside the workspace', () => {
    const result = manager.resolveSafePath(ctx, 'file.txt')
    const expected = path.join(
      process.cwd(),
      '.test-workspace',
      ctx.tenantId,
      ctx.sessionId,
      'file.txt',
    )
    expect(result).toBe(expected)
  })

  it('throws on path traversal "../../etc/passwd"', () => {
    expect(() => manager.resolveSafePath(ctx, '../../etc/passwd')).toThrow(
      /outside any bound workspace|Path traversal detected/,
    )
  })

  it('resolves a deep nested relative path', () => {
    const result = manager.resolveSafePath(ctx, 'a/b/c.txt')
    const expected = path.join(
      process.cwd(),
      '.test-workspace',
      ctx.tenantId,
      ctx.sessionId,
      'a',
      'b',
      'c.txt',
    )
    expect(result).toBe(expected)
  })

  it('throws on absolute path attack "/etc/passwd"', () => {
    expect(() => manager.resolveSafePath(ctx, '/etc/passwd')).toThrow(
      /outside any bound workspace|Path traversal detected/,
    )
  })
})

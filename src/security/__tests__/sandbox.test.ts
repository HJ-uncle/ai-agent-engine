import path from 'node:path'
import { isCommandAllowed, resetWhitelist } from '../cmd-whitelist.js'
import { WorkspaceManager } from '../../workspace/manager.js'
import { clearSecurityMode, setSecurityMode } from '../policy-engine.js'

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

describe('WorkspaceManager.resolveSafePath in safe mode', () => {
  let manager: WorkspaceManager
  const ctx = makeCtx()

  beforeEach(() => {
    // These assertions describe safe mode, independently of the product default.
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
    // Use a fixed temp-like root so paths are deterministic
    manager = new WorkspaceManager(path.join(process.cwd(), '.test-workspace'))
  })

  afterEach(() => { clearSecurityMode(ctx.tenantId, ctx.sessionId) })

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

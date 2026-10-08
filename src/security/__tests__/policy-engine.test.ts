import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { initDb, closeDb } from '../../storage/sqlite/db.js'
import { detectInjection, detectPathTraversal, policyEngine, approveCommand, setSecurityMode } from '../policy-engine.js'
import { isPrivateIP, parseCidr } from '../network-policy.js'
import { createPool } from '../../core/utils/concurrency-pool.js'

// The runner supplies a per-spec DB before imports; never reset the operator's policy table.
beforeAll(async () => { await initDb() })
afterAll(() => { closeDb() })

describe('policy-engine injection detection', () => {
  it('detects shell metacharacters', () => {
    expect(detectInjection(['hello'])).toHaveLength(0)
    expect(detectInjection(['a', 'b; rm -rf /'])).toContain('b; rm -rf /')
    expect(detectInjection(['--help', '$(whoami)'])).toContain('$(whoami)')
    expect(detectInjection(['abc', '`id`'])).toContain('`id`')
    expect(detectInjection(['foo', 'bar | cat'])).toContain('bar | cat')
    expect(detectInjection(['line1\nline2'])).toContain('line1\nline2')
  })

  it('detects path traversal', () => {
    expect(detectPathTraversal(['../../etc/passwd'])).toContain('../../etc/passwd')
    expect(detectPathTraversal(['/etc/shadow'])).toContain('/etc/shadow')
    expect(detectPathTraversal(['normal/path'])).toHaveLength(0)
  })
})

describe('policy-engine evaluation and approval', () => {
  beforeEach(async () => {
    await policyEngine.resetDefaults()
  })

  it('hard-blocks delete commands in every mode and redirects to delete_file', async () => {
    const tenantId = 'test-tenant'
    const sessionId = 'test-session'
    setSecurityMode(tenantId, sessionId, 'safe')

    // 纯命令名拦截：不触发注入检测，safe 下也必须直接 deny（而非 ask）
    for (const [command, args] of [
      ['rm', ['foo']],
      ['del', ['foo.txt']],
      ['erase', ['foo.txt']],
      ['rmdir', ['foo']],
      ['unlink', ['foo.txt']],
      ['C:\\tools\\bin\\rm.exe', ['foo']],
    ] as const) {
      const decision = await policyEngine.evaluate({ command, args: [...args], tenantId, sessionId })
      expect(decision.action).toBe('deny')
      expect(decision.reason).toContain('delete_file')
    }

    // 注入敏感的删除形式（; 等元字符会在 safe 下先被注入检测拦截，ask/deny 均不执行）：
    // 在 full-access 下注入检测跳过，删除硬拦截必须兜住
    setSecurityMode(tenantId, sessionId, 'full-access')
    for (const [command, args] of [
      ['git', ['clean', '-fd']],
      ['node', ['-e', "require('fs').rmSync('a', { recursive: true })"]],
      ['python', ['-c', 'import shutil; shutil.rmtree("a")']],
      ['Remove-Item', ['-Recurse', 'foo']],
    ] as const) {
      const decision = await policyEngine.evaluate({ command, args: [...args], tenantId, sessionId })
      expect(decision.action).toBe('deny')
      expect(decision.reason).toContain('delete_file')
    }
    setSecurityMode(tenantId, sessionId, 'safe')
  })

  it('delete commands stay blocked even after user approval and in full-access mode', async () => {
    const tenantId = 'test-tenant'
    const sessionId = 'test-session'
    approveCommand(tenantId, sessionId, 'rm', ['-rf', 'foo'])
    let decision = await policyEngine.evaluate({ command: 'rm', args: ['-rf', 'foo'], tenantId, sessionId, approved: true })
    expect(decision.action).toBe('deny')

    setSecurityMode(tenantId, sessionId, 'full-access')
    decision = await policyEngine.evaluate({ command: 'rm', args: ['-rf', 'foo'], tenantId, sessionId })
    expect(decision.action).toBe('deny')
    setSecurityMode(tenantId, sessionId, 'safe')
  })

  it('allows approved non-delete commands even if they are high risk', async () => {
    const tenantId = 'test-tenant'
    const sessionId = 'test-session'
    setSecurityMode(tenantId, sessionId, 'safe')

    let decision = await policyEngine.evaluate({
      command: 'taskkill',
      args: ['/PID', '1234', '/F'],
      tenantId,
      sessionId
    })
    expect(decision.action).toBe('ask')

    approveCommand(tenantId, sessionId, 'taskkill', ['/PID', '1234', '/F'])

    decision = await policyEngine.evaluate({
      command: 'taskkill',
      args: ['/PID', '1234', '/F'],
      tenantId,
      sessionId
    })
    expect(decision.action).toBe('allow')
    expect(decision.reason).toContain('审批通过')
  })
})

describe('network-policy IP checks', () => {
  it('identifies private IPv4', () => {
    expect(isPrivateIP('127.0.0.1')).toBe(true)
    expect(isPrivateIP('10.1.2.3')).toBe(true)
    expect(isPrivateIP('192.168.0.5')).toBe(true)
    expect(isPrivateIP('172.20.5.1')).toBe(true)
    expect(isPrivateIP('169.254.169.254')).toBe(true) // cloud metadata
    expect(isPrivateIP('8.8.8.8')).toBe(false)
    expect(isPrivateIP('1.1.1.1')).toBe(false)
  })

  it('identifies private IPv6', () => {
    expect(isPrivateIP('::1')).toBe(true)
    expect(isPrivateIP('fe80::1')).toBe(true)
    expect(isPrivateIP('fc00::1')).toBe(true)
    expect(isPrivateIP('2001:4860:4860::8888')).toBe(false)
  })

  it('parses CIDR', () => {
    expect(parseCidr('10.0.0.0/8')).not.toBeNull()
    expect(parseCidr('invalid')).toBeNull()
    expect(parseCidr('10.0.0.0/33')).toBeNull()
  })
})

describe('concurrency pool', () => {
  it('respects concurrency limit', async () => {
    const pool = createPool(2)
    let active = 0
    let peak = 0
    const job = async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 20))
      active--
      return 'ok'
    }
    const results = await Promise.all(
      Array.from({ length: 10 }, () => pool(job)),
    )
    expect(results).toHaveLength(10)
    expect(results.every((r) => r === 'ok')).toBe(true)
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('resize increases concurrency immediately', async () => {
    const pool = createPool(1)
    pool.resize(5)
    expect(pool.size).toBe(5)
  })
})

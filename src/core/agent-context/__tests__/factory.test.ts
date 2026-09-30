import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createAgentContext } from '../factory.js'
import { __resetOSMWarnFlagsForTests } from '../../osm.js'

/**
 * Agent-context factory 测试
 *
 * 关注点：
 *   1. methodology / max 模式 → 创建 docs/superpower/{specs,plans,reviews}/
 *   2. off / balanced 模式     → 不创建
 *   3. mkdir 失败不抛错，只 warn
 *   4. 预算保持 Layer-1 bugfix：options.tokenBudget 显式传入时不被倍率放大
 */

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k]
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k] as string
  }
  try {
    fn()
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k] as string
    }
  }
}

let tmpRoot: string
const deps = () => ({
  sessionId: 'sess-' + Math.random().toString(36).slice(2, 10),
  tools: {} as any,
  memory: {} as any,
  history: {} as any,
  logger: {
    child: () => deps().logger,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  } as any,
})

beforeEach(() => {
  __resetOSMWarnFlagsForTests()
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ctx-test-'))
  process.env.WORKSPACE_ROOT = tmpRoot
})

afterEach(() => {
  delete process.env.WORKSPACE_ROOT
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
})

describe('createAgentContext / artifact directories', () => {
  it('methodology 模式 → 创建 .openspec/changes 目录', () => {
    withEnv({ SUPERPOWER_MODE: 'methodology', SUPERPOWER_ENABLED: undefined }, () => {
      const d = deps()
      const ctx = createAgentContext(d)
      const p = path.join(ctx.workspaceDir, '.openspec', 'changes')
      expect(fs.existsSync(p)).toBe(true)
      expect(fs.statSync(p).isDirectory()).toBe(true)
    })
  })

  it('max 模式 → 同样创建目录', () => {
    withEnv({ SUPERPOWER_MODE: 'max', SUPERPOWER_ENABLED: undefined }, () => {
      const d = deps()
      const ctx = createAgentContext(d)
      expect(fs.existsSync(path.join(ctx.workspaceDir, '.openspec', 'changes'))).toBe(true)
    })
  })

  it('balanced 模式 → 不创建 .openspec/changes', () => {
    withEnv({ SUPERPOWER_MODE: 'balanced', SUPERPOWER_ENABLED: undefined }, () => {
      const d = deps()
      const ctx = createAgentContext(d)
      expect(fs.existsSync(path.join(ctx.workspaceDir, '.openspec', 'changes'))).toBe(false)
    })
  })

  it('off 模式 → 不创建 .openspec/changes', () => {
    withEnv({ SUPERPOWER_MODE: 'off', SUPERPOWER_ENABLED: undefined }, () => {
      const d = deps()
      const ctx = createAgentContext(d)
      expect(fs.existsSync(path.join(ctx.workspaceDir, '.openspec', 'changes'))).toBe(false)
    })
  })

  it('已存在的子目录保留 + 不抛错', () => {
    withEnv({ SUPERPOWER_MODE: 'methodology', SUPERPOWER_ENABLED: undefined }, () => {
      const d = deps()
      // 预先创建并写入哨兵文件
      const pre = path.join(tmpRoot, 'default', d.sessionId, '.openspec', 'changes')
      fs.mkdirSync(pre, { recursive: true })
      const sentinel = path.join(pre, 'keep-me.md')
      fs.writeFileSync(sentinel, 'preserved')

      expect(() => createAgentContext(d)).not.toThrow()
      expect(fs.existsSync(sentinel)).toBe(true)
      expect(fs.readFileSync(sentinel, 'utf-8')).toBe('preserved')
    })
  })
})

describe('createAgentContext / tokenBudget', () => {
  it('options.tokenBudget 显式传入时不被倍率放大（子代理预算保真）', () => {
    withEnv({ SUPERPOWER_MODE: 'max', SUPERPOWER_ENABLED: undefined }, () => {
      const d = { ...deps(), tokenBudget: 30000 }
      const ctx = createAgentContext(d)
      expect(ctx.tokenBudget).toBe(30000)
    })
  })

  it('未传入时 → 读 env 默认并按模式倍率放大', () => {
    withEnv({ SUPERPOWER_MODE: 'max', SUPERPOWER_ENABLED: undefined, TOKEN_BUDGET: '60000' }, () => {
      const ctx = createAgentContext(deps())
      expect(ctx.tokenBudget).toBe(300000)  // 60000 × 5
    })
  })

  it('off 模式未传入时 → 直接使用 env 默认值', () => {
    withEnv({ SUPERPOWER_MODE: 'off', SUPERPOWER_ENABLED: undefined, TOKEN_BUDGET: '60000' }, () => {
      const ctx = createAgentContext(deps())
      expect(ctx.tokenBudget).toBe(60000)
    })
  })

  it('env 与调用方都未给预算 → 不设置本地上限（undefined，交给模型窗口/服务端）', () => {
    withEnv({ SUPERPOWER_MODE: 'balanced', SUPERPOWER_ENABLED: undefined, TOKEN_BUDGET: undefined }, () => {
      const ctx = createAgentContext(deps())
      expect(ctx.tokenBudget).toBeUndefined()
    })
  })
})

// Verifies code context never opens general memory storage while preserving tools and local conversation history.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/types.js'
import { getCurrentContextTool } from '../get-context-tool.js'

const memory = vi.hoisted(() => ({
  imported: vi.fn(), constructed: vi.fn(),
  list: vi.fn().mockResolvedValue([{ type: 'fact', summary: 'GENERAL_MEMORY_FIXTURE' }]),
}))
vi.mock('../../../storage/memory/memory-manager.js', () => {
  memory.imported()
  return { SQLiteMemoryManager: class {
    constructor() { memory.constructed() }
    listNodes(...args: unknown[]) { return memory.list(...args) }
  } }
})

beforeEach(() => { vi.clearAllMocks() })

describe('get_current_context runtime capabilities', () => {
  it('reports the engine runtime without promising external commands or browser support', async () => {
    const result = await getCurrentContextTool.execute({ includeTools: false }, context('code'))
    expect(result.success).toBe(true)
    expect(result.output).toContain(`${process.platform} / ${process.arch}`)
    expect(result.output).toContain(process.version)
    expect(result.output).toContain('PATH 中的程序需通过命令结果确认')
    expect(result.output).toContain('本次未注册 browser_tabs')
    expect(result.output).not.toContain('已注册工具 (')
    expect(result.output).not.toContain('"command":"node"')
  })

  it('derives tool guidance from the current registry even with the table hidden', async () => {
    const ctx = context('code')
    ctx.tools.list = () => [
      { name: 'execute_cmd', description: 'Run command', parameters: { type: 'object' } },
      { name: 'browser_tabs', description: 'Read client tabs', parameters: { type: 'object' } },
      { name: 'code_diagnose', description: 'PROJECT_DIAGNOSTIC_CAPABILITIES', parameters: { type: 'object' } },
    ] as ReturnType<AgentContext['tools']['list']>
    const result = await getCurrentContextTool.execute({ includeTools: false }, ctx)
    expect(result.output).toContain('"command":"node","args":["--version"]')
    expect(result.output).toContain('注册不代表浏览器已连接')
    expect(result.output).toContain('PROJECT_DIAGNOSTIC_CAPABILITIES')
    expect(result.output).not.toContain('本次未注册 browser_tabs')
    expect(result.output).not.toContain('已注册工具 (')
    expect(memory.list).not.toHaveBeenCalled()
  })
})

function context(toolProfile?: 'code' | 'general'): AgentContext {
  return {
    toolProfile, tenantId: 'context-tenant', sessionId: 'context-session',
    workspaceDir: process.cwd(), projectRoot: process.cwd(), cwd: process.cwd(), tokenBudget: 100_000,
    tools: { list: () => [{ name: 'read_file', description: 'Read project files', parameters: { type: 'object' } }] },
    history: { getHistory: vi.fn().mockResolvedValue([{ role: 'user', content: 'LOCAL_PROJECT_HISTORY' }]) },
    logger: { info: vi.fn(), error: vi.fn() },
  } as unknown as AgentContext
}

describe('get_current_context memory isolation', () => {
  it('code neither imports nor constructs the memory manager and preserves local context', async () => {
    const ctx = context('code')
    const result = await getCurrentContextTool.execute({ includeTools: true, includeHistory: true }, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('read_file')
    expect(result.output).toContain('LOCAL_PROJECT_HISTORY')
    expect(result.output).toContain(process.cwd())
    expect(result.output).not.toContain('GENERAL_MEMORY_FIXTURE')
    expect(result.output).not.toContain('记忆信息')
    expect(memory.imported).not.toHaveBeenCalled()
    expect(memory.constructed).not.toHaveBeenCalled()
    expect(memory.list).not.toHaveBeenCalled()
  })

  it.each(['general', undefined] as const)('%s retains existing memory context behavior', async (toolProfile) => {
    const result = await getCurrentContextTool.execute({}, context(toolProfile))
    expect(result.success).toBe(true)
    expect(result.output).toContain('GENERAL_MEMORY_FIXTURE')
    expect(memory.constructed).toHaveBeenCalledTimes(1)
    expect(memory.list).toHaveBeenCalledWith({ limit: 5, orderBy: 'timestamp', orderDir: 'DESC' }, { tenantId: 'context-tenant', sessionId: 'context-session' })
  })

  it('session memory follows the executing subagent session, not rootSessionId', async () => {
    const ctx = {
      ...context('general'),
      rootSessionId: 'parent-session',
      sessionId: 'child-session',
      memoryScope: 'session',
    } as AgentContext

    const result = await getCurrentContextTool.execute({}, ctx)

    expect(result.success).toBe(true)
    expect(memory.list).toHaveBeenCalledWith(
      { limit: 5, orderBy: 'timestamp', orderDir: 'DESC' },
      { tenantId: 'context-tenant', sessionId: 'child-session', scope: 'session' },
    )
  })
})

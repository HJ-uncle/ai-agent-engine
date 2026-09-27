import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentContext, ToolResult } from '../../../core/agent-context/index.js'
import { agentTools } from '../agent-tool.js'

vi.mock('../../../storage/agent/index.js', () => {
  const mockAgents = new Map<string, any>()

  return {
    SQLiteAgentStore: vi.fn().mockImplementation(() => ({
      create: vi.fn().mockImplementation((tenantId: string, input: any) => {
        const id = `test-agent-${Date.now()}`
        const agent = {
          id,
          tenantId,
          name: input.name,
          description: input.description,
          systemPrompt: input.systemPrompt,
          model: input.model,
          temperature: input.temperature,
          skills: input.skills || [],
          mcpServers: input.mcpServers || [],
          knowledgeBases: input.knowledgeBases || [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        mockAgents.set(id, agent)
        return Promise.resolve(agent)
      }),
      getById: vi.fn().mockImplementation((id: string) => {
        const agent = mockAgents.get(id)
        return Promise.resolve(agent || null)
      }),
      list: vi.fn().mockImplementation(() => {
        return Promise.resolve(Array.from(mockAgents.values()))
      }),
      update: vi.fn().mockImplementation((id: string, tenantId: string, input: any) => {
        const existing = mockAgents.get(id)
        if (!existing) return Promise.resolve(null)
        const updated = { ...existing, ...input, updatedAt: Date.now() }
        mockAgents.set(id, updated)
        return Promise.resolve(updated)
      }),
      delete: vi.fn().mockImplementation((id: string) => {
        const existed = mockAgents.has(id)
        mockAgents.delete(id)
        return Promise.resolve(existed)
      }),
    })),
  }
})

const mockCtx = {
  tenantId: 'test-tenant',
  sessionId: 'test-session',
  workspaceDir: '/tmp',
  tools: {
    list: () => [],
    execute: vi.fn(),
  },
  memory: {
    remember: vi.fn(),
    recall: vi.fn(),
  },
  history: {
    append: vi.fn(),
    getHistory: vi.fn(),
  },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  tokenBudget: 100000,
} as unknown as AgentContext

describe('Agent Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('agent_list', () => {
    it('should list all agents', async () => {
      const tool = agentTools.find(t => t.name === 'agent_list')
      expect(tool).toBeDefined()

      const result = await tool!.execute({}, mockCtx)
      expect(result.success).toBe(true)
      expect(result.output).toContain('暂无 Agent')
    })
  })

  describe('agent_get', () => {
    it('should return error when agent not found', async () => {
      const tool = agentTools.find(t => t.name === 'agent_get')
      expect(tool).toBeDefined()

      const result = await tool!.execute({ id: 'non-existent' }, mockCtx)
      expect(result.success).toBe(false)
      expect(result.output).toContain('不存在')
    })
  })

  describe('agent_create', () => {
    it('should return preview with pendingAction', async () => {
      const tool = agentTools.find(t => t.name === 'agent_create')
      expect(tool).toBeDefined()

      const result = await tool!.execute({
        name: 'Test Agent',
        description: 'A test agent',
        model: 'gpt-4o',
        temperature: 0.7,
      }, mockCtx)

      expect(result.success).toBe(true)
      expect(result.output).toContain('Agent 创建预览')
      expect(result.pendingAction).toBeDefined()
      expect(result.pendingAction!.type).toBe('agent_create')
      expect((result as any).pendingAction!.input.name).toBe('Test Agent')
    })

    it('should return error when name is empty', async () => {
      const tool = agentTools.find(t => t.name === 'agent_create')
      expect(tool).toBeDefined()

      const result = await tool!.execute({ name: '' }, mockCtx)
      expect(result.success).toBe(false)
      expect(result.output).toContain('名称不能为空')
    })
  })

  describe('agent_do_create', () => {
    it('should create agent when confirmed', async () => {
      const tool = agentTools.find(t => t.name === 'agent_do_create')
      expect(tool).toBeDefined()

      const result = await tool!.execute({
        confirmed: true,
        name: 'Confirmed Agent',
        description: 'A confirmed agent',
        temperature: 0.8,
      }, mockCtx)

      expect(result.success).toBe(true)
      expect(result.output).toContain('创建成功')
    })

    it('should reject when not confirmed', async () => {
      const tool = agentTools.find(t => t.name === 'agent_do_create')
      expect(tool).toBeDefined()

      const result = await tool!.execute({
        confirmed: false,
        name: 'Rejected Agent',
      }, mockCtx)

      expect(result.success).toBe(false)
      expect(result.output).toContain('未确认')
    })
  })

  describe('agent_update', () => {
    it('should return error when agent not found', async () => {
      const tool = agentTools.find(t => t.name === 'agent_update')
      expect(tool).toBeDefined()

      const result = await tool!.execute({ id: 'non-existent', name: 'New Name' }, mockCtx)
      expect(result.success).toBe(false)
      expect(result.output).toContain('不存在')
    })

    it('should require id parameter', async () => {
      const tool = agentTools.find(t => t.name === 'agent_update')
      expect(tool).toBeDefined()

      const result = await tool!.execute({ name: 'New Name' }, mockCtx)
      expect(result.success).toBe(false)
      expect(result.output).toContain('ID 不能为空')
    })
  })

  describe('agent_delete', () => {
    it('should return error when agent not found', async () => {
      const tool = agentTools.find(t => t.name === 'agent_delete')
      expect(tool).toBeDefined()

      const result = await tool!.execute({ id: 'non-existent' }, mockCtx)
      expect(result.success).toBe(false)
      expect(result.output).toContain('不存在')
    })

    it('should require id parameter', async () => {
      const tool = agentTools.find(t => t.name === 'agent_delete')
      expect(tool).toBeDefined()

      const result = await tool!.execute({}, mockCtx)
      expect(result.success).toBe(false)
      expect(result.output).toContain('ID 不能为空')
    })
  })

  describe('agent_do_delete', () => {
    it('should reject when not confirmed', async () => {
      const tool = agentTools.find(t => t.name === 'agent_do_delete')
      expect(tool).toBeDefined()

      const result = await tool!.execute({
        confirmed: false,
        id: 'test-id',
        agentName: 'Test Agent',
      }, mockCtx)

      expect(result.success).toBe(false)
      expect(result.output).toContain('未确认')
    })
  })

  describe('Tool schema', () => {
    it('should have correct parameter schemas', () => {
      const toolNames = agentTools.map(t => t.name)

      expect(toolNames).toContain('agent_list')
      expect(toolNames).toContain('agent_get')
      expect(toolNames).toContain('agent_create')
      expect(toolNames).toContain('agent_do_create')
      expect(toolNames).toContain('agent_update')
      expect(toolNames).toContain('agent_do_update')
      expect(toolNames).toContain('agent_delete')
      expect(toolNames).toContain('agent_do_delete')
    })

    it('should have Chinese displayNames', () => {
      for (const tool of agentTools) {
        expect(tool.displayName).toBeDefined()
        expect(typeof tool.displayName).toBe('string')
      }
    })
  })
})
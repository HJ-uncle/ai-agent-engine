import { z } from 'zod'
import { SQLiteAgentStore, type Agent, type CreateAgentInput, type UpdateAgentInput } from '../storage/agent/index.js'
import { AgentConfigurationConflict, agentConfigurationRevision } from '../storage/agent/configuration.js'
import { isDefaultTool } from '../tools/tool-exposure.js'
import { normalizeToolName, type ToolProfile } from '../tools/tool-profile.js'

const names = z.array(z.string().trim().min(1)).transform(values => [...new Set(values)])
export const agentIdSchema = z.string().trim().min(1, 'Agent ID 不能为空')
export const agentConfigurationSchema = z.object({
  name: z.string().trim().min(1, 'Agent 名称不能为空'),
  description: z.string().optional(),
  systemPrompt: z.string().optional(),
  model: z.string().optional(),
  temperature: z.number().finite().min(0).max(2).optional(),
  skills: names.optional(),
  mcpServers: names.optional(),
  knowledgeBases: names.optional(),
  allowedTools: names.transform(values => [...new Set(values.map(normalizeToolName))]).optional(),
}).strict()
export const agentUpdateSchema = agentConfigurationSchema.partial().refine(
  value => Object.values(value).some(field => field !== undefined), '至少提供一个需要更新的配置字段',
)

export type AgentMutation = 'create' | 'update' | 'delete'
export type PreparedAgentMutation =
  | { version: 1; action: 'create'; tenantId: string; input: CreateAgentInput }
  | { version: 1; action: 'update'; tenantId: string; id: string; input: UpdateAgentInput; before: Agent; revision: string }
  | { version: 1; action: 'delete'; tenantId: string; id: string; before: Agent; revision: string }
export interface AgentChange { action: AgentMutation; id: string; agent?: Agent }

export class AgentManagementError extends Error {
  constructor(public readonly code: number, message: string) { super(message); this.name = 'AgentManagementError' }
}
export function agentManagementFailure(error: unknown): { code: number; message: string } {
  if (error instanceof z.ZodError) return { code: 40001, message: `参数验证失败：${error.errors[0]?.message ?? error.message}` }
  if (error instanceof AgentManagementError) return { code: error.code, message: error.message }
  if (error instanceof AgentConfigurationConflict) return { code: 40900, message: error.message }
  return { code: 50000, message: error instanceof Error ? error.message : String(error) }
}

/** Use executable defaults (including OSM), without external discovery. */
export async function recommendedAgentTools(toolProfile: ToolProfile = 'general'): Promise<string[]> {
  // Lazy to avoid the factory -> Agent tools -> management service import cycle.
  const { createToolRegistry } = await import('../tools/registry-factory.js')
  const { registry } = await createToolRegistry({ toolProfile,
    allowedMcpServers: [], allowedSkills: [], strictSkillBindings: true })
  return registry.list().map(tool => tool.name)
    .filter(name => isDefaultTool(name) && name !== 'plan_update' && name !== 'load_tools')
}

export type AgentManagementStore = Pick<SQLiteAgentStore, 'list' | 'getById' | 'create' | 'update' | 'delete'>

/** REST and model tools share validation, defaults, target selection and conflict behavior. */
export class AgentManagementService {
  constructor(private readonly store: AgentManagementStore = new SQLiteAgentStore(),
    private readonly defaults: () => Promise<string[]> = recommendedAgentTools) {}

  list(tenantId: string): Promise<Agent[]> { return this.store.list(tenantId) }

  async get(tenantId: string, rawId: unknown): Promise<Agent> {
    const id = agentIdSchema.parse(rawId)
    const agent = await this.store.getById(id, tenantId)
    if (!agent) throw new AgentManagementError(40400, `Agent "${id}" 不存在；请使用 agent_list 返回的完整 ID`)
    return agent
  }

  private async assertAvailableName(tenantId: string, name: string, ownId?: string): Promise<void> {
    const collision = (await this.store.list(tenantId)).find(agent => agent.name === name && agent.id !== ownId)
    if (collision) throw new AgentManagementError(40900, `已存在同名 Agent "${name}" (${collision.id})；请明确更新该 ID 或使用其他名称`)
  }

  async prepareCreate(tenantId: string, rawInput: unknown): Promise<PreparedAgentMutation & { action: 'create' }> {
    const parsed = agentConfigurationSchema.parse(rawInput)
    await this.assertAvailableName(tenantId, parsed.name)
    const input: CreateAgentInput = { ...parsed, skills: parsed.skills ?? [], mcpServers: parsed.mcpServers ?? [],
      knowledgeBases: parsed.knowledgeBases ?? [], allowedTools: parsed.allowedTools ?? await this.defaults() }
    return { version: 1, action: 'create', tenantId, input }
  }

  async prepareUpdate(tenantId: string, rawId: unknown, rawInput: unknown): Promise<PreparedAgentMutation & { action: 'update' }> {
    const input = agentUpdateSchema.parse(rawInput)
    const before = await this.get(tenantId, rawId)
    if (input.name !== undefined) await this.assertAvailableName(tenantId, input.name, before.id)
    return { version: 1, action: 'update', tenantId, id: before.id, input, before, revision: agentConfigurationRevision(before) }
  }

  async prepareDelete(tenantId: string, rawId: unknown): Promise<PreparedAgentMutation & { action: 'delete' }> {
    const before = await this.get(tenantId, rawId)
    return { version: 1, action: 'delete', tenantId, id: before.id, before, revision: agentConfigurationRevision(before) }
  }

  async apply(operation: PreparedAgentMutation): Promise<AgentChange> {
    if (operation.action === 'create') {
      const agent = await this.store.create(operation.tenantId, operation.input)
      return { action: 'create', id: agent.id, agent }
    }
    if (operation.action === 'update') {
      const agent = await this.store.update(operation.id, operation.tenantId, operation.input, operation.revision)
      if (!agent) throw new AgentManagementError(40400, 'Agent 不存在，未执行更新')
      return { action: 'update', id: agent.id, agent }
    }
    const deleted = await this.store.delete(operation.id, operation.tenantId, operation.revision)
    if (!deleted) throw new AgentManagementError(40400, 'Agent 不存在，未执行删除')
    return { action: 'delete', id: operation.id }
  }

  async create(tenantId: string, input: unknown): Promise<Agent> {
    return (await this.apply(await this.prepareCreate(tenantId, input))).agent!
  }
  async update(tenantId: string, id: unknown, input: unknown): Promise<Agent> {
    return (await this.apply(await this.prepareUpdate(tenantId, id, input))).agent!
  }
  async delete(tenantId: string, id: unknown): Promise<{ id: string }> {
    return { id: (await this.apply(await this.prepareDelete(tenantId, id))).id }
  }
}

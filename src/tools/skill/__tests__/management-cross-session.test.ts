// Real management tools, SQLite Agent bindings and fresh execution registries; no model or discovery mocks.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentContext, IToolRegistry, ToolResult } from '../../../core/agent-context/types.js'
import type { ManagedSkill } from '../../../skills/management-service.js'
import type { Agent } from '../../../storage/agent/index.js'

const fixtureParent = path.resolve('.e2e-tmp', 'skill-cross-session')
let root: string, workspace: string
let factory: typeof import('../../registry-factory.js').createToolRegistry
let agentStore: import('../../../storage/agent/index.js').SQLiteAgentStore
let closeDatabase: () => Promise<unknown>, stopSkills: () => void
let sessionA: IToolRegistry
const ctx = (sessionId: string, tools: IToolRegistry): AgentContext => ({
  tenantId: 'default', sessionId, currentToolCallId: sessionId + '-call',
  projectRoot: workspace, workspacePaths: [workspace], cwd: workspace, tools,
  managementPrincipal: { tenantId: 'default', method: 'none' },
}) as AgentContext

beforeAll(async () => {
  fs.mkdirSync(fixtureParent, { recursive: true })
  root = fs.mkdtempSync(path.join(fixtureParent, 'fixture-'))
  workspace = path.join(root, 'project')
  fs.mkdirSync(workspace)
  for (const [key, value] of Object.entries({ DATA_DIR: path.join(root, 'agent.db'), WORKSPACE_ROOT: path.join(root, 'scratch'),
    AETHER_GLOBAL_DIR: path.join(root, 'global'), SKILLS_ROOT: path.join(root, 'deployment'), MCP_CONFIG_PATH: path.join(root, 'mcp.json'),
    AUTH_ENABLED: 'false', OSM_MODE: 'off', LOG_LEVEL: 'silent' })) vi.stubEnv(key, value)
  const db = await import('../../../storage/sqlite/db.js')
  await db.initDb()
  closeDatabase = db.closeDb
  const { skillsRegistry } = await import('../../../skills/skills-registry.js')
  skillsRegistry.start()
  stopSkills = () => skillsRegistry.stop()
  factory = (await import('../../registry-factory.js')).createToolRegistry
  const { SQLiteAgentStore } = await import('../../../storage/agent/index.js')
  agentStore = new SQLiteAgentStore()
  sessionA = (await factory({ workspaceRoot: workspace, allowedMcpServers: [], toolkits: ['skill-management', 'agent-management'] })).registry
}, 30_000)

afterAll(async () => {
  stopSkills?.()
  await closeDatabase?.()
  vi.unstubAllEnvs()
  if (path.dirname(root) !== fixtureParent || !path.basename(root).startsWith('fixture-')) throw new Error('Unsafe cleanup target')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function approve(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const context = ctx('creator-A', sessionA)
  const waiting = await sessionA.execute(name, args, context)
  expect(waiting).toMatchObject({ status: 'waiting', needsConfirmation: true })
  const result = await sessionA.execute(name, args, { ...context, approvedToolCallId: context.currentToolCallId,
    resumeToolCall: { decision: 'approved', toolCall: { id: context.currentToolCallId!, name, args },
      pendingAction: JSON.parse(JSON.stringify(waiting.pendingAction)) } })
  expect(result.success, result.output).toBe(true)
  return result
}

describe('Skill creation and Agent reuse across sessions', () => {
  it('creates in A, persists the execution binding, and reads the exact skill in a fresh B registry', async () => {
    const marker = 'Use verification marker ORBIT-7319 after completing the requested workflow.'
    const created = await approve('skill_create', { name: 'cross-session-workflow', description: 'Synthetic workflow', content: marker })
    const skill = (JSON.parse(created.output) as { skill: ManagedSkill }).skill
    expect(skill.id).toMatch(/^skill-[a-f0-9]{32}$/)
    expect(skill.executionId).toBe('cross-session-workflow')
    const listed = await sessionA.execute('skill_list', {}, ctx('creator-A', sessionA))
    expect(JSON.parse(listed.output).skills).toContainEqual(expect.objectContaining({ id: skill.id, executionId: skill.executionId }))
    const agentResult = await approve('agent_create', { name: 'Cross-session Agent', skills: [skill.executionId],
      allowedTools: ['list_skills', 'get_skill'], systemPrompt: 'Use your bound workflow when requested.' })
    const id = (JSON.parse(agentResult.output) as { agentChange: { id: string } }).agentChange.id
    const agent = (await agentStore.getById(id, 'default')) as Agent
    expect(agent.skills).toEqual([skill.executionId])
    const sessionB = await factory({ workspaceRoot: workspace, allowedSkills: agent.skills, allowedTools: agent.allowedTools,
      allowedMcpServers: [], strictSkillBindings: true })
    expect(sessionB.externalSkills.map(item => item.name)).toEqual([skill.name])
    const read = await sessionB.registry.execute('get_skill', { name: skill.name }, ctx('consumer-B', sessionB.registry))
    expect(read).toMatchObject({ success: true, output: expect.stringContaining(marker) })
    expect(sessionB.registry.has('skill_create')).toBe(false)
    expect(sessionB.registry.has('agent_create')).toBe(false)

    const otherWorkspace = path.join(root, 'other-project'); fs.mkdirSync(otherWorkspace)
    const other = await factory({ workspaceRoot: otherWorkspace, allowedSkills: agent.skills, allowedTools: agent.allowedTools, allowedMcpServers: [], strictSkillBindings: true })
    expect(other.externalSkills).toEqual([])
    await approve('skill_set_enabled', { id: skill.id, enabled: false })
    const disabled = await factory({ workspaceRoot: workspace, allowedSkills: agent.skills, allowedTools: agent.allowedTools, allowedMcpServers: [], strictSkillBindings: true })
    expect(disabled.externalSkills).toEqual([])
  })

  it('refuses a management hash as an Agent execution binding instead of saving a silent broken reference', async () => {
    const created = await approve('skill_create', { name: 'binding-identity', description: 'Identity check', content: 'Identity marker.' })
    const skill = (JSON.parse(created.output) as { skill: ManagedSkill }).skill
    const invalid = await sessionA.execute('agent_create', { name: 'Wrong binding', skills: [skill.id] }, ctx('creator-A', sessionA))
    expect(invalid).toMatchObject({ success: false, status: 'failed' })
    expect(invalid.output).toContain('executionId')
    expect((await agentStore.list('default')).some(agent => agent.name === 'Wrong binding')).toBe(false)
  })

  it('preserves a legitimate hash-shaped manifest execution ID without confusing it with management IDs', async () => {
    const created = await approve('skill_create', { name: 'custom-runtime-identity', description: 'Manifest identity', content: 'Manifest workflow marker.' })
    const skill = (JSON.parse(created.output) as { skill: ManagedSkill }).skill
    const runtimeId = 'skill-' + '1'.repeat(32)
    fs.writeFileSync(path.join(skill.dir, 'plugin.json'), JSON.stringify({ id: runtimeId }))
    const detail = await sessionA.execute('skill_get', { id: skill.id }, ctx('creator-A', sessionA))
    expect(JSON.parse(detail.output)).toMatchObject({ id: skill.id, executionId: runtimeId })
    const createdAgent = await approve('agent_create', { name: 'Manifest-bound Agent', skills: [runtimeId], allowedTools: ['get_skill'] })
    const agent = (JSON.parse(createdAgent.output) as { agentChange: { agent: Agent } }).agentChange.agent
    const sessionB = await factory({ workspaceRoot: workspace, allowedSkills: agent.skills, allowedTools: agent.allowedTools, allowedMcpServers: [], strictSkillBindings: true })
    const read = await sessionB.registry.execute('get_skill', { name: skill.name }, ctx('consumer-C', sessionB.registry))
    expect(read).toMatchObject({ success: true, output: expect.stringContaining('Manifest workflow marker.') })
  })
})

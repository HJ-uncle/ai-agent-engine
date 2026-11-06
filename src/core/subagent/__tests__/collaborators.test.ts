// Admission validation is independent of model behavior, agent binding and root-history mutation.
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '../../../storage/agent/index.js'
import { isTerminalRun, type SubagentRun, type SubagentRunHeader } from '../types.js'
import { prepareCollaborators } from '../collaborators.js'

const profile: Agent = { id: 'frontend', tenantId: 'tenant', name: '前端工程师', systemPrompt: 'Build interfaces', model: 'child-model',
  skills: ['design'], mcpServers: ['docs'], knowledgeBases: ['kb'], allowedTools: ['read_file', 'write_file'], createdAt: 1, updatedAt: 1 }
function run(patch: Partial<SubagentRun> = {}): SubagentRun {
  return { schemaVersion: 1, runId: 'first', tenantId: 'tenant', rootSessionId: 'parent', parentSessionId: 'parent',
    parentConversationId: 'turn', parentMessageId: 'message', parentToolCallId: 'tool', childSessionId: 'child',
    agentId: profile.id, agentName: profile.name, task: 'first task', description: 'frontend', modelId: profile.model!,
    status: 'succeeded', lastSeq: 2, createdAt: 1, updatedAt: 2, usage: {}, toolCalls: [], transcriptRef: 'session:child',
    continuation: { agent: profile, readOnly: false, userDelegated: true, systemPrompt: 'Original prompt',
      toolNames: ['read_file', 'write_file'], workspacePaths: ['/project'] }, ...patch }
}
function dependencies(records: SubagentRun[] = [], registered: Agent[] = [profile]) {
  const header = (record?: SubagentRun): SubagentRunHeader | null => {
    if (!record) return null
    const { toolCalls, ...value } = record
    return { ...value, toolCount: toolCalls.length, activeToolCount: 0, nonPlanToolCount: toolCalls.length }
  }
  return {
    runs: { getRunHeader: vi.fn(async (tenant: string, id: string, _fullRecord?: boolean) => header(records.find(item => item.tenantId === tenant && item.runId === id))),
      latestAgentHeader: vi.fn(async (tenant: string, parent: string, agentId: string, _fullRecord?: boolean) => header(records.filter(item => item.tenantId === tenant && item.parentSessionId === parent
        && item.rootSessionId === parent && (item.agentId ?? item.continuation?.agent?.id) === agentId).at(-1))),
      hasActiveChildInvocation: vi.fn(async (tenant: string, parent: string, child: string) => records.some(item => item.tenantId === tenant
        && item.parentSessionId === parent && item.childSessionId === child && !isTerminalRun(item.status))) },
    agents: { getById: vi.fn(async (id: string, tenant: string) => registered.find(item => item.id === id && item.tenantId === tenant) ?? null) },
  }
}

describe('explicit collaborators pre-admission validation', () => {
  it.each([null, {}, 'frontend', Array.from({ length: 9 }, () => ({ agentId: 'frontend' })), [null], [{}], [{ agentId: '' }], [{ resumeRunId: 3 }]])
    ('rejects invalid user selections %j before execution', async input => {
      await expect(prepareCollaborators('tenant', 'parent', input, dependencies())).rejects.toMatchObject({ statusCode: 400 })
    })
  it('rejects a missing or other-tenant Agent and never substitutes a default assistant', async () => {
    const deps = dependencies()
    await expect(prepareCollaborators('other-tenant', 'parent', [{ agentId: profile.id }], deps)).rejects.toMatchObject({ statusCode: 404 })
    await expect(prepareCollaborators('tenant', 'parent', [{ agentId: 'missing' }], deps)).rejects.toMatchObject({ statusCode: 404 })
  })
  it('deduplicates the same selected Agent', async () => {
    const prepared = await prepareCollaborators('tenant', 'parent', [{ agentId: profile.id }, { agentId: profile.id }], dependencies())
    expect(prepared).toHaveLength(1)
    expect(prepared[0]).toMatchObject({ agentId: profile.id, agent: { name: profile.name, allowedTools: profile.allowedTools } })
  })
  it('automatically resumes the latest run for the same Agent, including after the Agent definition is deleted', async () => {
    const first = run()
    const last = run({ runId: 'latest', createdAt: 3 })
    const deps = dependencies([first, last], [])
    const prepared = await prepareCollaborators('tenant', 'parent', [{ agentId: profile.id }, { resumeRunId: last.runId }], deps)
    expect(prepared).toHaveLength(1)
    expect(prepared[0]).toMatchObject({ agentId: profile.id, resumeRunId: 'latest', agent: { systemPrompt: profile.systemPrompt } })
    expect(deps.agents.getById).not.toHaveBeenCalled()
    expect(deps.runs.latestAgentHeader).toHaveBeenCalledWith('tenant', 'parent', profile.id, true)
    expect(deps.runs.getRunHeader).toHaveBeenCalledWith('tenant', last.runId, true)
  })
  it('rejects another parent, another tenant or a different Agent on a continuation', async () => {
    const deps = dependencies([run()])
    await expect(prepareCollaborators('tenant', 'another-parent', [{ resumeRunId: 'first' }], deps)).rejects.toMatchObject({ statusCode: 404 })
    await expect(prepareCollaborators('another-tenant', 'parent', [{ resumeRunId: 'first' }], deps)).rejects.toMatchObject({ statusCode: 404 })
    await expect(prepareCollaborators('tenant', 'parent', [{ resumeRunId: 'first', agentId: 'different' }], deps)).rejects.toMatchObject({ statusCode: 409 })
  })
  it('refuses an active child even when the user selects an older completed round', async () => {
    const deps = dependencies([run(), run({ runId: 'active', status: 'running', createdAt: 3 })])
    await expect(prepareCollaborators('tenant', 'parent', [{ resumeRunId: 'first' }], deps)).rejects.toMatchObject({ statusCode: 409 })
    await expect(prepareCollaborators('tenant', 'parent', [{ agentId: profile.id }], deps)).rejects.toMatchObject({ statusCode: 409 })
  })
  it('does not restore a legacy child with unknown permission bindings', async () => {
    await expect(prepareCollaborators('tenant', 'parent', [{ resumeRunId: 'first' }], dependencies([run({ continuation: undefined })])))
      .rejects.toMatchObject({ statusCode: 409 })
  })
  it('rejects a continuation whose workspace no longer belongs to the parent before root admission', async () => {
    await expect(prepareCollaborators('tenant', 'parent', [{ resumeRunId: 'first' }],
      { ...dependencies([run()]), workspacePaths: ['/other-project'] })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('creates independent workers from the same builtin template without looking up configured Agents', async () => {
    const deps = dependencies()
    const prepared = await prepareCollaborators('tenant', 'parent', [
      { builtinRole: 'executor', task: 'Build component A', instanceKey: 'a' },
      { builtinRole: 'executor', task: 'Build component B', instanceKey: 'b' },
      { builtinRole: 'executor', task: 'Integrate after A and B' },
    ], deps)
    expect(prepared).toHaveLength(3)
    expect(prepared.map(plan => plan.task)).toEqual(['Build component A', 'Build component B', 'Integrate after A and B'])
    expect(prepared.every(plan => plan.resumeRunId === undefined && plan.builtinRole === 'executor')).toBe(true)
    expect(deps.agents.getById).not.toHaveBeenCalled()
    for (const lookup of Object.values(deps.runs)) expect(lookup).not.toHaveBeenCalled()
  })

  it('deduplicates identical selection keys but rejects a conflicting task for that key', async () => {
    const selected = { builtinRole: 'executor', task: 'Build A', instanceKey: 'a' }
    expect(await prepareCollaborators('tenant', 'parent', [selected, selected], dependencies())).toHaveLength(1)
    await expect(prepareCollaborators('tenant', 'parent', [selected, { ...selected, task: 'Build B' }], dependencies()))
      .rejects.toMatchObject({ statusCode: 409 })
  })

  it('resumes two distinct children of the same configured Agent instead of dropping the second one', async () => {
    const deps = dependencies([run(), run({ runId: 'second', childSessionId: 'other-child' })])
    const prepared = await prepareCollaborators('tenant', 'parent', [{ resumeRunId: 'first' }, { resumeRunId: 'second' }], deps)
    expect(prepared.map(plan => plan.resumeRunId)).toEqual(['first', 'second'])
  })

  it.each([
    { builtinRole: 'unknown' }, { builtinRole: 'executor', agentId: 'frontend' },
    { builtinRole: 'executor', instanceKey: '' }, { builtinRole: 'executor', task: 5 },
    { builtinRole: 'executor', workspacePaths: ['/secret'] }, { agentId: 'frontend', instanceKey: 'a' },
  ])('rejects invalid builtin selections %j before admission', async selection => {
    await expect(prepareCollaborators('tenant', 'parent', [selection], dependencies())).rejects.toMatchObject({ statusCode: 400 })
  })

  it('does not change a completed child role through an explicit selection', async () => {
    const prior = run({ agentId: undefined, continuation: { builtinRole: 'research', builtinRoleVersion: 1,
      readOnly: true, systemPrompt: 'Read only', toolNames: ['read_file'], workspacePaths: ['/project'] } })
    expect(await prepareCollaborators('tenant', 'parent', [{ resumeRunId: prior.runId, builtinRole: 'research' }], dependencies([prior])))
      .toMatchObject([{ resumeRunId: prior.runId, builtinRole: 'research' }])
    await expect(prepareCollaborators('tenant', 'parent', [{ resumeRunId: prior.runId, builtinRole: 'executor' }], dependencies([prior])))
      .rejects.toMatchObject({ statusCode: 409 })
  })
})

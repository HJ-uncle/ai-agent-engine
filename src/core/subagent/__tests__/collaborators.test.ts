// Admission validation is independent of model behavior, agent binding and root-history mutation.
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '../../../storage/agent/index.js'
import type { SubagentRun } from '../types.js'
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
  return {
    runs: { getRun: vi.fn(async (tenant: string, id: string) => records.find(item => item.tenantId === tenant && item.runId === id) ?? null),
      listRunsForParent: vi.fn(async (tenant: string, parent: string) => records.filter(item => item.tenantId === tenant && item.parentSessionId === parent)) },
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
})

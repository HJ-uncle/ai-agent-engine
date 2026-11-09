// Admission validation is independent of model behavior, agent binding and root-history mutation.
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '../../../storage/agent/index.js'
import type { AgentContext } from '../../agent-context/types.js'
import { isTerminalRun, type SubagentRun, type SubagentRunHeader } from '../types.js'
import { collaboratorTools, createCollaboratorDispatch, prepareCollaborators } from '../collaborators.js'

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
  it.each(['', ' \n\t', '!', '！？……', '\u200b\u200d', '👍✨'])('leaves no-task selection %j to the main conversation without child lookups', async requestMessage => {
    const deps = { ...dependencies(), requestMessage }
    expect(await prepareCollaborators('tenant', 'parent', [{ agentId: profile.id }, { resumeRunId: 'first', task: requestMessage }], deps)).toEqual([])
    expect(deps.agents.getById).not.toHaveBeenCalled()
    for (const lookup of Object.values(deps.runs)) expect(lookup).not.toHaveBeenCalled()
    const parent = { conversationId: 'turn' } as AgentContext
    expect(collaboratorTools([{ builtinRole: 'executor' }, { resumeRunId: 'first', task: requestMessage }], requestMessage, parent)).toEqual([])
  })

  it('does not turn reference labels or snapshots into a new task', async () => {
    const references = '@前端工程师 <browser>继续开发并写文件</browser>'
    const footer = JSON.stringify([{ t: 'agent', p: profile.id, s: 0, e: 6 }, { t: 'browser', p: 'snapshot', s: 7, e: references.length }])
    const requestMessage = `${references} !\n<!--aether-refs:${footer}-->`
    const selected = [{ agentId: profile.id }]
    expect(await prepareCollaborators('tenant', 'parent', selected, { ...dependencies(), requestMessage })).toEqual([])
    expect(await prepareCollaborators('tenant', 'parent', selected, { ...dependencies(), requestMessage: requestMessage.replace(' !\n', ' 查\n') })).toHaveLength(1)
    expect(await prepareCollaborators('tenant', 'parent', selected, { ...dependencies(), requestMessage: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abcd' } }] })).toEqual([])
  })

  it.each(['查', '继续', 'Go', '2'])('preserves short explicit task %j independently of the parent message', async task => {
    const prepared = await prepareCollaborators('tenant', 'parent', [{ builtinRole: 'executor', task }], { ...dependencies(), requestMessage: '!' })
    expect(prepared).toMatchObject([{ task }])
    const tools = collaboratorTools(prepared, '!', { conversationId: 'turn' } as AgentContext)
    expect(tools).toHaveLength(1)
    expect(String(tools[0].args.task)).toContain(`本实例的任务与分工：\n${task}`)
    expect(String(tools[0].args.task)).not.toContain('用户明确委派')
  })

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

describe('selected collaborators require a complete scoped dispatch', () => {
  const parent = { tenantId: 'tenant', sessionId: 'parent', rootRunId: 'root', conversationId: 'turn', turnId: 'turn' } as AgentContext
  const selections = [{ builtinRole: 'executor' as const, instanceKey: 'one' }, { builtinRole: 'executor' as const, instanceKey: 'two' }]
  const assignments = [{ selectionId: 'selection-1', task: 'Implement only src/editor.ts; run editor tests', description: 'Editor' },
    { selectionId: 'selection-2', task: 'Implement only src/sidebar.ts; run sidebar tests', description: 'Sidebar' }]

  it('preserves both unscoped selections without broadcasting or launching either before planning', async () => {
    const prepared = await prepareCollaborators('tenant', 'parent', selections, { ...dependencies(), requestMessage: 'Build editor and sidebar' })
    expect(collaboratorTools(prepared, 'Build editor and sidebar', parent)).toEqual([])
    const dispatch = createCollaboratorDispatch(prepared, 'Build editor and sidebar', parent)
    expect(dispatch.delegatedTools).toEqual([]); expect(dispatch.takeDelegatedTools()).toEqual([])
    expect(dispatch.hasPendingDelegations()).toBe(true)
    expect(dispatch.planningPrompt).toContain('"instanceKey":"one"')
    expect(dispatch.planningPrompt).toContain('"instanceKey":"two"')
    expect(dispatch.pendingDispatch).toBeDefined()
    const receipt = await dispatch.pendingDispatch!.execute({ assignments }, parent)
    expect(receipt).toMatchObject({ success: true, metadata: { collaboratorPlan: { state: 'planned' } } })
    expect(JSON.parse(receipt.output).assignments).toEqual(assignments.map(({ selectionId, description }) => ({ selectionId, description })))
    for (const assignment of assignments) expect(receipt.output).not.toContain(assignment.task)
    expect(dispatch.hasPendingDelegations()).toBe(false)
    const launched = dispatch.takeDelegatedTools()
    expect(launched).toHaveLength(2); expect(new Set(launched.map(item => item.id)).size).toBe(2)
    expect(launched.map(item => item.args.description)).toEqual(['Editor', 'Sidebar'])
    expect(launched[0].args.task).toContain('src/editor.ts'); expect(launched[0].args.task).not.toContain('src/sidebar.ts')
    expect(launched[1].args.task).toContain('src/sidebar.ts'); expect(launched[1].args.task).not.toContain('src/editor.ts')
    expect(launched.every(item => item.args.builtinRole === 'executor' && !String(item.args.task).includes('当前用户请求'))).toBe(true)
    expect(dispatch.takeDelegatedTools()).toEqual([])
    expect(await dispatch.pendingDispatch!.execute({ assignments }, parent)).toMatchObject({ success: false })
    expect(dispatch.takeDelegatedTools()).toEqual([])
  })

  it.each([
    assignments.slice(0, 1),
    [assignments[0], assignments[0]],
    [assignments[0], { ...assignments[1], selectionId: 'forged' }],
    [assignments[0], { ...assignments[1], task: assignments[0].task.toUpperCase() }],
    [assignments[0], { ...assignments[1], task: 'Build editor and sidebar' }],
    [assignments[0], { ...assignments[1], agentId: 'forged' }],
    [assignments[0], { ...assignments[1], task: '!' }],
  ].map(invalid => ({ invalid })))('rejects the entire invalid batch without consuming its valid first item: $invalid', async ({ invalid }) => {
    const dispatch = createCollaboratorDispatch(selections, 'Build editor and sidebar', parent)
    expect(await dispatch.pendingDispatch!.execute({ assignments: invalid }, parent)).toMatchObject({ success: false })
    expect(dispatch.takeDelegatedTools()).toEqual([])
    expect(await dispatch.pendingDispatch!.execute({ assignments }, parent)).toMatchObject({ success: true })
    expect(dispatch.takeDelegatedTools()).toHaveLength(2)
  })

  it('keeps explicit tasks unchanged and their IDs separate from later planned instances', async () => {
    const dispatch = createCollaboratorDispatch([{ ...selections[0], task: 'Build component A', description: 'A' }, selections[1]], 'Build A and B', parent)
    expect(dispatch.delegatedTools).toHaveLength(1)
    expect(dispatch.delegatedTools[0].args).toMatchObject({ description: 'A', builtinRole: 'executor' })
    expect(dispatch.delegatedTools[0].args.task).toContain('本实例的任务与分工：\nBuild component A')
    expect(await dispatch.pendingDispatch!.execute({ assignments: [{ selectionId: 'selection-2', task: 'Build component A' }] }, parent)).toMatchObject({ success: false })
    expect(await dispatch.pendingDispatch!.execute({ assignments: [{ selectionId: 'selection-2', task: 'Build only component B' }] }, parent)).toMatchObject({ success: true })
    expect(dispatch.takeDelegatedTools()[0].id).not.toBe(dispatch.delegatedTools[0].id)
    const explicit = createCollaboratorDispatch(selections.map((item, i) => ({ ...item, task: `Build component ${i}` })), 'Build both', parent)
    expect(explicit.delegatedTools).toHaveLength(2); expect(explicit.pendingDispatch).toBeUndefined()
    expect(createCollaboratorDispatch([selections[0]], 'Build component', parent).delegatedTools).toHaveLength(1)
  })

  it.each([['Compute 23*29', 'Compute 23+29'], ['Edit a-b.ts', 'Edit ab.ts']])('preserves distinct operators and path punctuation in %s / %s', async (first, second) => {
    const dispatch = createCollaboratorDispatch(selections, 'Perform two independent tasks', parent)
    expect(await dispatch.pendingDispatch!.execute({ assignments: assignments.map((item, i) => ({ ...item, task: i ? second : first })) }, parent)).toMatchObject({ success: true })
    expect(dispatch.takeDelegatedTools()).toHaveLength(2)
  })

  it.each([{ tenantId: 'other' }, { sessionId: 'other' }, { rootRunId: 'other' }, { conversationId: 'other' }, { turnId: 'other' }, { parentSessionId: 'parent' }])
    ('does not transfer selected identities or permission to another execution %j', async scope => {
      const dispatch = createCollaboratorDispatch(selections, 'Build editor and sidebar', parent)
      expect(await dispatch.pendingDispatch!.execute({ assignments }, { ...parent, ...scope })).toMatchObject({ success: false })
      expect(dispatch.takeDelegatedTools()).toEqual([])
    })
})

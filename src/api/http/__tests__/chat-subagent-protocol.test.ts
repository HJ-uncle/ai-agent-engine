// Covers strict per-viewer negotiation, canonical legacy output and exact published watermarks.
import { describe, expect, it } from 'vitest'
import { getRequestSubagentProtocol, publishedSubagentRuns, subagentProjectionForViewer } from '../chat-subagent-protocol.js'
import { projectSubagentRunView } from '../../../core/subagent/view.js'
import type { SubagentRun } from '../../../core/subagent/types.js'

const scope = { tenantId: 'tenant', sessionId: 'parent' }
const run = (patch: Partial<SubagentRun> = {}): SubagentRun => ({ schemaVersion: 1, runId: 'child',
  tenantId: scope.tenantId, rootSessionId: 'parent', parentSessionId: 'parent', parentConversationId: 'turn',
  parentMessageId: 'msg', parentToolCallId: 'delegate', childSessionId: 'child-session', task: 'synthetic',
  description: 'review', modelId: 'fixture', status: 'running', lastSeq: 8, createdAt: 1, updatedAt: 8,
  usage: { totalTokens: 12 }, toolCalls: [], transcriptRef: 'session:child-session', ...patch })

describe('chat subagent protocol boundary', () => {
  it('accepts absent v1 and exact version2 while rejecting ambiguous headers', () => {
    expect(getRequestSubagentProtocol({ headers: {} })).toBe(1)
    expect(getRequestSubagentProtocol({ headers: { 'x-aether-subagent-protocol': '2' } })).toBe(2)
    for (const value of ['1', '02', '2,2', '3', '', ['2', '2']])
      expect(() => getRequestSubagentProtocol({ headers: { 'x-aether-subagent-protocol': value } })).toThrow('must be 2')
  })
  it.each([1, 2] as const)('protocol %s replaces only the active turn at its exact published cursor', protocol => {
    const previous = run({ runId: 'old-child', parentConversationId: 'old-turn', usage: { totalTokens: 3 } })
    const delivered = run()
    const future = run({ lastSeq: 9, usage: { totalTokens: 99999 } })
    const hidden = run({ runId: 'not-published', lastSeq: 3 })
    const external = run({ runId: 'external', tenantId: 'other' })
    const visible = publishedSubagentRuns([previous, future, hidden, external], [delivered], scope, protocol, 'turn')
    expect(visible.map(item => item.runId)).toEqual(['old-child', 'child'])
    expect(visible.find(item => item.runId === 'child')).toMatchObject({ lastSeq: 8, usage: { totalTokens: 12 } })
    expect(visible.every(item => item.schemaVersion === protocol)).toBe(true)
  })
  it('legacy output retains all 4100 canonical tools, and rejects a summary passed as legacy', () => {
    const archive = run({ lastSeq: 4200, toolCalls: Array.from({ length: 4100 }, (_, i) => ({ id: `tool-${i}`,
      name: 'read_file', args: { path: `file-${i}` }, status: i === 4099 ? 'running' : 'succeeded', output: 'ok' })) })
    const view = projectSubagentRunView(archive)
    expect(view.toolCount).toBe(4100)
    expect(view.toolCalls.length).toBeLessThan(4100)
    const [canonical] = publishedSubagentRuns([archive], [], scope, 1)
    expect(canonical.toolCalls).toHaveLength(4100)
    expect(canonical.toolCalls.at(-1)?.id).toBe('tool-4099')
    expect(() => publishedSubagentRuns([view], [], scope, 1)).toThrow('Complete legacy snapshot')
  })
  it('legacy projection materializes event and nested result from exact canonical records', () => {
    const archive = run({ toolCalls: [{ id: 't', name: 'read_file', args: { body: 'large'.repeat(2000) }, status: 'succeeded' }] })
    const view = projectSubagentRunView(archive)
    const projection = [{ subagentEvent: { schemaVersion: 2, kind: 'tool.completed', runId: archive.runId, seq: 8, snapshot: view } },
      { toolEnd: { toolCallId: 'delegate', metadata: { subagent: view } } }, { content: 'unchanged' }]
    const converted = subagentProjectionForViewer(projection, [archive], 1)
    expect(converted[0]).toMatchObject({ subagentEvent: { schemaVersion: 1, seq: 8, snapshot: archive } })
    expect(converted[1]).toMatchObject({ toolEnd: { metadata: { subagent: archive } } })
    expect(converted[2]).toEqual({ content: 'unchanged' })
    expect(subagentProjectionForViewer(projection, [view], 2)[0]).toMatchObject({ subagentEvent: { schemaVersion: 2, kind: 'snapshot', runId: archive.runId, seq: 8, view } })
    expect(() => subagentProjectionForViewer(projection, [], 1)).toThrow('watermark is unavailable')
  })
})

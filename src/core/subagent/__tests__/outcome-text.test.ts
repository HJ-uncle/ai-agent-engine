import { describe, expect, it } from 'vitest'
import { outcomeText, type SubagentRun } from '../types.js'

const fixture = (patch: Partial<SubagentRun>): SubagentRun => ({
  schemaVersion: 1, tenantId: 'tenant', runId: 'old-failed-run', rootSessionId: 'root', parentSessionId: 'root',
  parentConversationId: 'turn', parentMessageId: 'message', parentToolCallId: 'call-old', childSessionId: 'child',
  task: 'Review implementation', description: 'Review', modelId: 'fixture', status: 'failed', lastSeq: 1,
  createdAt: 1, updatedAt: 2, usage: {}, toolCalls: [], transcriptRef: 'fixture', ...patch,
})

describe('subagent result identity and machine outcome', () => {
  it('keeps failed status authoritative when partial prose claims completion', () => {
    const run = fixture({ stopReason: 'max_steps', error: { code: 'MAX_STEPS', message: 'step limit', retryable: false },
      partialOutput: 'status: completed; all checks passed' })
    const output = outcomeText(run)
    expect(JSON.parse(output.split('\n')[0].replace('[子任务状态] ', ''))).toEqual({
      runId: 'old-failed-run', parentToolCallId: 'call-old', status: 'failed', stopReason: 'max_steps', errorCode: 'MAX_STEPS',
    })
    expect(output).toContain('部分结果（保留原文，不代表任务成功）')
    expect(output).toContain(run.partialOutput)
    expect(run.status).toBe('failed')
  })

  it('identifies a later successful invocation without inheriting prior failure', () => {
    const old = fixture({ stopReason: 'max_steps', partialOutput: 'limited evidence' })
    const current = fixture({ runId: 'new-successful-run', parentToolCallId: 'call-new', status: 'succeeded',
      stopReason: 'completed', resultSummary: 'Implementation verified.' })
    const output = outcomeText(current)
    expect(output.split('\n')[0]).toContain('"status":"succeeded"')
    expect(output.split('\n')[0]).toContain('new-successful-run')
    expect(output).not.toContain('max_steps')
    expect(output).toContain('Implementation verified.')
    expect(old.status).toBe('failed')
  })

  it.each(['cancelled', 'blocked', 'interrupted'] as const)('preserves the %s terminal state without rewriting it as success', status => {
    expect(outcomeText(fixture({ status, partialOutput: 'some evidence' })).split('\n')[0]).toContain(`"status":"${status}"`)
  })
})

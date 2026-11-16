import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { onAgentLifecycleEvent, type AgentLifecycleEvent } from '../../../core/runtime-events.js'
import type { RootRun } from '../../../storage/root-runs/index.js'
import { publishRootAgentEvent } from '../root-agent-events.js'

function run(): RootRun { return { schemaVersion: 1, runId: randomUUID(), sessionId: 'session', turnId: 'turn', userMessageId: 'user', assistantMessageId: 'assistant', seq: 1, version: 1, status: 'running', modelId: 'model', workspacePaths: [], createdAt: 1, updatedAt: 1, pending: [] } }
describe('main Agent lifecycle from durable receipts', () => {
  it('does not announce admission or waiting, deduplicates continuation and terminal publication', () => {
    const events: AgentLifecycleEvent[] = [], off = onAgentLifecycleEvent(event => events.push(event)), value = run()
    try {
      publishRootAgentEvent('tenant', value); expect(events).toHaveLength(0)
      value.startedAt = 2; publishRootAgentEvent('tenant', value)
      publishRootAgentEvent('tenant', { ...value, status: 'waiting' }); publishRootAgentEvent('tenant', value)
      publishRootAgentEvent('tenant', { ...value, status: 'succeeded' }); publishRootAgentEvent('tenant', { ...value, status: 'succeeded' })
      expect(events.map(event => event.type)).toEqual(['agent.started', 'agent.completed'])
      expect(events[1].payload).toEqual({ kind: 'main', runId: value.runId, status: 'succeeded', turnId: 'turn' })
    } finally { off() }
  })
  it('publishes durable cancellation/failure without leaking error details or aborting producer', () => {
    const events: AgentLifecycleEvent[] = [], offBroken = onAgentLifecycleEvent(() => { throw new Error('Broken extension') }), off = onAgentLifecycleEvent(event => events.push(event))
    try {
      expect(() => publishRootAgentEvent('tenant', { ...run(), status: 'cancelled' })).not.toThrow()
      publishRootAgentEvent('tenant', { ...run(), status: 'failed', error: { code: 'PRIVATE', message: 'secret', retryable: false } })
      expect(events.map(event => event.type)).toEqual(['agent.cancelled','agent.failed'])
      expect(JSON.stringify(events)).not.toContain('secret')
    } finally { off(); offBroken() }
  })
})

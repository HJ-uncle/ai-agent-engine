import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pino } from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestDispatchDiagnostic, logRequestDispatch } from '../dispatch-diagnostics.js'
import { prepareRequestContext, observeRequest, observeStreamRequest } from '../request-attempt.js'
import { WORKFLOW_REVIEW_PROMPT, READONLY_REPETITION_PROMPT, MUTATION_REPETITION_PROMPT } from '../../agent-loop/tool-progress.js'
import type { LLMRequestAttemptEvent } from '../types.js'

afterEach(() => vi.restoreAllMocks())
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

describe('final wire system diagnostics with a bounded durable log sink', () => {
  it.each([WORKFLOW_REVIEW_PROMPT, [{ type: 'text', text: WORKFLOW_REVIEW_PROMPT }]])('captures Anthropic system string or blocks without returning its contents', system => {
    const d = requestDispatchDiagnostic({ system, messages: [{ role: 'user', content: 'PRIVATE_TASK' }] }, 'normal')
    expect(d).toMatchObject({ availability: 'captured', workflowHintPresent: true, readonlyHintPresent: false, wireMessageCount: 1, requestStage: 'normal' })
    expect(d.systemPromptSha256).toBe(sha({ system, messages: [] }))
    expect(JSON.stringify(d)).not.toContain('PRIVATE_TASK')
    expect(JSON.stringify(d)).not.toContain(WORKFLOW_REVIEW_PROMPT)
  })

  it.each(['system', 'developer'])('uses actual %s messages and ignores instructions appearing in user or tool output', role => {
    const d = requestDispatchDiagnostic({ messages: [{ role, content: READONLY_REPETITION_PROMPT },
      { role: 'user', content: WORKFLOW_REVIEW_PROMPT }, { role: 'tool', content: WORKFLOW_REVIEW_PROMPT }] })
    expect(d).toMatchObject({ readonlyHintPresent: true, workflowHintPresent: false, requestStage: 'unknown', wireMessageCount: 3 })
    expect(d.systemPromptSha256).toBe(sha({ system: null, messages: [{ role, content: READONLY_REPETITION_PROMPT }] }))
  })

  it('changes hash only for the actual system representation and preserves provider block structure', () => {
    const a = requestDispatchDiagnostic({ system: 'policy', messages: [{ role: 'user', content: 'A' }] })
    const b = requestDispatchDiagnostic({ system: 'policy', messages: [{ role: 'user', content: 'B' }] })
    const c = requestDispatchDiagnostic({ system: [{ type: 'text', text: 'policy' }], messages: [] })
    expect(a.systemPromptSha256).toBe(b.systemPromptSha256)
    expect(a.systemPromptSha256).not.toBe(c.systemPromptSha256)
  })

  it('degrades an unserializable system to unavailable without introducing another execution failure', () => {
    const cycle: { self?: unknown } = {}; cycle.self = cycle
    expect(() => requestDispatchDiagnostic({ system: cycle })).not.toThrow()
    expect(requestDispatchDiagnostic({ system: cycle })).toEqual({ schemaVersion: 2, availability: 'unavailable', requestStage: 'unknown', wireMessageCount: 0 })
  })

  it('rebuilds a caller diagnostic from final params and does not accept a caller hint flag', () => {
    const d = prepareRequestContext({ model: 'model', requestStage: 'finalization',
      requestDispatchDiagnostic: { schemaVersion: 1, availability: 'captured', requestStage: 'normal', wireMessageCount: 999, workflowHintPresent: true } },
    { model: 'actual-model', system: 'Evidence-only finalization', messages: [{ role: 'user', content: WORKFLOW_REVIEW_PROMPT }] })
    expect(d.requestDispatchDiagnostic).toMatchObject({ requestStage: 'finalization', wireMessageCount: 1, workflowHintPresent: false, readonlyHintPresent: false })
    expect(d.model).toBe('actual-model')
  })

  it('ties complete and stream starts to the same physical attempt identity as their finishes', async () => {
    const events: LLMRequestAttemptEvent[] = []
    const options = prepareRequestContext({ model: 'model', requestStage: 'normal', onRequestAttempt: event => { events.push(event) } },
      { model: 'model', system: WORKFLOW_REVIEW_PROMPT, messages: [] })
    await observeRequest(async () => 'ok', options, 'mock', 'model', () => undefined)
    const stream = await observeStreamRequest(async () => (async function* () { yield 'ok' })(), options, 'mock', 'model', () => undefined)
    for await (const _part of stream) { /* consume the completed synthetic attempt */ }
    expect(events.map(event => event.type)).toEqual(['start', 'finish', 'start', 'finish'])
    expect(events[0].requestAttemptId).toBe(events[1].requestAttemptId)
    expect(events[2].requestAttemptId).toBe(events[3].requestAttemptId)
    expect(events[0].requestAttemptId).not.toBe(events[2].requestAttemptId)
    expect(events[0]).toMatchObject({ dispatchDiagnostic: { workflowHintPresent: true } })
    expect(events[2]).toMatchObject({ dispatchDiagnostic: { workflowHintPresent: true } })
    expect(events[1]).not.toHaveProperty('dispatchDiagnostic')
  })

  it('persists only the allowlist even when an event contains an extra secret payload', () => {
    const info = vi.fn()
    const event = { type: 'start' as const, requestAttemptId: randomUUID(), provider: 'PRIVATE_PROVIDER', model: 'PRIVATE_MODEL',
      dispatchDiagnostic: requestDispatchDiagnostic({ system: WORKFLOW_REVIEW_PROMPT, messages: [] }, 'normal'),
      rawBody: 'PRIVATE_BODY', credential: 'PRIVATE_KEY' }
    const subagentRunId = randomUUID()
    logRequestDispatch(event, { info }, { subagentRunId })
    expect(info).toHaveBeenCalledTimes(1)
    const fields = info.mock.calls[0][0]
    expect(fields).toMatchObject({ event: 'llm.dispatch.start', requestAttemptId: event.requestAttemptId, subagentRunId, workflowHintPresent: true })
    expect(Object.keys(fields).sort()).toEqual(['availability', 'event', 'mutationHintPresent', 'readonlyHintPresent', 'requestAttemptId', 'requestStage', 'schemaVersion', 'subagentRunId', 'systemPromptSha256', 'wireMessageCount', 'workflowHintPresent'].sort())
    for (const secret of ['PRIVATE_PROVIDER', 'PRIVATE_MODEL', 'PRIVATE_BODY', 'PRIVATE_KEY', WORKFLOW_REVIEW_PROMPT]) expect(JSON.stringify(info.mock.calls)).not.toContain(secret)
  })

  it('logs unavailable for missing capture and rejects unbounded or malformed count/hash data', () => {
    const info = vi.fn(), requestAttemptId = randomUUID()
    logRequestDispatch({ type: 'start', requestAttemptId, provider: 'mock', model: 'model', dispatchDiagnostic: {
      schemaVersion: 1, availability: 'captured', requestStage: 'normal', wireMessageCount: Infinity, systemPromptSha256: 'SECRET_VALUE', workflowHintPresent: true } }, { info })
    expect(info.mock.calls[0][0]).toEqual({ event: 'llm.dispatch.start', requestAttemptId, schemaVersion: 1, availability: 'unavailable', requestStage: 'normal', wireMessageCount: 0 })
  })

  it('writes a real pino destination receipt containing only safe fields', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-dispatch-log-'))
    const file = path.join(fixture, 'dispatch.jsonl')
    const destination = pino.destination({ dest: file, sync: true })
    try {
      const logger = pino({ base: null, level: 'warn' }, destination)
      logger.info({ privateTask: 'PRIVATE_UNRELATED_TASK' }, 'PRIVATE_UNRELATED_BEFORE')
      const requestAttemptId = randomUUID()
      logRequestDispatch({ type: 'start', requestAttemptId, provider: 'PRIVATE_PROVIDER', model: 'PRIVATE_MODEL',
        dispatchDiagnostic: requestDispatchDiagnostic({ system: WORKFLOW_REVIEW_PROMPT + '\n' + MUTATION_REPETITION_PROMPT, messages: [] }, 'normal') }, logger)
      logger.info({ privateTask: 'PRIVATE_UNRELATED_TASK' }, 'PRIVATE_UNRELATED_AFTER')
      expect(logger.level).toBe('warn')
      expect(logger.isLevelEnabled('info')).toBe(false)
      const raw = fs.readFileSync(file, 'utf8')
      expect(raw.trim().split('\n')).toHaveLength(1)
      const receipt = JSON.parse(raw.trim()) as Record<string, unknown>
      expect(receipt).toMatchObject({ event: 'llm.dispatch.start', requestAttemptId, schemaVersion: 2, availability: 'captured', workflowHintPresent: true, mutationHintPresent: true, wireMessageCount: 0 })
      expect(receipt.systemPromptSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(raw).not.toContain(WORKFLOW_REVIEW_PROMPT)
      expect(raw).not.toContain('PRIVATE_PROVIDER')
      expect(raw).not.toContain('PRIVATE_MODEL')
      expect(raw).not.toContain('PRIVATE_UNRELATED')
      expect(raw).not.toContain(MUTATION_REPETITION_PROMPT)
    } finally {
      destination.end()
      fs.unlinkSync(file)
      fs.rmdirSync(fixture)
    }
  })

  it('does not log finishes and makes a log transport failure best effort', () => {
    const info = vi.fn(() => { throw new Error('sink unavailable') })
    expect(() => logRequestDispatch({ type: 'start', requestAttemptId: randomUUID(), provider: 'mock', model: 'model' }, { info })).not.toThrow()
    expect(info).toHaveBeenCalledTimes(1)
    logRequestDispatch({ type: 'finish', requestAttemptId: randomUUID(), provider: 'mock', model: 'model', outcome: 'succeeded' }, { info })
    expect(info).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['', false, false],
    [MUTATION_REPETITION_PROMPT, true, false],
    [READONLY_REPETITION_PROMPT, false, true],
    [MUTATION_REPETITION_PROMPT + '\n' + READONLY_REPETITION_PROMPT, true, true],
  ] as const)('v2 distinguishes mutation and readonly hints in string/blocks/system/developer: %s', (text, mutation, readonly) => {
    const inputs = [
      { system: text }, { system: [{ type: 'text', text }] },
      { messages: [{ role: 'system', content: text }] }, { messages: [{ role: 'developer', content: [{ type: 'text', text }] }] },
    ]
    for (const input of inputs) {
      const d = requestDispatchDiagnostic(input, 'normal')
      expect(d).toMatchObject({ schemaVersion: 2, availability: 'captured', mutationHintPresent: mutation, readonlyHintPresent: readonly })
      expect(JSON.stringify(d)).not.toContain(MUTATION_REPETITION_PROMPT)
    }
  })

  it('user/tool mutation text never supplies a system hint; forged caller flags are rebuilt', () => {
    const final = { messages: [{ role: 'user', content: MUTATION_REPETITION_PROMPT }, { role: 'tool', content: MUTATION_REPETITION_PROMPT }] }
    const d = prepareRequestContext({ model: 'model', requestDispatchDiagnostic: { schemaVersion: 2, availability: 'captured', requestStage: 'normal',
      wireMessageCount: 999, mutationHintPresent: true } }, final)
    expect(d.requestDispatchDiagnostic).toMatchObject({ schemaVersion: 2, availability: 'captured', mutationHintPresent: false, wireMessageCount: 2 })
  })

  it('legacy v1 missing mutation field remains unknown rather than false', () => {
    const info = vi.fn(), requestAttemptId = randomUUID()
    logRequestDispatch({ type: 'start', requestAttemptId, provider: 'mock', model: 'model', dispatchDiagnostic: {
      schemaVersion: 1, availability: 'captured', requestStage: 'normal', wireMessageCount: 0,
      systemPromptSha256: sha({ system: 'legacy-policy', messages: [] }), workflowHintPresent: false, readonlyHintPresent: false } }, { info })
    expect(info.mock.calls[0][0]).toMatchObject({ schemaVersion: 1, availability: 'captured', requestAttemptId })
    expect(info.mock.calls[0][0]).not.toHaveProperty('mutationHintPresent')
  })

  it.each([Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('invalid count %s makes v2 capture unavailable without fabricating flags', wireMessageCount => {
    const info = vi.fn(), requestAttemptId = randomUUID()
    logRequestDispatch({ type: 'start', requestAttemptId, provider: 'mock', model: 'model', dispatchDiagnostic: {
      schemaVersion: 2, availability: 'captured', requestStage: 'normal', wireMessageCount,
      systemPromptSha256: sha('policy'), workflowHintPresent: true, readonlyHintPresent: true, mutationHintPresent: true } }, { info })
    expect(info.mock.calls[0][0]).toEqual({ event: 'llm.dispatch.start', requestAttemptId, schemaVersion: 2, availability: 'unavailable', requestStage: 'normal', wireMessageCount: 0 })
  })

  it('a local child sink failure remains best effort and does not mutate the parent logger', () => {
    const info = vi.fn(), child = vi.fn(() => { throw new Error('local sink unavailable') })
    expect(() => logRequestDispatch({ type: 'start', requestAttemptId: randomUUID(), provider: 'mock', model: 'model',
      dispatchDiagnostic: requestDispatchDiagnostic({ system: MUTATION_REPETITION_PROMPT }) }, { info, child })).not.toThrow()
    expect(child).toHaveBeenCalledWith({}, { level: 'info' }); expect(info).not.toHaveBeenCalled()
  })
})

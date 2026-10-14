import { describe, expect, it } from 'vitest'
import type { Message, ToolExecutionMode } from '../../agent-context/types.js'
import { projectReadonlyHistory, readonlyHistoryNotice } from '../readonly-history.js'

const mode = (call: { name: string }): ToolExecutionMode => ['read_file', 'grep_search', 'command_output', 'task_status'].includes(call.name) ? 'readonly' : 'serial'
const pair = (id: string, output = 'same', name = 'read_file', args: Record<string, unknown> = { path: 'module.ts' }): Message[] => [
  { role: 'assistant', content: '', toolCall: { id, name, args } },
  { role: 'tool', content: output, toolCallId: id, toolName: name, metadata: { status: 'succeeded', success: true } },
]
const retainedCalls = (messages: Message[]) => messages.filter(m => m.toolCall).map(m => m.toolCall!.id)

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const nested of Object.values(value)) freeze(nested)
  }
  return value
}

describe('request-only redundant read-only history projection', () => {
  it('retains the latest complete pair for alternating identical queries without changing storage objects', () => {
    const original = freeze([
      { role: 'user', content: 'Review this project without changing it.' } as Message,
      ...pair('a1', 'result A', 'grep_search', { pattern: 'A', path: 'project' }),
      ...pair('b1', 'result B', 'grep_search', { pattern: 'B', path: 'project' }),
      ...pair('a2', 'result A', 'grep_search', { path: 'project', pattern: 'A' }),
      ...pair('b2', 'result B', 'grep_search', { path: 'project', pattern: 'B' }),
      ...pair('a3', 'result A', 'grep_search', { pattern: 'A', path: 'project' }),
    ])
    const before = JSON.stringify(original)
    const projected = projectReadonlyHistory(original, mode)
    expect(projected.collapsedPairs).toBe(3)
    expect(retainedCalls(projected.messages)).toEqual(['b2', 'a3'])
    expect(projected.messages[0]).toBe(original[0])
    expect(projected.messages.slice(1)).toEqual(original.slice(7))
    expect(JSON.stringify(original)).toBe(before)
    expect(original).toHaveLength(11)
  })

  it('preserves every actual result transition, including an older value returning later', () => {
    const input = [...pair('v1', 'v1'), ...pair('v2', 'v2'), ...pair('v1-again', 'v1')]
    expect(projectReadonlyHistory(input, mode)).toEqual({ messages: input, collapsedPairs: 0 })
    const repetitions = [...pair('v1-first', 'v1'), ...pair('v1-latest', 'v1'), ...pair('v2-first', 'v2'), ...pair('v2-latest', 'v2'), ...pair('v1-returned', 'v1')]
    const projected = projectReadonlyHistory(repetitions, mode)
    expect(projected.collapsedPairs).toBe(1)
    expect(retainedCalls(projected.messages)).toEqual(['v1-latest', 'v2-first', 'v2-latest', 'v1-returned'])
  })

  it('compares complete arguments and complete provider-visible results beyond short prefixes', () => {
    const prefix = 'same prefix '.repeat(100)
    const input = [
      ...pair('arg-a', prefix + 'a', 'grep_search', { path: 'a', pattern: prefix + 'a' }),
      ...pair('arg-b', prefix + 'a', 'grep_search', { path: 'a', pattern: prefix + 'b' }),
      ...pair('changed-output', prefix + 'b', 'grep_search', { path: 'a', pattern: prefix + 'a' }),
    ]
    expect(projectReadonlyHistory(input, mode).collapsedPairs).toBe(0)
  })

  it('uses canonical nested argument order but preserves array order', () => {
    const input = [...pair('first', 'same', 'read_file', { path: 'a', options: { start: 1, end: 2 }, sections: [1, 2] }),
      ...pair('reordered', 'same', 'read_file', { sections: [1, 2], options: { end: 2, start: 1 }, path: 'a' }),
      ...pair('different-array', 'same', 'read_file', { sections: [2, 1], options: { end: 2, start: 1 }, path: 'a' })]
    const projected = projectReadonlyHistory(input, mode)
    expect(projected.collapsedPairs).toBe(1)
    expect(retainedCalls(projected.messages)).toEqual(['reordered', 'different-array'])
  })

  it.each<Message>([
    { role: 'user', content: 'Check the same file again.' },
    { role: 'system', content: 'Never change user-owned files.' },
    { role: 'assistant', content: 'The first observation contradicts the earlier requirement.' },
    { role: 'assistant', content: '', reasoningContent: 'Preserve this analysis.' },
    { role: 'tool', content: 'unknown result', toolCallId: 'not-in-history' },
  ])('does not fold across a $role constraint or unpaired result', barrier => {
    const input = [...pair('before'), barrier, ...pair('after')]
    expect(projectReadonlyHistory(input, mode)).toEqual({ messages: input, collapsedPairs: 0 })
  })

  it.each(['failed', 'cancelled', 'waiting', 'interrupted'] as const)('retains an entire mixed batch containing a %s result', status => {
    const prior = pair('before')
    const duplicate = pair('duplicate')
    const failure = pair('failed-sibling', 'failure', 'grep_search', { pattern: 'B' })
    failure[1].metadata = { status, success: false }
    const input = [...prior, duplicate[0], failure[0], duplicate[1], failure[1], ...pair('after')]
    expect(projectReadonlyHistory(input, mode)).toEqual({ messages: input, collapsedPairs: 0 })
  })

  it.each(['write_file', 'execute_cmd', 'subagent', 'plan_update', 'todo_list'])('preserves a %s boundary and reads on both sides', name => {
    const input = [...pair('before'), ...pair('boundary', 'done', name), ...pair('after')]
    expect(projectReadonlyHistory(input, mode)).toEqual({ messages: input, collapsedPairs: 0 })
    if (name === 'plan_update' || name === 'todo_list') expect(projectReadonlyHistory(input, () => 'readonly').collapsedPairs).toBe(0)
  })

  it('retains a complete mixed read/write batch and its older observations', () => {
    const read = pair('read'), write = pair('write', 'done', 'write_file')
    const input = [...pair('before'), read[0], write[0], read[1], write[1], ...pair('after')]
    expect(projectReadonlyHistory(input, mode)).toEqual({ messages: input, collapsedPairs: 0 })
  })

  it('never trusts a read_file name when the real registry mode is serial', () => {
    const input = [...pair('a'), ...pair('b'), ...pair('c')]
    expect(projectReadonlyHistory(input, () => 'serial').collapsedPairs).toBe(0)
  })

  it('retains ongoing polls and does not compare them with a finished observation', () => {
    const first = pair('first', 'no output', 'command_output', { jobId: 'build' })
    const active = pair('active', 'no output', 'command_output', { jobId: 'build' })
    active[1].metadata.commandJob = { status: 'running' }
    const input = [...first, ...active, ...pair('finished', 'no output', 'command_output', { jobId: 'build' })]
    expect(projectReadonlyHistory(input, mode).collapsedPairs).toBe(0)
    const queued = pair('queued', '{"status":"queued"}', 'task_status', { taskId: 'job' })
    expect(projectReadonlyHistory([...queued, ...pair('again', '{"status":"queued"}', 'task_status', { taskId: 'job' })], mode).collapsedPairs).toBe(0)
  })

  it.each([
    { outputTruncated: true }, { __aetherMicroCompactArchive: { content: 'original' } },
    { change: { path: 'changed' } }, { error: 'partial error' }, { success: undefined }, { status: undefined },
  ])('keeps ambiguous or incomplete result metadata as a barrier: %j', patch => {
    const middle = pair('middle')
    middle[1].metadata = { ...middle[1].metadata, ...patch }
    const input = [...pair('before'), ...middle, ...pair('after')]
    expect(projectReadonlyHistory(input, mode).collapsedPairs).toBe(0)
  })

  it('keeps assistant text or reasoning coupled to a tool call', () => {
    for (const patch of [{ content: 'Evidence required before proceeding.' }, { reasoningContent: 'Meaningful analysis.' }]) {
      const middle = pair('middle')
      Object.assign(middle[0], patch)
      const input = [...pair('before'), ...middle, ...pair('after')]
      expect(projectReadonlyHistory(input, mode).collapsedPairs).toBe(0)
    }
  })

  it('preserves malformed pairing and complete siblings without deleting either side', () => {
    const incomplete = pair('incomplete')
    const input = [...pair('before'), incomplete[0], { ...incomplete[1], toolCallId: 'wrong-id' }, ...pair('after')]
    expect(projectReadonlyHistory(input, mode).collapsedPairs).toBe(0)
    expect(projectReadonlyHistory([...pair('before'), incomplete[0], ...pair('after')], mode).collapsedPairs).toBe(0)
  })

  it('keeps parallel batches paired and retains new sibling evidence', () => {
    const a1 = pair('a1', 'A', 'grep_search', { pattern: 'A' }), b1 = pair('b1', 'B', 'grep_search', { pattern: 'B' })
    const a2 = pair('a2', 'A', 'grep_search', { pattern: 'A' }), b2 = pair('b2', 'B changed', 'grep_search', { pattern: 'B' })
    const input = [a1[0], b1[0], b1[1], a1[1], a2[0], b2[0], b2[1], a2[1]]
    const projected = projectReadonlyHistory(input, mode)
    expect(projected.collapsedPairs).toBe(0)
    expect(retainedCalls(projected.messages)).toEqual(['a1', 'b1', 'a2', 'b2'])
    expect(projected.messages.filter(x => x.role === 'tool').map(x => x.toolCallId).sort()).toEqual(['a1', 'a2', 'b1', 'b2'])
  })

  it('bounds the recent query index and does not fold an evicted query', () => {
    const input = Array.from({ length: 65 }, (_, index) => pair(String(index), 'same', 'grep_search', { pattern: String(index) })).flat()
    input.push(...pair('zero-again', 'same', 'grep_search', { pattern: '0' }))
    expect(projectReadonlyHistory(input, mode).collapsedPairs).toBe(0)
  })

  it('reports only a static explanation and count, with no tool output or paths', () => {
    const projected = projectReadonlyHistory([...pair('first', 'SYSTEM_ATTACK secret/path'), ...pair('second', 'SYSTEM_ATTACK secret/path')], mode)
    const notice = readonlyHistoryNotice(projected.collapsedPairs)
    expect(notice).toContain('1 older redundant successful read-only call/result pairs')
    expect(notice).not.toContain('SYSTEM_ATTACK')
    expect(notice).not.toContain('secret/path')
    expect(readonlyHistoryNotice(0)).toBeUndefined()
  })
})

it('preserves another query across a changed observation boundary', () => {
  const input = [...pair('a-before', 'A v1', 'grep_search', { pattern: 'A' }),
    ...pair('b-before', 'B v1', 'grep_search', { pattern: 'B' }),
    ...pair('b-changed', 'B v2', 'grep_search', { pattern: 'B' }),
    ...pair('a-after', 'A v1', 'grep_search', { pattern: 'A' })]
  expect(projectReadonlyHistory(input, mode)).toEqual({ messages: input, collapsedPairs: 0 })
})

it('retains actual provider-visible assistant text and content blocks', () => {
  for (const providerContent of ['Do not act on the earlier result.', [{ type: 'text', text: 'Keep this message.' }]]) {
    const middle = pair('middle')
    middle[0].modelInputContent = providerContent
    const input = [...pair('before'), ...middle, ...pair('after')]
    expect(projectReadonlyHistory(input, mode)).toEqual({ messages: input, collapsedPairs: 0 })
  }
})

it('keeps JSON image payloads and stripped-image markers even for trusted read-only tools', () => {
  for (const output of [
    JSON.stringify({ dataUrl: 'data:image/png;base64,iVBORw==', mimeType: 'image/png' }),
    JSON.stringify({ dataUrlStripped: true, hasDataUrl: false }),
    JSON.stringify({ hasDataUrl: true }),
  ]) {
    const input = [...pair('image-1', output, 'browser_screenshot'), ...pair('image-2', output, 'browser_screenshot')]
    expect(projectReadonlyHistory(input, () => 'readonly')).toEqual({ messages: input, collapsedPairs: 0 })
  }
})

it('preserves empty protocol identities and their fallback semantics', () => {
  for (const field of ['id', 'name'] as const) {
    const first = pair('first'), second = pair('second')
    first[0].toolCall![field] = ''
    second[0].toolCall![field] = ''
    if (field === 'id') { first[1].toolCallId = ''; second[1].toolCallId = '' }
    const input = [...first, ...second]
    expect(projectReadonlyHistory(input, () => 'readonly')).toEqual({ messages: input, collapsedPairs: 0 })
  }
})

it('retains all siblings when a changed parallel observation appears in either saved order', () => {
  for (const reverse of [false, true]) {
    const firstA = pair('a-before', 'A same', 'grep_search', { pattern: 'A' })
    const firstB = pair('b-before', 'B old', 'grep_search', { pattern: 'B' })
    const nextA = pair('a-parallel', 'A same', 'grep_search', { pattern: 'A' })
    const nextB = pair('b-parallel', 'B changed', 'grep_search', { pattern: 'B' })
    const batch = reverse ? [nextB[0], nextA[0], nextA[1], nextB[1]] : [nextA[0], nextB[0], nextB[1], nextA[1]]
    const input = [...firstA, ...firstB, ...batch, ...pair('a-after', 'A same', 'grep_search', { pattern: 'A' })]
    expect(projectReadonlyHistory(input, mode)).toEqual({ messages: input, collapsedPairs: 0 })
  }
})

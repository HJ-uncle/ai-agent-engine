import { describe, expect, it, vi } from 'vitest'
import type { ToolCall, ToolResult } from '../../agent-context/types.js'
import { ToolProgressTracker, toolFailureLimit } from '../tool-progress.js'

const read: ToolCall = { id: 'read', name: 'read_file', args: { path: 'shared.ts' } }
const succeeded = (output: string): ToolResult => ({ success: true, status: 'succeeded', output })
const failed = (output = 'invalid arguments'): ToolResult => ({ success: false, status: 'failed', output })

describe('output-aware progress for long-running tools', () => {
  it('keeps changed reads progressing across hundreds of identical calls', () => {
    const tracker = new ToolProgressTracker()
    for (let index = 0; index < 500; index++) expect(tracker.observe([read], [succeeded(`shared version ${index}`)])).toBe(0)
  })

  it('recognizes complete argument changes beyond the former 200-character prefix', () => {
    const tracker = new ToolProgressTracker()
    const call = (suffix: string): ToolCall => ({ id: suffix, name: 'write_file', args: { path: 'file.ts', content: 'same prefix '.repeat(100) + suffix } })
    expect(tracker.observe([call('one')], [succeeded('written')])).toBe(0)
    expect(tracker.observe([call('two')], [succeeded('written')])).toBe(0)
    expect(tracker.observe([call('two')], [succeeded('written')])).toBe(1)
  })

  it('counts unchanged successful observations and permanent failures once per batch', () => {
    const tracker = new ToolProgressTracker()
    expect(tracker.observe([read], [succeeded('same')])).toBe(0)
    expect(tracker.observe([read], [succeeded('same')])).toBe(1)
    expect(tracker.observe([read, read], [failed(), failed()])).toBe(2)
    expect(tracker.observe([read], [succeeded('new evidence')])).toBe(0)
  })

  it('ignores argument key order while retaining full output identity', () => {
    const tracker = new ToolProgressTracker()
    const first = { ...read, args: { path: 'a', options: { start: 1, end: 2 } } }
    const reordered = { ...read, args: { options: { end: 2, start: 1 }, path: 'a' } }
    expect(tracker.observe([first], [succeeded('same')])).toBe(0)
    expect(tracker.observe([reordered], [succeeded('same')])).toBe(1)
  })

  it('allows repeated empty polls while a command or queued task is actually active', () => {
    const tracker = new ToolProgressTracker()
    const command = { ...read, name: 'command_output' }
    const result = { ...succeeded('no new output'), metadata: { commandJob: { status: 'running', jobId: 'build' } } }
    for (let index = 0; index < 500; index++) expect(tracker.observe([command], [result])).toBe(0)
    const task = { ...read, name: 'task_status' }
    for (let index = 0; index < 500; index++) expect(tracker.observe([task], [succeeded('{"status":"pending"}')])).toBe(0)
    expect(tracker.observe([command], [{ ...result, metadata: { commandJob: { status: 'succeeded' } } }])).toBe(0)
    expect(tracker.observe([command], [{ ...result, metadata: { commandJob: { status: 'succeeded' } } }])).toBe(1)
  })

  it('does not count temporary network failures even beside an unchanged successful read', () => {
    const tracker = new ToolProgressTracker()
    tracker.observe([read], [succeeded('same')])
    const transient = { ...failed('temporary network timeout'), metadata: { retryable: true } }
    for (let index = 0; index < 500; index++) expect(tracker.observe([read, read], [succeeded('same'), transient])).toBe(0)
  })

  it('defaults to unlimited no-progress accounting and does not manufacture a stop from invalid legacy values', () => {
    vi.stubEnv('MAX_CONSECUTIVE_FAILURES', undefined)
    try {
      expect(toolFailureLimit(undefined)).toBe(Infinity)
      for (const value of ['', 'invalid', '0', '-8', 'Infinity', 'NaN']) expect(toolFailureLimit(value)).toBe(Infinity)
    } finally { vi.unstubAllEnvs() }
  })

  it('retains explicit positive limits for internal probes and focused tests', () => {
    expect(toolFailureLimit('12')).toBe(12)
    expect(toolFailureLimit('2.9')).toBe(2)
    vi.stubEnv('MAX_CONSECUTIVE_FAILURES', '5')
    try { expect(toolFailureLimit()).toBe(5) } finally { vi.unstubAllEnvs() }
  })
})

describe('non-terminating read-only cycle recovery', () => {
  const readonlyTracker = () => new ToolProgressTracker(call =>
    ['read_file', 'grep_search', 'command_output', 'task_status'].includes(call.name) ? 'readonly' : 'serial')
  const query = (pattern: string): ToolCall => ({ id: pattern, name: 'grep_search', args: { pattern, path: 'src' } })

  it('recognizes alternating exhausted queries only after two repeated batches', () => {
    const tracker = readonlyTracker()
    const counts = ['A', 'B', 'A', 'B'].map(pattern => {
      const count = tracker.observe([query(pattern)], [succeeded('matches ' + pattern)])
      if (pattern === 'A' || count < 2) expect(tracker.recoveryPrompt()).toBeUndefined()
      return count
    })
    expect(counts).toEqual([0, 0, 1, 2])
    expect(tracker.recoveryPrompt()).toContain('continuing the original task')
    for (let index = 0; index < 500; index++) tracker.observe([query(index % 2 ? 'B' : 'A')], [succeeded('matches ' + (index % 2 ? 'B' : 'A'))])
    expect(tracker.recoveryPrompt()).toBeDefined()
    expect(toolFailureLimit('0')).toBe(Infinity)
  })

  it('keeps changed query arguments progressing even when they return identical output', () => {
    const tracker = readonlyTracker()
    for (let index = 0; index < 500; index++) {
      const call = query('same prefix '.repeat(100) + index)
      expect(tracker.observe([call], [succeeded('no matches')])).toBe(0)
      expect(tracker.recoveryPrompt()).toBeUndefined()
    }
  })

  it('treats changing contents, including a return to an older version, as progress', () => {
    const tracker = readonlyTracker()
    for (let index = 0; index < 500; index++) {
      expect(tracker.observe([read], [succeeded('same prefix '.repeat(100) + (index % 2))])).toBe(0)
      expect(tracker.recoveryPrompt()).toBeUndefined()
    }
  })

  it('uses canonical nested arguments and clears its guidance when a new result arrives', () => {
    const tracker = readonlyTracker()
    const first = { ...read, args: { path: 'shared.ts', options: { start: 1, end: 2 } } }
    const reordered = { ...read, args: { options: { end: 2, start: 1 }, path: 'shared.ts' } }
    expect(tracker.observe([first], [succeeded('same')])).toBe(0)
    expect(tracker.observe([reordered], [succeeded('same')])).toBe(1)
    expect(tracker.observe([first], [succeeded('same')])).toBe(2)
    expect(tracker.recoveryPrompt()).toBeDefined()
    expect(tracker.observe([first], [succeeded('changed')])).toBe(0)
    expect(tracker.recoveryPrompt()).toBeUndefined()
  })

  it('bounds retained query hashes at 64 and evicts the least recently observed query', () => {
    const tracker = readonlyTracker()
    for (let index = 0; index < 64; index++) tracker.observe([query(String(index))], [succeeded('same')])
    expect(tracker.observe([query('0')], [succeeded('same')])).toBe(1)
    expect(tracker.observe([query('64')], [succeeded('same')])).toBe(0)
    expect(tracker.observe([query('0')], [succeeded('same')])).toBe(1)
    expect(tracker.observe([query('1')], [succeeded('same')])).toBe(0)
    expect(tracker.recoveryPrompt()).toBeUndefined()
    // The bounded storage holds only hashes, never the raw query or output.
    const retained = Reflect.get(tracker, 'readonlyRecent') as Map<string, string>
    expect(retained.size).toBe(64)
    expect([...retained].every(([key, value]) => /^[a-f0-9]{64}$/.test(key) && /^[a-f0-9]{64}$/.test(value))).toBe(true)
  })

  it.each(['write_file', 'execute_cmd', 'subagent'])('starts a new read epoch after a successful %s even with unchanged results', name => {
    const tracker = readonlyTracker()
    for (let index = 0; index < 3; index++) tracker.observe([read], [succeeded('same')])
    expect(tracker.recoveryPrompt()).toBeDefined()
    tracker.observe([{ ...read, name }], [succeeded('done')])
    expect(tracker.recoveryPrompt()).toBeUndefined()
    expect(tracker.observe([read], [succeeded('same')])).toBe(0)
    expect(tracker.observe([read], [succeeded('same')])).toBe(1)
  })

  it('resets before comparing reads in a mixed mutation batch', () => {
    const tracker = readonlyTracker()
    for (let index = 0; index < 3; index++) tracker.observe([read], [succeeded('same')])
    expect(tracker.observe([read, { ...read, name: 'write_file' }], [succeeded('same'), succeeded('done')])).toBe(0)
    expect(tracker.recoveryPrompt()).toBeUndefined()
  })

  it('does not classify tool names or untrusted execution modes as read-only', () => {
    const tracker = new ToolProgressTracker(() => 'serial')
    for (let index = 0; index < 500; index++) tracker.observe([query('A')], [succeeded('same')])
    expect(tracker.recoveryPrompt()).toBeUndefined()
  })

  it('excludes active polls and counts the first finished observation as new evidence', () => {
    const tracker = readonlyTracker()
    const command = { ...read, name: 'command_output' }
    const active = { ...succeeded('no new output'), metadata: { commandJob: { status: 'running' } } }
    for (let index = 0; index < 500; index++) {
      expect(tracker.observe([command], [active])).toBe(0)
      expect(tracker.recoveryPrompt()).toBeUndefined()
    }
    const done = { ...active, metadata: { commandJob: { status: 'succeeded' } } }
    expect(tracker.observe([command], [done])).toBe(0)
    expect(tracker.observe([command], [done])).toBe(1)
    expect(tracker.observe([command], [done])).toBe(2)
    expect(tracker.recoveryPrompt()).toBeDefined()
    const task = { ...read, name: 'task_status' }
    expect(tracker.observe([task], [succeeded('{"status":"queued"}')])).toBe(0)
    expect(tracker.recoveryPrompt()).toBeUndefined()
  })

  it('does not promote failed, cancelled, waiting or interrupted reads into cycle advice', () => {
    for (const status of ['failed', 'cancelled', 'waiting', 'interrupted'] as const) {
      const tracker = readonlyTracker()
      for (let index = 0; index < 4; index++) tracker.observe([read], [{ success: false, status, output: 'same' }])
      expect(tracker.recoveryPrompt()).toBeUndefined()
    }
  })

  it('respects transient infrastructure failures beside an unchanged successful read', () => {
    const tracker = readonlyTracker()
    tracker.observe([read], [succeeded('same')])
    const transient = { ...failed('temporary network timeout'), metadata: { retryable: true } }
    for (let index = 0; index < 500; index++) {
      expect(tracker.observe([read, read], [succeeded('same'), transient])).toBe(0)
      expect(tracker.recoveryPrompt()).toBeUndefined()
    }
  })
})

import { describe, expect, it } from 'vitest'
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

  it('keeps the default stop configurable and permits an explicit zero to disable it', () => {
    expect(toolFailureLimit(undefined)).toBe(8)
    expect(toolFailureLimit('')).toBe(8)
    expect(toolFailureLimit('invalid')).toBe(8)
    expect(toolFailureLimit('0')).toBe(Infinity)
    expect(toolFailureLimit('12')).toBe(12)
  })
})

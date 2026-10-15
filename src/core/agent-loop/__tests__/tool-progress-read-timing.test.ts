// Focused regression for the real hour-campaign read_file timing cycle; no historical E2E is loaded.
import { describe, expect, it } from 'vitest'
import type { ToolCall, ToolResult } from '../../agent-context/types.js'
import { ToolProgressTracker, toolFailureLimit } from '../tool-progress.js'

const read: ToolCall = { id: 'read', name: 'read_file', args: { path: 'input.json' } }
const hashA = 'sha256:' + 'a'.repeat(64)
const hashB = 'sha256:' + 'b'.repeat(64)
const monitored = (elapsed: string, content = '{"value":1}', hash = hashA, newline = '\n') =>
  `[读取监控] 耗时: ${elapsed}ms | 原始大小: 11B | 压缩后: 11B | 压缩率: 0.00%${newline}` +
  `[文件版本] ${JSON.stringify({ path: 'D:/workspace/input.json', expectedHash: hash, encoding: 'utf-8', lineEnding: 'LF', utf8Bom: false })}${newline}` +
  `[精确编辑] 展示行号和格式化内容不是原文。${newline}${newline}${content}`
const succeeded = (output: string, error?: string): ToolResult => ({ success: true, status: 'succeeded', output, ...(error ? { error } : {}) })
const failed = (output: string): ToolResult => ({ success: false, status: 'failed', output })
const tracker = () => new ToolProgressTracker(() => 'readonly')

describe('builtin read_file timing does not manufacture new evidence', () => {
  it('counts repeated unchanged contents despite changing monitor elapsed time and supplies recovery advice', () => {
    const progress = tracker()
    expect(['1.00', '8.93', '0.12', '14.01'].map(time => progress.observe([read], [succeeded(monitored(time))]))).toEqual([0, 1, 2, 3])
    expect(progress.recoveryPrompt()).toContain('same arguments and results')
  })

  it('also normalizes a valid CRLF monitor without changing its contents', () => {
    const progress = tracker()
    expect(progress.observe([read], [succeeded(monitored('1.00', '{}', hashA, '\r\n'))])).toBe(0)
    expect(progress.observe([read], [succeeded(monitored('2.00', '{}', hashA, '\r\n'))])).toBe(1)
  })

  it('clears the repeat episode when real file contents change', () => {
    const progress = tracker()
    for (const time of ['1.00', '2.00', '3.00']) progress.observe([read], [succeeded(monitored(time))])
    expect(progress.recoveryPrompt()).toBeDefined()
    expect(progress.observe([read], [succeeded(monitored('4.00', '{"value":2}'))])).toBe(0)
    expect(progress.recoveryPrompt()).toBeUndefined()
  })

  it('retains changes after the first 200 characters of the returned content', () => {
    const progress = tracker(), prefix = 'same content prefix '.repeat(40)
    expect(progress.observe([read], [succeeded(monitored('1.00', prefix + 'ONE'))])).toBe(0)
    expect(progress.observe([read], [succeeded(monitored('2.00', prefix + 'TWO'))])).toBe(0)
    expect(progress.observe([read], [succeeded(monitored('3.00', prefix + 'TWO'))])).toBe(1)
  })

  it('retains elapsed-looking numbers in actual content rather than normalizing them', () => {
    const progress = tracker()
    expect(progress.observe([read], [succeeded(monitored('1.00', 'task time: 1.00ms\n[读取监控] 耗时: 7.00ms'))])).toBe(0)
    expect(progress.observe([read], [succeeded(monitored('2.00', 'task time: 2.00ms\n[读取监控] 耗时: 8.00ms'))])).toBe(0)
  })

  it('retains a changed expectedHash even when the displayed content is identical', () => {
    const progress = tracker()
    expect(progress.observe([read], [succeeded(monitored('1.00'))])).toBe(0)
    expect(progress.observe([read], [succeeded(monitored('2.00', '{"value":1}', hashB))])).toBe(0)
  })

  it('retains other changed monitor diagnostics', () => {
    const progress = tracker()
    expect(progress.observe([read], [succeeded(monitored('1.00'))])).toBe(0)
    expect(progress.observe([read], [succeeded(monitored('2.00').replace('原始大小: 11B', '原始大小: 12B'))])).toBe(0)
  })

  it('retains canonical argument changes including values past 200 characters', () => {
    const progress = tracker(), prefix = 'a'.repeat(400)
    const first = { ...read, args: { path: prefix + '-one.json', start_line: 1 } }
    const changed = { ...read, args: { path: prefix + '-two.json', start_line: 1 } }
    expect(progress.observe([first], [succeeded(monitored('1.00'))])).toBe(0)
    expect(progress.observe([changed], [succeeded(monitored('2.00'))])).toBe(0)
    expect(progress.observe([changed], [succeeded(monitored('3.00'))])).toBe(1)
  })

  it('preserves exact JSON mode and treats changed JSON content as progress', () => {
    const progress = tracker(), exact = { ...read, args: { path: 'input.json', mode: 'exact' } }
    const output = (value: number) => JSON.stringify({ path: 'input.json', expectedHash: hashA, content: { elapsedMs: value } })
    expect(progress.observe([exact], [succeeded(output(1))])).toBe(0)
    expect(progress.observe([exact], [succeeded(output(2))])).toBe(0)
    expect(progress.observe([exact], [succeeded(output(2))])).toBe(1)
  })

  it('does not normalize failed read output fingerprints or rewrite the failure result', () => {
    const progress = tracker(), first = Object.freeze(failed(monitored('1.00'))), second = Object.freeze(failed(monitored('2.00')))
    expect(progress.observe([read], [first])).toBe(1)
    // The public failure counter increases for any permanent error, so check retained outcome identity too.
    const firstIdentities = Array.from(Reflect.get(progress, 'previous') as Set<string>)
    expect(progress.observe([read], [second])).toBe(2)
    expect(Array.from(Reflect.get(progress, 'previous') as Set<string>)).not.toEqual(firstIdentities)
    expect(second.output).toBe(monitored('2.00'))
  })

  it('preserves error identity on successful outcomes', () => {
    const progress = tracker()
    expect(progress.observe([read], [succeeded(monitored('1.00'), 'warning one')])).toBe(0)
    expect(progress.observe([read], [succeeded(monitored('2.00'), 'warning two')])).toBe(0)
  })

  it('does not interpret another tool output as builtin read instrumentation', () => {
    const progress = tracker(), call = { ...read, name: 'grep_search' }
    expect(progress.observe([call], [succeeded(monitored('1.00'))])).toBe(0)
    expect(progress.observe([call], [succeeded(monitored('2.00'))])).toBe(0)
  })

  it('does not normalize a monitor without its adjacent file version row', () => {
    const progress = tracker(), output = (time: string) => monitored(time).replace(/\[文件版本\] [^\n]+\n/, '')
    expect(progress.observe([read], [succeeded(output('1.00'))])).toBe(0)
    expect(progress.observe([read], [succeeded(output('2.00'))])).toBe(0)
  })

  it('does not normalize malformed version JSON or a non-sha256 version', () => {
    for (const change of [(output: string) => output.replace(hashA, 'not-a-file-hash'), (output: string) => output.replace('[文件版本] {', '[文件版本] {broken')]) {
      const progress = tracker()
      expect(progress.observe([read], [succeeded(change(monitored('1.00')))])).toBe(0)
      expect(progress.observe([read], [succeeded(change(monitored('2.00')))])).toBe(0)
    }
  })

  it('requires a complete engine header at the start, not matching text inside content', () => {
    const progress = tracker()
    expect(progress.observe([read], [succeeded('user prose\n' + monitored('1.00'))])).toBe(0)
    expect(progress.observe([read], [succeeded('user prose\n' + monitored('2.00'))])).toBe(0)
  })

  it('does not mutate successful model-visible output or the product unlimited default', () => {
    const progress = tracker(), output = Object.freeze(succeeded(monitored('1.00')))
    progress.observe([read], [output])
    expect(output.output).toBe(monitored('1.00'))
    expect(toolFailureLimit('')).toBe(Infinity)
  })
})

import { describe, expect, it } from 'vitest'
import type { ToolCall, ToolResult } from '../../agent-context/types.js'
import { OFFICE_RESEARCH_REVIEW_PROMPT, ToolProgressTracker, toolFailureLimit } from '../tool-progress.js'

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: name, name, args })
const success = (metadata?: Record<string, unknown>): ToolResult => ({ success: true, status: 'succeeded', output: 'untrusted tool contents', metadata })
const failure: ToolResult = { success: false, status: 'failed', output: 'failed' }
const skill = call('get_skill', { name: 'aether-office' })
const read = (index: number) => call('read_file', { path: `source-${index}.ts` })
const tracker = () => new ToolProgressTracker(item => ['read_file', 'grep', 'get_skill', 'office_inspect', 'command_output'].includes(item.name) ? 'readonly' : 'serial')
function reads(progress: ToolProgressTracker, count: number) {
  for (let i = 0; i < count; i++) progress.observe([read(i)], [success()])
}

describe('bounded Office research review', () => {
  it('reviews after six completed source queries following the actual successful Office skill load', () => {
    const progress = tracker()
    progress.observe([skill], [success()])
    reads(progress, 5)
    expect(progress.workflowReviewPrompt()).toBeUndefined()
    progress.observe([call('grep', { pattern: 'test', path: 'tests' })], [success()])
    expect(progress.workflowReviewPrompt()).toBe(OFFICE_RESEARCH_REVIEW_PROMPT)
    expect(progress.workflowReviewPrompt()).toContain('马上以已知内容完成 draft 和成品')
    expect(progress.workflowReviewPrompt()).toContain('缺少实测就标注未重跑')
    expect(progress.workflowReviewPrompt()).toContain('明确要求审计、实测或当前角色只读')
    expect(progress.workflowReviewPrompt()).not.toContain('source-')
    expect(progress.workflowReviewPrompt()).not.toContain('untrusted tool contents')
    expect(toolFailureLimit('')).toBe(Infinity)
  })

  it('retains one request-local Office reminder without multiplying it across hundreds of reads', () => {
    const progress = tracker()
    progress.observe([skill], [success()])
    reads(progress, 6)
    expect(progress.workflowReviewPrompt()).toContain(OFFICE_RESEARCH_REVIEW_PROMPT)
    progress.markWorkflowReviewDispatched()
    for (let i = 0; i < 100; i++) {
      progress.observe([read(i + 10)], [success()])
      expect(progress.workflowReviewPrompt()?.split(OFFICE_RESEARCH_REVIEW_PROMPT)).toHaveLength(2)
      progress.markWorkflowReviewDispatched()
    }
  })

  it('counts all successful queries in a batch without counting failed or active polls', () => {
    const progress = tracker()
    progress.observe([skill], [success()])
    progress.observe([read(1), read(2), read(3)], [success(), success(), failure])
    progress.observe([call('command_output')], [success({ commandJob: { status: 'running' } })])
    reads(progress, 3)
    expect(progress.workflowReviewPrompt()).toBeUndefined()
    reads(progress, 1)
    expect(progress.workflowReviewPrompt()).toBe(OFFICE_RESEARCH_REVIEW_PROMPT)
  })

  it.each(['create', 'edit', 'append_sheets', 'recalculate'])('a real successful Office %s resets and rearms the episode', operation => {
    const progress = tracker()
    progress.observe([skill], [success()])
    reads(progress, 6)
    progress.markWorkflowReviewDispatched()
    progress.observe([call('office_document', { operation, path: 'report.xlsx' })], [success({ fileMutationApplied: true })])
    expect(progress.workflowReviewPrompt()).toBeUndefined()
    reads(progress, 5)
    expect(progress.workflowReviewPrompt()).toBeUndefined()
    reads(progress, 1)
    expect(progress.workflowReviewPrompt()).toContain(OFFICE_RESEARCH_REVIEW_PROMPT)
  })

  it.each([
    [call('office_document', { operation: 'create' }), failure],
    [call('office_document', { operation: 'edit' }), success({ noChange: true, fileMutationApplied: false })],
    [call('office_document', { operation: 'inspect' }), success({ fileMutationApplied: false })],
    [call('office_inspect'), success({ fileMutationApplied: false })],
    [call('office_document', { operation: 'create' }), success()],
  ] as const)('does not mistake failed, missing-publication or inspect receipts for an output (%j)', (operation, result) => {
    const progress = tracker()
    progress.observe([skill], [success()])
    reads(progress, 5)
    progress.observe([operation], [result])
    reads(progress, 1)
    expect(progress.workflowReviewPrompt()).toContain(OFFICE_RESEARCH_REVIEW_PROMPT)
  })

  it('does not withdraw or duplicate its active reminder after inspections or a failed write', () => {
    const progress = tracker()
    progress.observe([skill], [success()])
    reads(progress, 6)
    progress.markWorkflowReviewDispatched()
    progress.observe([call('office_document', { operation: 'inspect' }), call('office_document', { operation: 'create' })],
      [success({ fileMutationApplied: false }), failure])
    reads(progress, 12)
    expect(progress.workflowReviewPrompt()?.split(OFFICE_RESEARCH_REVIEW_PROMPT)).toHaveLength(2)
  })

  it('plain code work, a failed load or another skill never activates the Office reminder', () => {
    for (const load of [undefined, { call: skill, result: failure }, { call: call('get_skill', { name: 'code-review' }), result: success() }]) {
      const progress = tracker()
      if (load) progress.observe([load.call], [load.result])
      reads(progress, 100)
      expect(progress.workflowReviewPrompt()).not.toContain(OFFICE_RESEARCH_REVIEW_PROMPT)
    }
  })

  it('a new turn starts unarmed and reloading the same skill does not erase pending research', () => {
    const progress = tracker()
    progress.observe([skill], [success()])
    reads(progress, 5)
    progress.observe([skill], [success()])
    reads(progress, 1)
    expect(progress.workflowReviewPrompt()).toContain(OFFICE_RESEARCH_REVIEW_PROMPT)
    const next = tracker()
    reads(next, 6)
    expect(next.workflowReviewPrompt()).toBeUndefined()
  })
})

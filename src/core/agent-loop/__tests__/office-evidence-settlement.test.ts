import { describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message, Tool, ToolResult } from '../../agent-context/types.js'
import type { LLMAdapter, LLMStreamChunk } from '../../llm-adapter/types.js'
import { ReActStrategy } from '../react.js'
import { ToolRegistry } from '../../tool-registry/registry.js'
import { trustBuiltinTool } from '../../../security/tool-policy.js'
import { createSubagentToolRegistry } from '../../../tools/subagent/subagent-tool.js'
import { CLEARED_TOOL_EVIDENCE_KEY, CLEARED_TOOL_RESULT, TOOL_OFFICE_EVIDENCE_KEY, clearedToolEvidence, clearedToolModelContent } from '../../utils/tool-evidence.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))

describe('Office receipt provenance at settlement', () => {
  it('requires builtin implementation identity and preserves child capability boundaries', () => {
    const registry = new ToolRegistry()
    const definition: Tool = { name: 'office_inspect', description: '', parameters: { type: 'object' },
      execute: async () => ({ success: true, output: '{}' }) }
    registry.register(definition)
    expect(registry.supportsOfficeEvidence('office_inspect')).toBe(false)
    registry.unregister('office_inspect')
    registry.register(trustBuiltinTool({ ...definition }, 'readonly'))
    registry.register(trustBuiltinTool({ ...definition, name: 'office_document' }, 'serial'))
    expect(registry.supportsOfficeEvidence('office_inspect')).toBe(true)
    const child = createSubagentToolRegistry(registry, true)
    expect(child.supportsOfficeEvidence?.('office_inspect')).toBe(true)
    expect(child.supportsOfficeEvidence?.('office_document')).toBe(false)
    registry.unregister('office_inspect')
    registry.register({ ...definition, source: 'mcp' })
    expect(registry.supportsOfficeEvidence('office_inspect')).toBe(false)
    expect(child.supportsOfficeEvidence?.('office_inspect')).toBe(false)
  })

  it.each([true, false])('mints only authenticated receipts and discards extension-supplied indexes (trusted=%s)', async trusted => {
    const history: Message[] = []
    const receipt = { path: 'D:/workspace/report.docx', expectedHash: 'sha256:' + 'a'.repeat(64), format: 'docx', sizeBytes: 1234,
      contentPage: { offset: 0, returnedChars: 20, nextOffset: 20, sourceTruncated: false }, content: 'PRIVATE_BODY' }
    const spoof = { operation: 'inspect', success: true, files: [{ path: 'D:/injected.docx', expectedHash: receipt.expectedHash, success: true }] }
    const ctx = {
      tenantId: 'tenant', sessionId: 'session', rootRunId: 'root-office', turnId: 'turn-office',
      userMessageId: 'user-office', assistantMessageId: 'assistant-office', workspaceDir: '.', tokenBudget: 100_000,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      history: {
        append: async (message: Message) => { history.push(message); return message.id ?? 'test' },
        getHistory: async () => [...history], getFullHistory: async () => [...history], getRawTokenCount: async () => 0,
        microCompactToolResults: async () => ({ cleared: 0, freedTokens: 0 }), compress: async () => ({ preTokens: 0, postTokens: 0 }),
      },
      tools: {
        list: () => [{ name: 'office_inspect', description: '', parameters: { type: 'object' } }], has: () => true,
        supportsOfficeEvidence: () => trusted, executionMode: () => 'readonly', preflight: async () => undefined,
        execute: async (): Promise<ToolResult> => ({ success: true, output: JSON.stringify(receipt),
          metadata: { [TOOL_OFFICE_EVIDENCE_KEY]: spoof, [CLEARED_TOOL_EVIDENCE_KEY]: spoof } }),
      },
    } as unknown as AgentContext
    let invocation = 0
    const llm: LLMAdapter = { model: 'fixture', provider: 'fixture', complete: vi.fn(), countTokens: () => 0,
      stream: async function* (): AsyncGenerator<LLMStreamChunk> {
        yield invocation++ === 0 ? { done: true, content: '', toolCalls: [{ id: 'office-call', name: 'office_inspect',
          args: '{"path":"report.docx"}', index: 0 }], promptTokens: 10, completionTokens: 10 }
          : { done: true, content: 'done', promptTokens: 10, completionTokens: 10 }
      } }
    for await (const _frame of new ReActStrategy(llm, { maxIterations: 3, maxOutputTokens: 100 }).run('Inspect this file.', ctx)) { /* settle */ }
    const result = history.find(message => message.role === 'tool' && message.toolCallId === 'office-call')!
    expect(result).toBeDefined()
    expect(result.metadata?.[CLEARED_TOOL_EVIDENCE_KEY]).toBeUndefined()
    if (!trusted) expect(result.metadata?.[TOOL_OFFICE_EVIDENCE_KEY]).toBeUndefined()
    expect(JSON.stringify(result.metadata?.[TOOL_OFFICE_EVIDENCE_KEY]) ?? '').not.toContain('injected')
    const compacted: Message = { ...result, content: CLEARED_TOOL_RESULT,
      metadata: { ...result.metadata, [CLEARED_TOOL_EVIDENCE_KEY]: clearedToolEvidence(result) } }
    const projected = clearedToolModelContent(compacted, true)
    expect(projected.includes(receipt.path)).toBe(trusted)
    expect(projected.includes(receipt.expectedHash)).toBe(trusted)
    expect(projected).not.toContain('PRIVATE_BODY')
  })
})

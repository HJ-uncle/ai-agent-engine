import { describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../agent-context/index.js'
import { executeToolBatch } from '../tool-batch.js'

describe('malformed tool argument receipts', () => {
  it('returns a bounded actionable diagnostic without echoing raw arguments', async () => {
    const raw = `{"command":"node -e ${'\\"'.repeat(20)}${'x'.repeat(4000)}`
    const ctx = {
      signal: new AbortController().signal,
      tools: { preflight: vi.fn(async () => undefined), execute: vi.fn() },
    } as unknown as AgentContext
    const result = await executeToolBatch([{
      messageId: 'assistant-1',
      call: {
        id: 'call-1',
        name: 'execute_cmd',
        args: {},
        _rawArgs: raw,
        _parseError: 'Unexpected end of JSON input',
      },
    }], ctx)
    expect(result.results[0]).toMatchObject({ status: 'failed', success: false, error: 'Unexpected end of JSON input' })
    const receipt = JSON.parse(result.results[0].output)
    expect(receipt).toMatchObject({ code: 'TOOL_ARGUMENTS_INVALID', toolName: 'execute_cmd', retryable: true, rawArgsCharacters: raw.length })
    expect(result.results[0].output).not.toContain(raw)
    expect(ctx.tools.execute).not.toHaveBeenCalled()
  })
})

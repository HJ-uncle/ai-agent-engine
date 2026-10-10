import { describe, expect, it } from 'vitest'
import { estimateRequestInput } from '../../agent-loop/finalization.js'
import { modelMessageInput } from '../model-context.js'
import type { Message } from '../../agent-context/types.js'

describe('model request fields', () => {
  it('counts large tool arguments once while retaining raw replay evidence', () => {
    const args = { filePath: 'src/feature.ts', fileContent: 'export const feature = true\n'.repeat(8_000) }
    const toolCall = { id: 'write', name: 'write_file', args,
      _rawArgs: JSON.stringify(args), diagnosticPayload: 'private replay data '.repeat(8_000) }
    const message: Message = { role: 'assistant', content: '', toolCall }
    const projected: Message = { ...message, toolCall: { id: toolCall.id, name: toolCall.name, args } }
    expect(modelMessageInput(message).toolCall).toEqual(projected.toolCall)
    expect(estimateRequestInput([message], undefined, [])).toBe(estimateRequestInput([projected], undefined, []))
    expect(estimateRequestInput([{ ...projected, toolCall: { ...projected.toolCall!, args: {} } }], undefined, []))
      .toBeLessThan(estimateRequestInput([message], undefined, []) / 100)
    expect(message.toolCall).toBe(toolCall)
    expect(toolCall._rawArgs).toBe(JSON.stringify(args))
  })
})

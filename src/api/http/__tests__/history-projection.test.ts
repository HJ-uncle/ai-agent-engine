import { describe, expect, it } from 'vitest'
import { publicHistoryMessages } from '../history-projection.js'

describe('public history projection', () => {
  it('keeps UI display, identity and tool metadata without sending duplicate provider attachment snapshots', () => {
    const messages = [{ id: 'user-attachment', role: 'user' as const, content: 'Uploaded design.pdf', modelInputContent: 'A large extracted private document', metadata: { turnId: 'turn', attachments: [{ name: 'design.pdf' }] } },
      { id: 'tool', role: 'tool' as const, content: 'Actual visible result', toolCallId: 'tool-call', metadata: { commandJob: { status: 'succeeded' } } }]
    const result = publicHistoryMessages(messages)
    expect(result[0]).toEqual({ id: 'user-attachment', role: 'user', content: 'Uploaded design.pdf', metadata: messages[0].metadata })
    expect(result[1]).toEqual(messages[1])
    expect(result.some(message => 'modelInputContent' in message)).toBe(false)
    expect(messages[0].modelInputContent).toBe('A large extracted private document')
  })
})

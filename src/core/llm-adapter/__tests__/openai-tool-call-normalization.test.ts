import { describe, expect, it } from 'vitest'
import { parseXmlToolCalls } from '../openai.js'

describe('OpenAI-compatible XML tool calls', () => {
  it('normalizes legacy content on an inferred write_file call', () => {
    const [call] = parseXmlToolCalls('<tool_call><function=><parameter=path>"src/App.tsx"</parameter><parameter=content>"export {}"</parameter></function></tool_call>')
    expect(call).toMatchObject({ name: 'write_file', args: { path: 'src/App.tsx', data: 'export {}' } })
    expect(call?.args).not.toHaveProperty('content')
  })

  it('infers write_file from the canonical data parameter as well', () => {
    const [call] = parseXmlToolCalls('<tool_call><function=><parameter=path>"src/App.tsx"</parameter><parameter=data>"export {}"</parameter></function></tool_call>')
    expect(call).toMatchObject({ name: 'write_file', args: { path: 'src/App.tsx', data: 'export {}' } })
  })
})

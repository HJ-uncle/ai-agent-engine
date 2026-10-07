import { describe, expect, it } from 'vitest'
import type { AgentContext } from '../../agent-context/index.js'
import { parseXmlToolCalls } from '../openai.js'
import { writeFileTool } from '../../../tools/file/super-file-tool.js'
import { normalizeWriteFileArgs } from '../../../shared/write-file-args.js'

const noContext = {} as AgentContext

describe('write_file XML fallback arguments', () => {
  it('maps content in the JSON-shaped XML fallback as well', () => {
    const calls = parseXmlToolCalls(
      '<tool_call>{"name":"write_file","arguments":{"path":"settings.json","content":{"enabled":true}}}</tool_call>',
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ name: 'write_file', args: { path: 'settings.json', data: { enabled: true } } })
    expect(calls[0].args).not.toHaveProperty('content')
  })

  it.each([
    { args: { path: 'missing-data.txt' }, label: 'missing data and content' },
    { args: { path: 'missing-data.txt', data: undefined }, label: 'undefined data' },
    { args: { path: 'missing-data.txt', content: undefined }, label: 'undefined content' },
  ])('returns a clear validation error when $label', async ({ args }) => {
    const normalized = normalizeWriteFileArgs(args)
    expect(normalized).toMatchObject({ ok: false, error: { code: 'WRITE_INVALID_ARGUMENTS' } })

    const result = await writeFileTool.execute(args, noContext)
    expect(result).toMatchObject({
      success: false,
      error: 'WRITE_INVALID_ARGUMENTS',
      metadata: { code: 'WRITE_INVALID_ARGUMENTS', fileMutationApplied: false },
    })
    expect(result.output).toContain('requires data')
  })
})

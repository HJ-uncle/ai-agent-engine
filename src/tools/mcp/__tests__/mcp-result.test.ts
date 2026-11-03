import { describe, expect, it } from 'vitest'
import { renderMcpResult } from '../result.js'

describe('MCP content preservation', () => {
  it('keeps existing text-only output compact', () => {
    expect(renderMcpResult({ content: [{ type: 'text', text: 'alpha' }, { type: 'text', text: 'beta' }] })).toBe('alpha\nbeta')
    expect(renderMcpResult({ result: 'legacy' })).toBe('legacy')
  })

  it('does not drop structuredContent when the server also provides text', () => {
    const result = { content: [{ type: 'text', text: '2 rows' }], structuredContent: { rows: [{ value: 1 }, { value: 2 }] } }
    expect(JSON.parse(renderMcpResult(result))).toMatchObject(result)
  })

  it('preserves resource/image envelopes without claiming native media delivery', () => {
    const result = { content: [{ type: 'image', mimeType: 'image/png', data: 'dGVzdA==' },
      { type: 'resource_link', uri: 'test://file', name: 'file' }] }
    const rendered = JSON.parse(renderMcpResult(result))
    expect(rendered.content).toEqual(result.content)
    expect(rendered.contentDelivery).toBe('structured-data-not-native-media')
  })

  it('propagates a standard MCP isError for REST and JSON-RPC alike', () => {
    expect(() => renderMcpResult({ isError: true, content: [{ type: 'text', text: 'authorization failed' }] })).toThrow('authorization failed')
    expect(() => renderMcpResult({ isError: true, structuredContent: { code: 'MISSING_PAGE' } })).toThrow('MISSING_PAGE')
  })
})

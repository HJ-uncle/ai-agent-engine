/** Large payloads must survive the real generic output cap as JSON with honest continuation metadata. */
import { describe, expect, it } from 'vitest'
import { fitBrowserNetworkOutput } from '../network-output.js'
import { truncateToolOutput } from '../../../core/agent-loop/react.js'
const detail = (text: string) => ({
  tab: { tabId: 'tab-one', navigationId: 12 },
  entry: { id: 'request-stable:2', method: 'POST', url: 'https://example.test/api', status: 200 },
  request: { headers: [], query: [], cookies: [], body: { state: 'empty', offset: 0, returnedChars: 0, hasMore: false } },
  response: { headers: [], cookies: [], body: { state: 'available', text, offset: 100, totalChars: 200000, returnedChars: text.length, hasMore: true, nextOffset: 100 + text.length } },
  timing: { receiveHeadersEnd: 10 }, warnings: [],
})
const result = (value: unknown) => ({ success: true, output: JSON.stringify(value) })

describe('structured browser network output budget', () => {
  it('shortens large Chinese/escaped body pages without breaking JSON or losing the exact next cursor', () => {
    const text = '中文😀"引号"\n'.repeat(10000)
    const source = detail(text)
    const fitted = fitBrowserNetworkOutput(result(source), 'network_request', { bodyTarget: 'response' }, 8192)
    expect(fitted.success).toBe(true)
    expect(fitted.output.length).toBeLessThanOrEqual(8192)
    const delivered = truncateToolOutput(fitted.output, 8192)
    expect(delivered).toBe(fitted.output)
    const output = JSON.parse(delivered)
    expect(output.entry.id).toBe(source.entry.id)
    expect(output.tab).toEqual(source.tab)
    expect(output.response.body).toMatchObject({ state: 'available', offset: 100, totalChars: 200000, hasMore: true, truncated: true })
    expect(output.response.body.returnedChars).toBe(output.response.body.text.length)
    expect(output.response.body.nextOffset).toBe(100 + output.response.body.text.length)
    expect(text.startsWith(output.response.body.text)).toBe(true)
    expect(output.response.body.text.length).toBeGreaterThan(0)
    expect(output.warnings.join(' ')).toContain('预算')
    // UTF-8 may be larger; the actual generic cap is explicitly character based.
    expect(Buffer.byteLength(fitted.output, 'utf8')).toBeGreaterThan(fitted.output.length)
  })

  it('bounds many large headers/query/cookies without disguising omitted metadata as complete', () => {
    const source = detail('正文"😀\n'.repeat(12000))
    const headers = Array.from({ length: 1500 }, (_, index) => ({ name: 'X-Header-' + index, value: '很长的头信息'.repeat(800) }))
    const input = { ...source,
      request: { ...source.request, headers, query: headers, cookies: headers },
      response: { ...source.response, headers, cookies: headers },
      initiator: { type: 'script', stack: headers },
    }
    const fitted = fitBrowserNetworkOutput(result(input), 'network_request', { bodyTarget: 'response' }, 65536)
    const output = JSON.parse(truncateToolOutput(fitted.output, 65536))
    expect(fitted.success).toBe(true)
    expect(fitted.output.length).toBeLessThanOrEqual(65536)
    expect(output.entry.id).toBe('request-stable:2')
    expect(output.response.body.nextOffset).toBe(100 + output.response.body.returnedChars)
    expect(output.response.body.text.length).toBe(output.response.body.returnedChars)
    expect(output.warnings.join(' ')).toContain('不能视为完整')
    expect(output.request.headers.length).toBeLessThan(headers.length)
  })

  it('retains the unselected body as an honest small page and can target the request body', () => {
    const source = detail('响应正文'.repeat(10000))
    const requestText = '请求正文'.repeat(10000)
    const requestBody = { state: 'available', text: requestText, offset: 200, returnedChars: requestText.length, totalChars: 80000, hasMore: true, nextOffset: 200 + requestText.length }
    const fitted = fitBrowserNetworkOutput(result({ ...source, request: { ...source.request, body: requestBody } }), 'network_request', { bodyTarget: 'request' }, 8192)
    const output = JSON.parse(fitted.output)
    expect(output.response.body.text.length).toBeLessThanOrEqual(256)
    expect(output.response.body.nextOffset).toBe(100 + output.response.body.text.length)
    expect(output.request.body.text.length).toBeGreaterThan(256)
    expect(output.request.body.nextOffset).toBe(200 + output.request.body.text.length)
    expect(output.request.body.returnedChars).toBe(output.request.body.text.length)
  })

  it.each(['pending', 'unavailable', 'binary', 'too-large', 'empty'])('keeps %s state and reason when large surrounding metadata is shortened', state => {
    const source = detail('')
    const body = { state, reason: '实际捕获状态说明', offset: 0, returnedChars: 0, hasMore: false, truncated: state === 'too-large' }
    const headers = Array.from({ length: 600 }, (_, index) => ({ name: String(index), value: 'head'.repeat(1000) }))
    const fitted = fitBrowserNetworkOutput(result({ ...source, response: { ...source.response, headers, body } }), 'network_request', {}, 8192)
    expect(fitted.success).toBe(true)
    expect(JSON.parse(fitted.output).response.body).toEqual(body)
  })

  it('does not lose the selected body tail if reducing metadata makes the full page fit', () => {
    const source = detail('完整的小正文😀')
    const headers = Array.from({ length: 400 }, (_, index) => ({ name: String(index), value: 'head'.repeat(1000) }))
    const fitted = fitBrowserNetworkOutput(result({ ...source, response: { ...source.response, headers } }), 'network_request', {}, 8192)
    expect(JSON.parse(fitted.output).response.body).toEqual(source.response.body)
  })

  it('reduces network list rows with a matching continuation offset rather than skipping omitted requests', () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({ id: 'stable-' + index, method: 'GET', url: 'https://example.test/' + '中文'.repeat(300), status: 200 }))
    const fitted = fitBrowserNetworkOutput(result({ tab: { tabId: 't' }, entries, offset: 50, limit: 100, total: 300, captured: 500, dropped: 20, hasMore: true, nextOffset: 150 }), 'network', {}, 8192)
    const output = JSON.parse(truncateToolOutput(fitted.output, 8192))
    expect(fitted.success).toBe(true)
    expect(output.entries.length).toBeGreaterThan(0)
    expect(output.entries.length).toBeLessThan(100)
    expect(output.entries.map((entry: { id: string }) => entry.id)).toEqual(entries.slice(0, output.entries.length).map(entry => entry.id))
    expect(output).toMatchObject({ total: 300, captured: 500, dropped: 20, hasMore: true, nextOffset: 50 + output.entries.length })
  })

  it('makes unavailable request errors visible to the model instead of returning null', () => {
    const fitted = fitBrowserNetworkOutput({ success: false, output: 'null', error: '请求已被淘汰或不存在' }, 'network_request', { requestId: 'missing' }, 8192)
    expect(fitted.success).toBe(false)
    expect(JSON.parse(fitted.output)).toEqual({ success: false, requestId: 'missing', error: '请求已被淘汰或不存在' })
  })

  it('passes small structured results through unchanged and fails honestly when identity alone exceeds the cap', () => {
    const small = result(detail('small'))
    expect(fitBrowserNetworkOutput(small, 'network_request', {}, 8192)).toBe(small)
    const huge = { ...detail(''), entry: { id: 'x'.repeat(10000) } }
    const fitted = fitBrowserNetworkOutput(result(huge), 'network_request', {}, 256)
    expect(fitted).toMatchObject({ success: false, metadata: { code: 'BROWSER_NETWORK_OUTPUT_LIMIT' } })
    expect(() => JSON.parse(truncateToolOutput(fitted.output, 256))).not.toThrow()
  })
})

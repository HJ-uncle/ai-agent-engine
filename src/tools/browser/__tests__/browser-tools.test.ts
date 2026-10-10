/** Real tool validation and real provider message conversion: screenshots must become image blocks. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../../core/agent-context/index.js'
import { browserTools } from '../browser-tools.js'
import { browserBridge } from '../browser-bridge.js'
import { OpenAIAdapter } from '../../../core/llm-adapter/openai.js'
import { AnthropicAdapter } from '../../../core/llm-adapter/anthropic.js'
import { createToolRegistry } from '../../registry-factory.js'
import { createSubagentToolRegistry } from '../../subagent/subagent-tool.js'

const ctx = { tenantId: 'test', sessionId: 'chat', rootSessionId: 'root-chat', modelName: 'gpt-4o', modelCaps: { vision: true } } as AgentContext
const tool = (name: string) => browserTools.find(candidate => candidate.name === name)!
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8k0AAAAASUVORK5CYII='
const imageOutput = JSON.stringify({ tab: { tabId: 'tab-1', navigationId: 7 }, mimeType: 'image/png', dataUrl: `data:image/png;base64,${png}`, width: 1, height: 1 })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); browserBridge.dispose() })

describe('browser tool contracts', () => {
  it('forwards validated arguments while deriving scope from context rather than model input', async () => {
    const execute = vi.spyOn(browserBridge, 'execute').mockResolvedValue({ success: true, output: '{"clicked":true}' })
    expect(await tool('browser_click').execute({ tabId: 'tab-1', navigationId: 7, ref: 'e1' }, ctx)).toMatchObject({ success: true })
    expect(execute).toHaveBeenCalledWith('click', { tabId: 'tab-1', navigationId: 7, ref: 'e1' }, ctx)
    expect(await tool('browser_click').execute({ tabId: 'tab-1', navigationId: 7, ref: 'e1', sessionId: 'other' }, ctx)).toMatchObject({ success: false, metadata: { code: 'BROWSER_INVALID_ARGUMENTS' } })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it.each([
    { ref: 'e12' },
    { selector: '#board' },
    { x: 0, y: 50 },
    { x: 100000, y: 100000 },
  ])('forwards one valid click target unchanged: %j', async target => {
    const execute = vi.spyOn(browserBridge, 'execute').mockResolvedValue({ success: true, output: '{"clicked":true}' })
    const args = { tabId: 'tab-1', navigationId: 7, ...target }
    expect(await tool('browser_click').execute(args, ctx)).toMatchObject({ success: true })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith('click', args, ctx)
  })

  it('explains incomplete coordinates without dispatching a browser action', async () => {
    const execute = vi.spyOn(browserBridge, 'execute')
    const result = await tool('browser_click').execute({ tabId: 'tab-1', navigationId: 7, x: 12 }, ctx)
    expect(result).toMatchObject({ success: false, metadata: { code: 'BROWSER_INVALID_ARGUMENTS' } })
    expect(result.output).toContain('同时提供 x 和 y')
    expect(result.output).toContain('最新 snapshot')
    expect(execute).not.toHaveBeenCalled()
  })

  it('identifies missing navigationId without dispatching a browser action', async () => {
    const execute = vi.spyOn(browserBridge, 'execute')
    const result = await tool('browser_click').execute({ tabId: 'tab-1', ref: 'e12' }, ctx)
    expect(result).toMatchObject({ success: false, metadata: { code: 'BROWSER_INVALID_ARGUMENTS' } })
    expect(result.output).toContain('navigationId: Required')
    expect(execute).not.toHaveBeenCalled()
  })

  it('forwards network filters and defaults before preserving native pagination metadata', async () => {
    const output = JSON.stringify({ entries: [{ id: 'network:one', method: 'GET', status: 404 }], total: 13, captured: 100, dropped: 4, offset: 5, limit: 1, hasMore: true, nextOffset: 6 })
    const execute = vi.spyOn(browserBridge, 'execute').mockResolvedValue({ success: true, output })
    const query = { url: '/api/', method: 'GET', resourceType: 'Fetch', status: '4xx', failedOnly: true, minDurationMs: 20, offset: 5, limit: 1 }
    expect(await tool('browser_network').execute({ tabId: 'tab', query }, ctx)).toEqual({ success: true, output })
    expect(execute).toHaveBeenCalledWith('network', { tabId: 'tab', query }, ctx)
    await tool('browser_network').execute({ tabId: 'tab' }, ctx)
    expect(execute).toHaveBeenLastCalledWith('network', { tabId: 'tab', query: { offset: 0, limit: 50 } }, ctx)
  })

  it('applies the same configured Code output budget before the generic loop sees network JSON', async () => {
    const previous = process.env.CODE_TOOL_OUTPUT_MAX_CHARS
    process.env.CODE_TOOL_OUTPUT_MAX_CHARS = '8192'
    try {
      const text = '中文"换行\\n'.repeat(12000)
      const output = JSON.stringify({ tab: { tabId: 't' }, entry: { id: 'network:budget' },
        request: { body: { state: 'empty', offset: 0, returnedChars: 0, hasMore: false } },
        response: { body: { state: 'available', text, offset: 20, returnedChars: text.length, totalChars: text.length + 20, hasMore: false } } })
      vi.spyOn(browserBridge, 'execute').mockResolvedValue({ success: true, output })
      const result = await tool('browser_network_request').execute({ tabId: 't', requestId: 'network:budget' }, { ...ctx, toolProfile: 'code' })
      expect(result.success).toBe(true)
      expect(result.output.length).toBeLessThanOrEqual(8192)
      const delivered = JSON.parse(result.output)
      expect(delivered.entry.id).toBe('network:budget')
      expect(delivered.response.body.nextOffset).toBe(20 + delivered.response.body.returnedChars)
      expect(delivered.response.body.truncated).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.CODE_TOOL_OUTPUT_MAX_CHARS
      else process.env.CODE_TOOL_OUTPUT_MAX_CHARS = previous
    }
  })

  it.each(['200', '4xx', 'failed', 'pending'])('accepts documented status filter %s', async status => {
    const execute = vi.spyOn(browserBridge, 'execute').mockResolvedValue({ success: true, output: '{}' })
    await tool('browser_network').execute({ tabId: 'tab', query: { status } }, ctx)
    expect(execute).toHaveBeenCalledWith('network', { tabId: 'tab', query: { status, offset: 0, limit: 50 } }, ctx)
  })

  it('maps request details to network_detail and keeps network request identity inside args', async () => {
    const execute = vi.spyOn(browserBridge, 'execute').mockResolvedValue({ success: true, output: '{"entry":{"id":"cdp:123"},"response":{"body":{"state":"binary","reason":"not text"}}}' })
    await tool('browser_network_request').execute({ tabId: 'tab', requestId: 'cdp:123' }, ctx)
    expect(execute).toHaveBeenCalledWith('network_detail', { tabId: 'tab', requestId: 'cdp:123', bodyTarget: 'response', bodyOffset: 0, bodyLimit: 12000 }, ctx)
    await tool('browser_network_request').execute({ tabId: 'tab', requestId: 'cdp:123', bodyTarget: 'request', bodyOffset: 12000, bodyLimit: 60000 }, ctx)
    expect(execute).toHaveBeenLastCalledWith('network_detail', { tabId: 'tab', requestId: 'cdp:123', bodyTarget: 'request', bodyOffset: 12000, bodyLimit: 60000 }, ctx)
  })

  it.each([
    ['browser_network', { tabId: 't', query: { offset: -1 } }],
    ['browser_network', { tabId: 't', query: { limit: 0 } }],
    ['browser_network', { tabId: 't', query: { limit: 101 } }],
    ['browser_network', { tabId: 't', query: { status: '999' } }],
    ['browser_network', { tabId: 't', query: { status: 'success' } }],
    ['browser_network', { tabId: 't', query: { minDurationMs: -1 } }],
    ['browser_network', { tabId: 't', query: { sessionId: 'another-owner' } }],
    ['browser_network_request', { tabId: 't', requestId: '' }],
    ['browser_network_request', { tabId: 't', requestId: 'r', bodyTarget: 'headers' }],
    ['browser_network_request', { tabId: 't', requestId: 'r', bodyOffset: -1 }],
    ['browser_network_request', { tabId: 't', requestId: 'r', bodyLimit: 0 }],
    ['browser_network_request', { tabId: 't', requestId: 'r', bodyLimit: 60001 }],
    ['browser_network_request', { tabId: 't', requestId: 'r', sessionId: 'another-owner' }],

    ['browser_click', { tabId: 't', ref: 'e' }],
    ['browser_click', { tabId: 't', navigationId: 0, x: 1 }],
    ['browser_click', { tabId: 't', navigationId: 0, x: 1, y: 2, selector: 'button' }],
    ['browser_click', { tabId: 't', navigationId: 0, y: 2 }],
    ['browser_click', { tabId: 't', navigationId: 0 }],
    ['browser_click', { tabId: 't', navigationId: 0, ref: '' }],
    ['browser_click', { tabId: 't', navigationId: 0, selector: '' }],
    ['browser_click', { tabId: 't', navigationId: 0, ref: 'e1', selector: '#board' }],
    ['browser_click', { tabId: 't', navigationId: 0, ref: 'e1', x: 1 }],
    ['browser_click', { tabId: 't', navigationId: 0, ref: 'e1', x: 1, y: 2 }],
    ['browser_click', { tabId: 't', navigationId: 0, ref: 'e'.repeat(129) }],
    ['browser_click', { tabId: 't', navigationId: 0, selector: 'x'.repeat(2001) }],
    ['browser_click', { tabId: 't', navigationId: 0, x: -1, y: 0 }],
    ['browser_click', { tabId: 't', navigationId: 0, x: 0, y: 100001 }],
    ['browser_click', { tabId: 't', navigationId: -1, ref: 'e1' }],
    ['browser_fill', { tabId: 't', navigationId: 0, text: 'value' }],
    ['browser_fill', { tabId: 't', navigationId: 0, text: 'value', ref: 'a', selector: 'input' }],
    ['browser_scroll', { tabId: 't', deltaY: 100 }],
    ['browser_press_key', { tabId: 't', key: 'Enter' }],
    ['browser_set_viewport', { tabId: 't', viewport: { width: -1, height: 600, mobile: false, deviceScaleFactor: 1 } }],
    ['browser_set_viewport', { tabId: 't', viewport: { width: 390, height: 200, mobile: true, deviceScaleFactor: 1 } }],
    ['browser_set_viewport', { tabId: 't', viewport: { width: 390, height: 600, mobile: true, deviceScaleFactor: 0.5 } }],
    ['browser_set_viewport', { tabId: 't', viewport: { width: 390, height: 600, mobile: true, deviceScaleFactor: 4 } }],
    ['browser_wait', { tabId: 't', timeoutMs: 60_000 }],
    ['browser_wait', { tabId: 't', timeoutMs: 1000 }],
    ['browser_scroll', { tabId: 't', navigationId: 0, deltaY: 10001 }],
    ['browser_press_key', { tabId: 't', navigationId: 0, key: 'a'.repeat(81) }],
    ['browser_console', { tabId: 't', clear: true }],
    ['browser_navigate', { tabId: 't', direction: 'back' }],
  ])('rejects invalid/stale-operation shape %s %j before reaching the client', async (name, args) => {
    const execute = vi.spyOn(browserBridge, 'execute')
    expect(await tool(name).execute(args, ctx)).toMatchObject({ success: false, metadata: { code: 'BROWSER_INVALID_ARGUMENTS' } })
    expect(execute).not.toHaveBeenCalled()
  })

  it('maps viewport to the native action and supports clearing emulation', async () => {
    const execute = vi.spyOn(browserBridge, 'execute').mockResolvedValue({ success: true, output: '{}' })
    expect(await tool('browser_set_viewport').execute({ tabId: 't', viewport: null }, ctx)).toMatchObject({ success: true })
    expect(execute).toHaveBeenCalledWith('viewport', { tabId: 't', viewport: null }, ctx)
    const viewport = { width: 3840, height: 3840, mobile: false, deviceScaleFactor: 3 }
    expect(await tool('browser_set_viewport').execute({ tabId: 't', viewport }, ctx)).toMatchObject({ success: true })
    expect(execute).toHaveBeenLastCalledWith('viewport', { tabId: 't', viewport }, ctx)
  })

  it('reports unavailable clients honestly and does not deliver images to text-only models', async () => {
    expect(await tool('browser_tabs').execute({}, ctx)).toMatchObject({ success: false, metadata: { code: 'BROWSER_CLIENT_UNAVAILABLE' } })
    const execute = vi.spyOn(browserBridge, 'execute')
    expect(await tool('browser_screenshot').execute({ tabId: 't' }, { ...ctx, modelCaps: { vision: false } })).toMatchObject({ success: false, metadata: { code: 'BROWSER_VISION_UNAVAILABLE' } })
    expect(execute).not.toHaveBeenCalled()
  })

  it.each(['{}', '{"dataUrl":"not-an-image"}', '{"dataUrl":"data:image/png;base64,AAAA"}'])('rejects invalid image output %s', async output => {
    vi.spyOn(browserBridge, 'execute').mockResolvedValue({ success: true, output })
    expect(await tool('browser_screenshot').execute({ tabId: 't' }, ctx)).toMatchObject({ success: false, metadata: { code: 'BROWSER_INVALID_SCREENSHOT' } })
  })

  it('registers browser capabilities in code only and preserves read-only child boundaries', async () => {
    const code = await createToolRegistry({ toolProfile: 'code', allowedTools: browserTools.map(item => item.name) })
    expect(code.registry.list()).toHaveLength(15)
    expect(code.registry.executionMode('browser_click', {})).toBe('serial')
    expect(code.registry.executionMode('browser_snapshot', {})).toBe('readonly')
    expect(code.registry.executionMode('browser_network_request', {})).toBe('readonly')
    const research = createSubagentToolRegistry(code.registry, true)
    expect(research.list().map(item => item.name).sort()).toEqual(['browser_console', 'browser_network', 'browser_network_request', 'browser_screenshot', 'browser_snapshot', 'browser_tabs'])
    expect(research.has('browser_click')).toBe(false)
    const general = await createToolRegistry({ toolProfile: 'general', allowedTools: ['browser_tabs'] })
    expect(general.registry.has('browser_tabs')).toBe(false)
  })

  it.each(['openai', 'anthropic'])('delivers screenshot pixels as %s multimodal image content', async provider => {
    vi.spyOn(browserBridge, 'execute').mockResolvedValue({ success: true, output: imageOutput })
    const result = await tool('browser_screenshot').execute({ tabId: 't' }, ctx)
    expect(result.success).toBe(true)
    expect(JSON.parse(result.output)).toMatchObject({ dataUrl: `data:image/png;base64,${png}`, mimeType: 'image/png', hasDataUrl: true })
    let body: Record<string, unknown> = {}
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify(provider === 'openai'
        ? { id: 'response', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'checked' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }
        : { id: 'response', type: 'message', role: 'assistant', model: 'claude-3-5-sonnet', content: [{ type: 'text', text: 'checked' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
    }))
    const messages: Message[] = [
      { role: 'assistant', content: '', toolCall: { id: 'shot', name: 'browser_screenshot', args: { tabId: 't' } } },
      { role: 'tool', content: result.output, toolCallId: 'shot', toolName: 'browser_screenshot' },
    ]
    const adapter = provider === 'openai' ? new OpenAIAdapter('gpt-4o', 'fixture-key', 'http://fixture.invalid', true) : new AnthropicAdapter('claude-3-5-sonnet', 'fixture-key', 'http://fixture.invalid', { 'X-Access-Token': 'fixture-token' })
    await adapter.complete(messages)
    const wire = JSON.stringify(body.messages)
    if (provider === 'openai') expect(wire).toContain(`"image_url":{"url":"data:image/png;base64,${png}"}`)
    else expect(wire).toContain(`"source":{"type":"base64","media_type":"image/png","data":"${png}"}`)
    expect(wire).toContain('browserTabId')
    expect(wire).toContain('navigationId')
    expect(wire).not.toContain('\\\\\"dataUrl\\\\\"')
  })
})

/** Browser failures must reach real provider wire content and retain conservative dispatch evidence. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../../core/agent-context/index.js'
import { browserTools } from '../browser-tools.js'
import { browserBridge } from '../browser-bridge.js'
import { normalizeBrowserFailure } from '../../../core/utils/browser-failure.js'
import { modelMessageContent } from '../../../core/utils/model-context.js'
import { OpenAIAdapter } from '../../../core/llm-adapter/openai.js'
import { AnthropicAdapter } from '../../../core/llm-adapter/anthropic.js'

const ctx = { tenantId: 'test', sessionId: 'chat', modelName: 'gpt-4o' } as AgentContext
const click = browserTools.find(tool => tool.name === 'browser_click')!
const reason = '请先打开并显示这个浏览器标签，再进行页面操作'
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('browser failure presentation', () => {
  it.each([
    [reason, 'BROWSER_TAB_NOT_VISIBLE'],
    ['目标浏览器标签未能显示，尚未执行页面操作；请关闭遮挡窗口或恢复编辑器后重试', 'BROWSER_TAB_NOT_VISIBLE'],
    ['编辑器窗口已最小化，尚未执行页面操作；请恢复窗口后重试', 'BROWSER_TAB_NOT_VISIBLE'],
    ['浏览器标签已关闭，请重新打开', 'BROWSER_TAB_CLOSED'],
    ['浏览器标签已关闭，尚未执行页面操作', 'BROWSER_TAB_CLOSED'],
    ['页面已经变化，请重新读取快照后操作', 'BROWSER_STALE_NAVIGATION'],
  ])('retains the precise pre-dispatch rejection: %s', async (error, code) => {
    vi.spyOn(browserBridge, 'execute').mockResolvedValue({ success: false, output: 'null', error })
    const result = await click.execute({ tabId: 'tab-A', navigationId: 2, ref: '2:3' }, ctx)
    expect(result.error).toBe(error)
    expect(result.metadata).toMatchObject({ code, operationPerformed: false })
    expect(JSON.parse(result.output)).toMatchObject({ success: false, error, code, operationPerformed: false, tabId: 'tab-A' })
    expect(JSON.parse(result.output).recovery.length).toBeGreaterThan(20)
  })

  it('marks invalid arguments as not performed and never dispatches them', async () => {
    const dispatch = vi.spyOn(browserBridge, 'execute')
    const result = await click.execute({ tabId: 'tab-A', x: 100 }, ctx)
    expect(dispatch).not.toHaveBeenCalled()
    expect(JSON.parse(result.output)).toMatchObject({ success: false, code: 'BROWSER_INVALID_ARGUMENTS', operationPerformed: false })
  })

  it('does not turn unknown input failures or a delivered cancellation into safe-to-repeat evidence', () => {
    for (const error of ['浏览器标签已关闭，操作已取消', 'Input.dispatchMouseEvent failed', '页面脚本报错：尚未执行页面操作']) {
      const result = normalizeBrowserFailure({ success: false, output: 'null', error })
      expect(JSON.parse(result.output)).toMatchObject({ error, operationPerformed: 'unknown' })
      expect(JSON.parse(result.output).recovery).toContain('不要盲目重复')
    }
    const delivered = normalizeBrowserFailure({ success: false, output: 'null', error: reason,
      metadata: { code: 'BROWSER_COMMAND_TIMEOUT', operationPerformed: 'unknown' } })
    expect(JSON.parse(delivered.output).operationPerformed).toBe('unknown')
  })

  it('preserves successful browser result payloads exactly', () => {
    const result = { success: true, output: '{"tab":{"tabId":"A"},"interaction":{"type":"click"}}' }
    expect(normalizeBrowserFailure(result)).toBe(result)
  })

  it('does not replace useful plain failure evidence and never invents a successful null result', () => {
    expect(JSON.parse(normalizeBrowserFailure({ success: false, output: 'Element selector matched 0 nodes' }).output).error)
      .toBe('Element selector matched 0 nodes')
    expect(JSON.parse(normalizeBrowserFailure({ success: false, output: 'null' }).output))
      .toMatchObject({ success: false, operationPerformed: 'unknown' })
  })

  it('keeps escaped exception bodies valid JSON within the ordinary output cap', () => {
    const error = '\u0001'.repeat(4000)
    const result = normalizeBrowserFailure({ success: false, output: 'null', error })
    expect(result.output.length).toBeLessThanOrEqual(3800)
    expect(JSON.parse(result.output).success).toBe(false)
    expect(result.error).toBe(error)
  })

  it('repairs old failed browser null history without mutating archived content or other tools', () => {
    const old: Message = { role: 'tool', toolName: 'browser_click', toolCallId: 'click', content: 'null',
      metadata: { success: false, status: 'failed', error: reason } }
    expect(JSON.parse(modelMessageContent(old) as string)).toMatchObject({ success: false, error: reason, operationPerformed: false })
    expect(old.content).toBe('null')
    expect(modelMessageContent({ ...old, toolName: 'ordinary_tool' })).toBe('null')
    expect(modelMessageContent({ ...old, metadata: { success: true } })).toBe('null')
    expect(modelMessageContent({ ...old, modelInputContent: 'explicit evidence' })).toBe('explicit evidence')
  })

  it.each(['openai', 'anthropic'])('sends both new and archived browser failures to the %s provider without null masking', async provider => {
    vi.spyOn(browserBridge, 'execute').mockResolvedValue({ success: false, output: 'null', error: reason })
    const failed = await click.execute({ tabId: 'tab-A', navigationId: 2, ref: '2:3' }, ctx)
    let body: Record<string, unknown> = {}
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify(provider === 'openai'
        ? { id: 'response', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'restore the browser' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }
        : { id: 'response', type: 'message', role: 'assistant', model: 'claude-3-5-sonnet', content: [{ type: 'text', text: 'restore the browser' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } }),
        { headers: { 'content-type': 'application/json' } })
    }))
    for (const content of [failed.output, 'null']) {
      const messages: Message[] = [
        { role: 'assistant', content: '', toolCall: { id: 'click', name: 'browser_click', args: { tabId: 'tab-A', navigationId: 2, ref: '2:3' } } },
        { role: 'tool', toolCallId: 'click', toolName: 'browser_click', content,
          metadata: { ...failed.metadata, success: false, status: 'failed', error: failed.error } },
      ]
      const adapter = provider === 'openai' ? new OpenAIAdapter('gpt-4o', 'fixture-key', 'http://fixture.invalid', true)
        : new AnthropicAdapter('claude-3-5-sonnet', 'fixture-key', 'http://fixture.invalid', { 'X-Access-Token': 'fixture-token' })
      await adapter.complete(messages)
      const wire = JSON.stringify(body.messages)
      expect(wire).toContain(reason)
      expect(wire).toContain('operationPerformed')
      expect(wire).toContain('BROWSER_TAB_NOT_VISIBLE')
      expect(wire).not.toContain('"content":"null"')
      if (provider === 'anthropic') expect(wire).toContain('"is_error":true')
    }
  })
})

it('preserves failed-open tab identity without copying arbitrary output or creating another tab', async () => {
  const error = '网页加载失败：net::ERR_CONNECTION_REFUSED (-102)'
  vi.spyOn(browserBridge, 'execute').mockResolvedValue({ success: false, error,
    output: JSON.stringify({ tabId: 'created-tab', url: 'http://127.0.0.1:8765/', navigationId: 2,
      ignored: 'unrelated metadata', dataUrl: 'data:image/png;base64,AAAA' }) })
  const open = browserTools.find(tool => tool.name === 'browser_open')!
  const result = await open.execute({ url: 'http://127.0.0.1:8765/' }, ctx)
  const failure = JSON.parse(result.output)
  expect(failure).toMatchObject({ success: false, error, code: 'BROWSER_NAVIGATION_FAILED',
    tabId: 'created-tab', url: 'http://127.0.0.1:8765/', navigationId: 2, operationPerformed: 'unknown' })
  expect(failure.recovery).toContain('browser_navigate')
  expect(failure.recovery).toContain('不要反复 browser_open')
  expect(failure).not.toHaveProperty('ignored')
  expect(failure).not.toHaveProperty('dataUrl')
})

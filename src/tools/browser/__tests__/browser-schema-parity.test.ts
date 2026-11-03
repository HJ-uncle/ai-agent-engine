/** Provider JSON Schema and execution validation must admit the same browser calls. */
import Fastify from 'fastify'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { browserBridge } from '../browser-bridge.js'
import { browserTools } from '../browser-tools.js'

afterEach(() => vi.restoreAllMocks())

it('rejects unsupported targets and wait shapes before the provider can select them', async () => {
  const server = Fastify({ ajv: { customOptions: { coerceTypes: false, useDefaults: false, removeAdditional: false } } })
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ['fill', { ref: '7:1', text: '' }, true],
    ['fill', { selector: '#name', text: '中文' }, true],
    ['fill', { text: 'missing target' }, false],
    ['fill', { ref: '7:1', selector: '#name', text: 'two targets' }, false],
    ['fill', { ref: '', text: 'empty target' }, false],
    ['fill', { selector: '#name', text: 'x'.repeat(100001) }, false],
    ['wait', { selector: '#done' }, true],
    ['wait', { text: '完成', timeoutMs: 0 }, true],
    ['wait', { selector: '#done', text: '完成' }, true],
    ['wait', { timeoutMs: 2000 }, false],
    ['wait', { selector: '' }, false],
    ['wait', { text: 'x'.repeat(2001) }, false],
    ['wait', { text: '完成', timeoutMs: -1 }, false],
    ['scroll', { deltaY: 10000 }, true],
    ['scroll', { deltaY: 10001 }, false],
    ['press_key', { key: 'Enter' }, true],
    ['press_key', { key: '' }, false],
  ]
  for (const name of new Set(cases.map(([name]) => name))) {
    const tool = browserTools.find(tool => tool.name === `browser_${name}`)!
    server.post(`/${name}`, { schema: { body: tool.parameters } }, async () => ({ accepted: true }))
  }
  const dispatch = vi.spyOn(browserBridge, 'execute').mockResolvedValue({ success: true, output: '{}' })
  try {
    for (const [name, values, expected] of cases) {
      const args = { tabId: 'tab', navigationId: 7, ...values }
      const wire = await server.inject({ method: 'POST', url: `/${name}`, payload: args })
      const tool = browserTools.find(tool => tool.name === `browser_${name}`)!
      const previousCalls = dispatch.mock.calls.length
      const result = await tool.execute(args, { tenantId: 'schema', sessionId: 'session' } as AgentContext)
      expect(wire.statusCode === 200, `${name} provider schema`).toBe(expected)
      expect(result.success, `${name} execution validator`).toBe(expected)
      expect(dispatch.mock.calls.length - previousCalls).toBe(expected ? 1 : 0)
    }
  } finally { await server.close() }
})

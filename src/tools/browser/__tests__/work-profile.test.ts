/** Both product profiles share the real session-owned reverse transport, not duplicated browser implementations. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/types.js'
import { ToolNotFoundError } from '../../../core/agent-context/types.js'
import { createToolRegistry } from '../../registry-factory.js'
import { createSubagentToolRegistry } from '../../subagent/subagent-tool.js'
import { browserBridge } from '../browser-bridge.js'
import { BROWSER_TOOL_NAMES, BROWSER_READONLY_TOOLS } from '../browser-tools.js'
import { skillsRegistry } from '../../../skills/index.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'

vi.mock('../../../storage/mcp/mcp-config.js', () => ({ listServers: () => [] }))
const identity = { tenantId: 'browser-work-profile' }, sessionId = 'work-task-a'
const context = { ...identity, sessionId, toolProfile: 'general' } as AgentContext
beforeEach(() => {
  vi.stubEnv('OSM_MODE', 'balanced')
  vi.spyOn(skillsRegistry, 'getSkills').mockReturnValue([])
  setSecurityMode(identity.tenantId, sessionId, 'standard')
})
afterEach(() => { browserBridge.dispose(); clearSecurityMode(identity.tenantId, sessionId); vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('Work executable browser capabilities', () => {
  it.each(['balanced', 'methodology', 'max'])('registers the shared browser without removing Work services in %s', async mode => {
    vi.stubEnv('OSM_MODE', mode)
    const { registry, toolCategories } = await createToolRegistry({ toolProfile: 'general' })
    for (const name of BROWSER_TOOL_NAMES) expect(registry.has(name), name).toBe(true)
    for (const name of ['cron_create', 'agent_list', 'task_status']) expect(registry.has(name), name).toBe(true)
    expect(toolCategories.builtinTools).toEqual(expect.arrayContaining([...BROWSER_TOOL_NAMES]))
  })

  it('keeps deliberate OSM off narrowing and empty explicit allowlists intact', async () => {
    vi.stubEnv('OSM_MODE', 'off')
    const off = await createToolRegistry({ toolProfile: 'general' })
    expect(off.registry.has('browser_open')).toBe(false)
    vi.stubEnv('OSM_MODE', 'balanced')
    const empty = await createToolRegistry({ toolProfile: 'general', allowedTools: [] })
    expect(empty.registry.list().map(tool => tool.name)).toEqual(['plan_update'])
    await expect(empty.registry.execute('browser_open', { url: 'http://synthetic.invalid' }, context)).rejects.toBeInstanceOf(ToolNotFoundError)
    const limited = await createToolRegistry({ toolProfile: 'general', allowedTools: ['browser_snapshot'] })
    expect(limited.registry.list().map(tool => tool.name).sort()).toEqual(['browser_snapshot', 'plan_update'])
  })

  it('executes open/snapshot/click/close through actual queue receipts pinned to the task', async () => {
    const { registry } = await createToolRegistry({ toolProfile: 'general' })
    const client = browserBridge.register(identity, sessionId)
    for (const [name, args, action] of [
      ['browser_open', { url: 'http://synthetic.invalid' }, 'open'],
      ['browser_snapshot', { tabId: 'owned-tab' }, 'snapshot'],
      ['browser_click', { tabId: 'owned-tab', navigationId: 2, ref: '2:1' }, 'click'],
      ['browser_close', { tabId: 'owned-tab' }, 'close'],
    ] as const) {
      const pending = registry.execute(name, args, context)
      const [command] = await browserBridge.poll(identity, client.clientId, client.clientToken)
      expect(command).toMatchObject({ sessionId, action, args })
      const output = JSON.stringify({ tabId: 'owned-tab', performed: action })
      expect(browserBridge.result(identity, client.clientId, client.clientToken, command.requestId, { success: true, output })).toBe(true)
      expect(await pending).toMatchObject({ success: true, output })
      expect(browserBridge.result(identity, client.clientId, client.clientToken, command.requestId, { success: true, output: 'duplicate' })).toBe(false)
    }
  })

  it('reports missing browser immediately and cannot fall through to another task client', async () => {
    const { registry } = await createToolRegistry({ toolProfile: 'general' })
    browserBridge.register(identity, 'another-task')
    expect(await registry.execute('browser_tabs', {}, context)).toMatchObject({ success: false, metadata: { code: 'BROWSER_CLIENT_UNAVAILABLE', operationPerformed: false } })
  })

  it('gives readonly children only the declared readonly browser actions', async () => {
    const { registry } = await createToolRegistry({ toolProfile: 'general' })
    const child = createSubagentToolRegistry(registry, true)
    for (const name of BROWSER_TOOL_NAMES) expect(child.has(name), name).toBe(BROWSER_READONLY_TOOLS.has(name))
    expect(await child.execute('browser_click', { tabId: 'owned-tab', navigationId: 2, ref: '2:1' }, context)).toMatchObject({ success: false, metadata: { code: 'TOOL_NOT_ALLOWED' } })
  })

  it('cancelling one delivered task request leaves a second task able to finish', async () => {
    const { registry } = await createToolRegistry({ toolProfile: 'general' })
    const a = browserBridge.register(identity, sessionId), b = browserBridge.register(identity, 'work-task-b')
    const abort = new AbortController()
    const first = registry.execute('browser_click', { tabId: 'tab-a', navigationId: 2, ref: '2:1' }, { ...context, signal: abort.signal })
    const second = registry.execute('browser_snapshot', { tabId: 'tab-b' }, { ...context, sessionId: 'work-task-b' })
    const [one] = await browserBridge.poll(identity, a.clientId, a.clientToken)
    const [two] = await browserBridge.poll(identity, b.clientId, b.clientToken)
    abort.abort()
    expect(await first).toMatchObject({ success: false, status: 'cancelled', metadata: { operationPerformed: 'unknown' } })
    expect(browserBridge.result(identity, a.clientId, a.clientToken, one.requestId, { success: true, output: 'late' })).toBe(false)
    expect(browserBridge.result(identity, b.clientId, b.clientToken, two.requestId, { success: true, output: 'task-b-ok' })).toBe(true)
    expect(await second).toMatchObject({ success: true, output: 'task-b-ok' })
  })
})

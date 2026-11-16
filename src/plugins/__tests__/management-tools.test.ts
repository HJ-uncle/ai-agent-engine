// Isolated file-backed plugins and actual Node tool runs; no model or external service calls.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Tool } from '../../core/agent-context/types.js'
import { clearSecurityMode, getSecurityMode, setSecurityMode } from '../../security/policy-engine.js'
import { createPluginManagementTools } from '../management-tools.js'
import { publishedCapabilityAccess, assertCapability } from '../capability-runtime.js'
import { PluginService } from '../service.js'
import type { CreatePluginInput } from '../types.js'

const fixtures = path.resolve('.e2e-tmp/session-full-access/plugin-management')
const securityScopes = [['tenant-a', 'session-a'], ['tenant-a', 'session-b'], ['tenant-b', 'session-a']] as const
let root: string, marker: string, service: PluginService, tools: Tool[]
const context = (overrides: Partial<AgentContext> = {}) => ({
  tenantId: 'tenant-a', sessionId: 'session-a', currentToolCallId: 'plugin-call', toolProfile: 'general', ...overrides,
}) as AgentContext
const tool = (name: string) => tools.find(item => item.name === name)!

function input(multiplier = 2): CreatePluginInput {
  return {
    manifest: { apiVersion: 1, id: 'full-access-fixture', name: 'Full access fixture', version: `1.0.${multiplier}`,
      description: 'Tests real plugin mutation and execution', runtime: 'node', permissions: { requested: ['settings.read'] },
      tools: [{ name: 'calculate', description: 'Multiply the supplied value', entry: 'main.mjs',
        inputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false } }] },
    files: { 'main.mjs': `import fs from 'node:fs';let raw='';for await(const chunk of process.stdin)raw+=chunk;
const {args}=JSON.parse(raw);fs.appendFileSync(${JSON.stringify(marker)},String(args.value)+'\\n');
console.log(JSON.stringify({result:{value:args.value*${multiplier}}}));` },
  }
}

beforeEach(() => {
  fs.mkdirSync(fixtures, { recursive: true })
  root = fs.mkdtempSync(path.join(fixtures, 'case-'))
  marker = path.join(root, 'invocations.txt')
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('DEFAULT_SECURITY_MODE', 'standard')
  vi.stubEnv('DATA_DIR', path.join(root, 'state', 'agent.db'))
  for (const [tenant, session] of securityScopes) clearSecurityMode(tenant, session)
  service = new PluginService(path.join(root, 'plugins'))
  tools = createPluginManagementTools(service)
})
afterEach(() => {
  for (const [tenant, session] of securityScopes) clearSecurityMode(tenant, session)
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== fixtures || !path.basename(root).startsWith('case-') || fs.lstatSync(root).isSymbolicLink()) throw new Error('Unsafe plugin full-access fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  if (!fs.readdirSync(fixtures).length) fs.rmdirSync(fixtures)
})

describe('plugin management honors current session full access', () => {
  it('creates, executes tests, updates, publishes, disables and deletes without repeated confirmation', async () => {
    setSecurityMode('tenant-a', 'session-a', 'full-access')
    const created = await tool('plugin_create').execute(input(), context())
    expect(created.success, created.output).toBe(true)
    expect(created.needsConfirmation).not.toBe(true)
    expect(created.pendingAction).toBeUndefined()
    expect((await service.get('tenant-a', 'full-access-fixture')).revision).toBe(1)

    const tested = await tool('plugin_test').execute({ id: 'full-access-fixture', tool: 'calculate', args: { value: 4 } }, context())
    expect(tested.success, tested.output).toBe(true)
    expect(JSON.parse(tested.output).result).toEqual({ value: 8 })
    expect(fs.readFileSync(marker, 'utf8')).toBe('4\n')

    const updated = await tool('plugin_update').execute({ id: 'full-access-fixture', ...input(3), expectedRevision: 1 }, context())
    expect(updated.success, updated.output).toBe(true)
    expect((await service.get('tenant-a', 'full-access-fixture')).revision).toBe(2)
    const retested = await tool('plugin_test').execute({ id: 'full-access-fixture', cases: [{ tool: 'calculate', args: { value: 5 }, expected: { value: 15 } }] }, context())
    expect(retested.success, retested.output).toBe(true)
    expect(JSON.parse(retested.output)).toMatchObject({ total: 1, passed: 1, failed: 0 })
    expect(fs.readFileSync(marker, 'utf8')).toBe('4\n5\n')

    expect((await tool('plugin_publish').execute({ id: 'full-access-fixture', expectedRevision: 2 }, context())).success).toBe(true)
    expect(await service.get('tenant-a', 'full-access-fixture')).toMatchObject({ enabled: true, publishedRevision: 2, permissionGrants: [] })
    const access = await publishedCapabilityAccess(service, 'tenant-a', 'full-access-fixture', 2)
    expect(() => assertCapability(access, 'settings.read', 2)).toThrow('尚未获准')
    expect((await tool('plugin_set_enabled').execute({ id: 'full-access-fixture', enabled: false }, context())).success).toBe(true)
    expect((await service.get('tenant-a', 'full-access-fixture')).enabled).toBe(false)
    expect((await tool('plugin_delete').execute({ id: 'full-access-fixture' }, context())).success).toBe(true)
    expect(await service.list('tenant-a')).toEqual([])
  })

  it('keeps another session and tenant waiting without changing their modes or stored data', async () => {
    setSecurityMode('tenant-a', 'session-a', 'full-access')
    for (const other of [context({ sessionId: 'session-b' }), context({ tenantId: 'tenant-b' })]) {
      const waiting = await tool('plugin_create').execute(input(), other)
      expect(waiting).toMatchObject({ status: 'waiting', needsConfirmation: true })
      expect(await service.list(other.tenantId)).toEqual([])
      expect(getSecurityMode(other.tenantId, other.sessionId)).toBe('standard')
    }
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('requires approval again when the current session returns to standard before execution', async () => {
    await service.create('tenant-a', input())
    const args = { id: 'full-access-fixture', tool: 'calculate', args: { value: 7 } }
    setSecurityMode('tenant-a', 'session-a', 'full-access')
    expect(await tool('plugin_test').preflight!(args, context())).toBeUndefined()
    setSecurityMode('tenant-a', 'session-a', 'standard')
    const waiting = await tool('plugin_test').execute(args, context())
    expect(waiting).toMatchObject({ status: 'waiting', needsConfirmation: true })
    expect(fs.existsSync(marker)).toBe(false)
    expect((await service.get('tenant-a', 'full-access-fixture')).revision).toBe(1)
  })

  it('still rejects missing management authority, child management and invalid inputs', async () => {
    setSecurityMode('tenant-a', 'session-a', 'full-access')
    vi.stubEnv('AUTH_ENABLED', 'true')
    const unauthorized = await tool('plugin_create').execute(input(), context())
    expect(unauthorized.success).toBe(false)
    expect(unauthorized.output).toContain('admin 或 plugin-manager')
    expect(unauthorized.needsConfirmation).not.toBe(true)
    vi.stubEnv('AUTH_ENABLED', 'false')
    const child = await tool('plugin_create').execute(input(), context({ parentSessionId: 'parent' }))
    expect(child.success).toBe(false)
    expect(child.output).toContain('仅供主代理')
    const invalid = await tool('plugin_create').execute({ templateId: 'missing', id: 'invalid' }, context())
    expect(invalid.success).toBe(false)
    expect(invalid.needsConfirmation).not.toBe(true)
    expect(await service.list('tenant-a')).toEqual([])
  })

  it('does not execute malformed tests or overwrite stale and foreign plugin versions', async () => {
    await service.create('tenant-a', input())
    setSecurityMode('tenant-a', 'session-a', 'full-access')
    const invalid = await tool('plugin_test').execute({ id: 'full-access-fixture', tool: 'calculate', args: { value: 'wrong type' } }, context())
    expect(invalid.success).toBe(false)
    expect(invalid.needsConfirmation).not.toBe(true)
    expect(fs.existsSync(marker)).toBe(false)
    const stale = await tool('plugin_update').execute({ id: 'full-access-fixture', ...input(4), expectedRevision: 9 }, context())
    expect(stale.success).toBe(false)
    expect(stale.output).toContain('版本已变化')
    setSecurityMode('tenant-b', 'session-a', 'full-access')
    const foreign = await tool('plugin_delete').execute({ id: 'full-access-fixture' }, context({ tenantId: 'tenant-b' }))
    expect(foreign.success).toBe(false)
    expect((await service.get('tenant-a', 'full-access-fixture')).revision).toBe(1)
  })
})

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb, closeDb } from '../../storage/sqlite/db.js'
import { RootRunStore } from '../../storage/root-runs/index.js'
import { getExecutionOwners } from '../../core/collaboration/execution-owner.js'
import { createAgentContext } from '../../core/agent-context/factory.js'
import { createConversationHistory } from '../../storage/conversation/factory.js'
import { ToolRegistry } from '../../core/tool-registry/index.js'
import { logger } from '../../observability/index.js'
import { WorkbenchBridge } from '../../tools/workbench/bridge.js'
import { bindPluginWorkbench, pluginWorkbenchBinding } from '../workbench-binding.js'

const fixtures = path.resolve('.e2e-tmp/plugin-workbench-binding')
let directory: string
beforeEach(async () => {
  fs.mkdirSync(fixtures, { recursive: true }); directory = fs.mkdtempSync(path.join(fixtures, 'case-'))
  vi.stubEnv('DATA_DIR', path.join(directory, 'state', 'fixture.db'))
  vi.stubEnv('WORKSPACE_ROOT', path.join(directory, 'workspace')); vi.stubEnv('HISTORY_BACKEND', 'jsonl')
  await initDb()
})
afterEach(async () => {
  await closeDb(); vi.unstubAllEnvs()
  if (path.dirname(directory) !== fixtures || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  if (!fs.readdirSync(fixtures).length) fs.rmdirSync(fixtures)
})

describe('plugin workbench delegation uses a real root owner', () => {
  it('targets the bound workbench without rewriting the independent root execution identity', async () => {
    const roots = new RootRunStore(), owners = getExecutionOwners(), controller = new AbortController()
    const root = await roots.create('tenant', 'plugin-session', 'fixture-model', [directory], { message: 'Inspect the bound workbench' })
    const owner = await owners.admitRoot({ tenantId: 'tenant', rootRunId: root.runId,
      rootAttemptId: (await roots.get('tenant', root.runId))!.attemptId, controller })
    const ctx = createAgentContext({ tenantId: 'tenant', sessionId: root.sessionId, rootSessionId: root.sessionId,
      rootRunId: root.runId, executionOwner: owner, turnId: root.turnId, tools: new ToolRegistry(), history: createConversationHistory(), logger,
      signal: controller.signal, browserPrincipal: { tenantId: 'tenant', userId: 'user', method: 'jwt' } })
    const bridge = new WorkbenchBridge({ leaseMs: 1000, pollMs: 5, commandMs: 1000 })
    const identity = { tenantId: 'tenant', userId: 'user' }, client = bridge.register(identity, 'bound-chat', ['workspace.context'])
    let unbind: (() => void) | undefined
    try {
      expect(await bridge.execute('workspace.context', {}, ctx)).toMatchObject({ success: false, metadata: { code: 'WORKBENCH_UNAVAILABLE' } })
      // Readable metadata cannot create a delegation.
      expect(pluginWorkbenchBinding({ ...ctx, ...{ pluginId: 'made-up', boundSessionId: 'bound-chat' } })).toBeUndefined()
      unbind = bindPluginWorkbench(owner, { sessionId: 'bound-chat', pluginId: 'review', userId: 'user' })
      expect(bridge.status(ctx)).toMatchObject({ connected: true })
      const completed = bridge.execute('workspace.context', {}, ctx)
      const [command] = await bridge.poll(identity, client.clientId, client.clientToken)
      expect(command).toMatchObject({ sessionId: 'bound-chat', hostDelegation: { kind: 'plugin', pluginId: 'review', sessionId: 'bound-chat' },
        execution: { rootSessionId: 'plugin-session', rootRunId: root.runId, ownerRunId: root.runId } })
      expect(bridge.result(identity, client.clientId, client.clientToken, command.requestId,
        { ...command.execution, rootSessionId: 'bound-chat' }, { success: true, output: '{}' })).toBe(false)
      expect(bridge.result(identity, client.clientId, client.clientToken, command.requestId, command.execution,
        { success: true, output: '{"visible":true}' })).toBe(true)
      expect(await completed).toMatchObject({ success: true, output: '{"visible":true}' })
      expect(() => pluginWorkbenchBinding({ ...ctx, tenantId: 'other' })).toThrow('PLUGIN_WORKBENCH_CONTEXT_MISMATCH')
      expect(() => pluginWorkbenchBinding({ ...ctx, runId: 'unrelated-execution' })).toThrow('PLUGIN_WORKBENCH_CONTEXT_MISMATCH')
      expect(() => pluginWorkbenchBinding({ ...ctx, browserPrincipal: { tenantId: 'tenant', userId: 'other', method: 'jwt' } })).toThrow('PLUGIN_WORKBENCH_CONTEXT_MISMATCH')
      unbind(); unbind = undefined
      expect(await bridge.execute('workspace.context', {}, ctx)).toMatchObject({ success: false, metadata: { code: 'WORKBENCH_UNAVAILABLE' } })
      owners.registerCompletion(owner, Promise.resolve())
      await roots.finishOwned(owner, { status: 'succeeded' }); owners.releaseRoot(owner)
    } finally { unbind?.(); bridge.dispose(); controller.abort() }
  })
})

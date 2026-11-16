/** Real owner admission, controller ledger and Node IPC; only the terminal Agent dispatcher is observed. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../core/agent-context/types.js'
import { getExecutionOwners, type ExecutionOwner } from '../../core/collaboration/execution-owner.js'
import { controllerSubject } from '../../core/collaboration/controller-origin.js'
import { rootRunStore } from '../../storage/root-runs/index.js'
import { closeDb, initDb } from '../../storage/sqlite/db.js'
import { createSelectedPluginTools } from '../catalogue.js'
import { pluginToolkitId } from '../metadata.js'
import { PluginService } from '../service.js'
import type { PluginExecutionContext } from '../capability-runtime.js'
import * as agents from '../agent-capability.js'

const fixtures = path.resolve('.e2e-tmp/plugin-catalogue-controller'), tenantId = 'tenant', sessionId = 'parent-session'
let directory: string, owner: ExecutionOwner | undefined, context: AgentContext, service: PluginService, observed: PluginExecutionContext[]
const authority = { kind: 'account' as const, tenantId, userId: 'user-a' }, subject = controllerSubject(authority, 'jwt')

beforeEach(async () => {
  fs.mkdirSync(fixtures, { recursive: true }); directory = fs.mkdtempSync(path.join(fixtures, 'case-'))
  vi.stubEnv('DATA_DIR', path.join(directory, 'state', 'agent.db')); vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('DEFAULT_SECURITY_MODE', 'standard'); vi.stubEnv('HISTORY_BACKEND', 'jsonl'); vi.stubEnv('WORKSPACE_ROOT', directory)
  await initDb()
  service = new PluginService(path.join(directory, 'plugins')); observed = []
  await service.create(tenantId, { manifest: { apiVersion: 1, id: 'controller-node', name: 'Controller Node', version: '1', description: 'Controller delegation fixture', runtime: 'node',
    permissions: { requested: ['agents.manage'] }, tools: [{ name: 'delegate', description: 'Ask the configured Agent', entry: 'main.mjs', inputSchema: { type: 'object' } }] },
    files: { 'main.mjs': `for await(const chunk of process.stdin){};const result=await $AE.agents.run({modelId:'fixture',task:'Delegated task'});console.log(JSON.stringify({result}));` } })
  await service.publish(tenantId, 'controller-node', 1); await service.setPermissionGrants(tenantId, 'controller-node', ['agents.manage'], 1)
  const root = await rootRunStore.create(tenantId, sessionId, 'fixture', [directory], { message: 'Host-owned request' })
  owner = await getExecutionOwners().admitRoot({ tenantId, rootRunId: root.runId, rootAttemptId: (await rootRunStore.get(tenantId, root.runId))!.attemptId,
    controller: new AbortController(), controllerSubject: subject })
  getExecutionOwners().registerCompletion(owner, Promise.resolve())
  context = { tenantId, sessionId, toolProfile: 'general', executionOwner: owner, browserAuthority: authority,
    browserPrincipal: { tenantId, userId: 'user-a', method: 'jwt' }, workspacePaths: [directory], cwd: directory, projectRoot: directory } as AgentContext
  vi.spyOn(agents, 'invokeAgentCapability').mockImplementation(async (_access, _tenant, _call, _signal, execution) => {
    observed.push(execution ?? {}); return { runId: 'observed-agent', status: 'running' }
  })
})
afterEach(async () => {
  if (owner) { await rootRunStore.finishOwned(owner, { status: 'succeeded' }); getExecutionOwners().releaseRoot(owner); owner = undefined }
  await closeDb(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(directory) !== fixtures || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Unsafe controller fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
  if (!fs.readdirSync(fixtures).length) fs.rmdirSync(fixtures)
})
async function invoke(ctx = context) {
  const tools = await createSelectedPluginTools(tenantId, [pluginToolkitId('controller-node', 1)], [], service)
  return tools[0].execute({}, ctx)
}

describe('host controller inheritance into selected Node plugins', () => {
  it('carries the real admitted controller through Node SDK capability dispatch', async () => {
    const result = await invoke()
    expect(result.success, result.output).toBe(true)
    expect(observed).toHaveLength(1)
    expect(observed[0].controllerSubject).toEqual(subject)
    expect(observed[0].browserAuthority).toEqual(authority)
    expect(observed[0].workspaceContext?.sessionId).toBe(sessionId)
  })

  it('rejects a different account and cannot derive controller authority from readable IDs', async () => {
    const changed = await invoke({ ...context, browserAuthority: { ...authority, userId: 'user-b' }, browserPrincipal: { tenantId, userId: 'user-b', method: 'jwt' } })
    expect(changed.success).toBe(false); expect(observed).toHaveLength(0)
    const withoutOwner = { ...context, executionOwner: undefined }
    const unowned = await invoke(withoutOwner)
    expect(unowned.success, unowned.output).toBe(true)
    expect(observed).toHaveLength(1)
    expect(observed[0].controllerSubject).toBeUndefined()
  })
})

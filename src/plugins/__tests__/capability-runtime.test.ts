import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginService } from '../service.js'
import { getPluginTemplate } from '../templates.js'
import { invokePluginCapability, publishedCapabilityAccess, publishedCapabilityDispatcher, type CapabilityCall } from '../capability-runtime.js'
import { runPlugin } from '../runtime.js'

const mocks = vi.hoisted(() => ({ models: vi.fn(), resolve: vi.fn(), adapter: vi.fn(), complete: vi.fn(), archive: vi.fn(), message: vi.fn() }))
vi.mock('../../storage/sqlite/models.js', () => ({ ModelsStore: class { getModels = mocks.models } }))
vi.mock('../../core/llm-adapter/resolve-model.js', () => ({ resolveModelConfig: mocks.resolve, createAdapterFromResolved: mocks.adapter }))
vi.mock('../../storage/conversation/factory.js', () => ({ createConversationHistory: () => ({ getArchive: mocks.archive, getMessageById: mocks.message }) }))
vi.mock('../../api/http/history-projection.js', () => ({ publicSessionHistoryMessages: async (_tenant: string, messages: unknown[]) => messages }))

const fixtures = path.resolve('.e2e-tmp/plugin-capabilities')
let root: string, service: PluginService
const permissions = ['session.read', 'models.read', 'ai.run', 'settings.read', 'settings.write'] as const
beforeEach(async () => {
  fs.mkdirSync(fixtures, { recursive: true }); root = fs.mkdtempSync(path.join(fixtures, 'case-'))
  service = new PluginService(path.join(root, 'plugins'))
  const template = getPluginTemplate('json-tool'); template.manifest.permissions = { requested: [...permissions] }
  await service.create('tenant-a', template); await service.publish('tenant-a', template.manifest.id, 1)
  mocks.models.mockResolvedValue([{ id: 'configured', modelId: 'local-model', provider: 'openai', apiKey: 'SECRET-MUST-NOT-LEAK', baseUrl: 'http://127.0.0.1', isEnabled: true }, { id: 'disabled', isEnabled: false }])
  mocks.resolve.mockResolvedValue({ model: 'local-model', provider: 'openai', capabilities: { contextWindow: 32_000 }, thinkingEnabled: false, thinkingConfig: null, responseThinkingField: null })
  mocks.adapter.mockReturnValue({ complete: mocks.complete })
  mocks.complete.mockResolvedValue({ content: '分析完成', promptTokens: 10, completionTokens: 5, finishReason: 'stop' })
  mocks.archive.mockResolvedValue({ messages: [{ id: 'm1', role: 'user', content: '需要一个插件', metadata: { attachments: [{ name: 'input.png' }] } }], totalMessageCount: 2, archiveRevision: 'r1' })
})
afterEach(() => {
  vi.clearAllMocks()
  if (path.dirname(root) !== fixtures || fs.lstatSync(root).isSymbolicLink()) throw new Error('Unsafe capability fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true })
  if (fs.existsSync(fixtures) && !fs.readdirSync(fixtures).length) fs.rmdirSync(fixtures)
})
async function call(input: Omit<CapabilityCall, 'expectedRevision'>, revision = 1) {
  return invokePluginCapability(await publishedCapabilityAccess(service, 'tenant-a', 'my-json-tool', revision), 'tenant-a', { ...input, expectedRevision: revision })
}
async function grant() { await service.setPermissionGrants('tenant-a', 'my-json-tool', [...permissions], 1) }
describe('plugin host capability boundary', () => {
  it('authorizes UI host operations only with a declared current grant and rejects raw parameters', async () => {
    const template = getPluginTemplate('json-tool'); template.manifest.permissions = { requested: ['ui.clipboard'] }
    await service.update('tenant-a', 'my-json-tool', { ...template, expectedRevision: 1 }); await service.publish('tenant-a', 'my-json-tool', 2)
    await expect(call({ capability: 'ui.clipboard', method: 'host.authorize', args: {} }, 2)).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION' })
    await service.setPermissionGrants('tenant-a', 'my-json-tool', ['ui.clipboard'], 2)
    expect(await call({ capability: 'ui.clipboard', method: 'host.authorize', args: {} }, 2)).toEqual({ authorized: true })
    await expect(call({ capability: 'ui.clipboard', method: 'host.authorize', args: { channel: 'raw-ipc' } }, 2)).rejects.toThrow()
    await service.setPermissionGrants('tenant-a', 'my-json-tool', [], 2)
    await expect(call({ capability: 'ui.clipboard', method: 'host.authorize', args: {} }, 2)).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION' })
  })
  it('runs the same SDK in a real Node child with scoped settings and permission revocation', async () => {
    const template = getPluginTemplate('json-tool'); template.manifest.permissions = { requested: [...permissions] }
    template.files['main.mjs'] = `let raw='';for await(const chunk of process.stdin)raw+=chunk;const value=await $AE.settings.get();console.log(JSON.stringify({result:{value,context:await $AE.context(),keys:Object.keys($AE)}}))`
    await service.update('tenant-a', 'my-json-tool', { ...template, expectedRevision: 1 })
    await service.publish('tenant-a', 'my-json-tool', 2)
    await service.setPermissionGrants('tenant-a', 'my-json-tool', ['settings.read'], 2)
    await service.setSettings('tenant-a', 'my-json-tool', { mode: 'strict' })
    const snapshot = await service.snapshot('tenant-a', 'my-json-tool', 2)
    const options = { capability: publishedCapabilityDispatcher(service, 'tenant-a', 'my-json-tool', 2, 'bound'), hostContext: { sessionId: 'bound' } }
    expect((await runPlugin(snapshot, 'normalize_text', { text: 'x' }, options)).result).toMatchObject({ value: { mode: 'strict' }, context: { sessionId: 'bound', pluginId: 'my-json-tool', revision: 2 }, keys: expect.arrayContaining(['skills', 'ai', 'workspace']) })
    await service.setPermissionGrants('tenant-a', 'my-json-tool', [], 2)
    await expect(runPlugin(snapshot, 'normalize_text', { text: 'x' }, options)).rejects.toThrow('尚未获准使用 settings.read')
  })
  it('denies declared but ungranted access and undeclared grants', async () => {
    await expect(call({ capability: 'models.read', method: 'list', args: {} })).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION' })
    await expect(service.setPermissionGrants('tenant-a', 'my-json-tool', ['workspace.write'], 1)).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION' })
    expect(mocks.models).not.toHaveBeenCalled()
  })
  it('reads bound messages and rejects authority in plugin args', async () => {
    await grant()
    await expect(call({ capability: 'session.read', method: 'messages', args: {} })).rejects.toMatchObject({ code: 'PLUGIN_SESSION_REQUIRED' })
    await call({ capability: 'session.read', method: 'messages', sessionId: 'bound', args: {} })
    expect(mocks.archive).toHaveBeenLastCalledWith({ tenantId: 'tenant-a', sessionId: 'bound' }, { offset: 0, limit: 50 })
    const result = await call({ capability: 'session.read', method: 'messages', sessionId: 'bound', args: { limit: 1 } })
    expect(result).toMatchObject({ total: 2, nextOffset: 1, messages: [{ id: 'm1', metadata: { attachments: [{ name: 'input.png' }] } }] })
    expect(mocks.archive).toHaveBeenCalledWith({ tenantId: 'tenant-a', sessionId: 'bound' }, { offset: 0, limit: 1 })
    await expect(call({ capability: 'session.read', method: 'messages', sessionId: 'bound', args: { sessionId: 'other' } })).rejects.toThrow()
    mocks.message.mockResolvedValue(null)
    expect(await call({ capability: 'session.read', method: 'messages', sessionId: 'bound', args: { ids: ['foreign'] } })).toMatchObject({ messages: [] })
    expect(mocks.message).toHaveBeenCalledWith('foreign', 'tenant-a', 'bound')
  })
  it('keeps unknown methods rejected after extracting shared argument contracts', async () => {
    await grant()
    await expect(call({ capability: 'settings.read', method: '__proto__', args: {} })).rejects.toMatchObject({ code: 'PLUGIN_METHOD' })
  })
  it('uses configured models, never exposes keys and rejects model overrides', async () => {
    await grant()
    expect(await call({ capability: 'models.read', method: 'list', args: {} })).toEqual({ models: [{ id: 'configured', modelId: 'local-model', name: 'local-model', provider: 'openai' }] })
    expect(await call({ capability: 'ai.run', method: 'run', args: { modelId: 'configured', prompt: '分析会话' } })).toEqual({ text: '分析完成', model: 'local-model', usage: { inputTokens: 10, outputTokens: 5 } })
    expect(mocks.resolve).toHaveBeenCalledWith({ tenantId: 'tenant-a', model: 'configured' })
    expect(mocks.complete).toHaveBeenCalledWith([{ role: 'user', content: '分析会话' }], expect.objectContaining({ model: 'local-model', contextWindow: 32_000, unboundedOutput: true, thinkingEnabled: false, thinkingConfig: null, responseThinkingField: null }))
    await expect(call({ capability: 'ai.run', method: 'run', args: { modelId: 'disabled', prompt: 'x' } })).rejects.toMatchObject({ code: 'PLUGIN_MODEL' })
    await expect(call({ capability: 'ai.run', method: 'run', args: { modelId: 'configured', prompt: 'x', baseUrl: 'http://untrusted' } })).rejects.toThrow()
    mocks.complete.mockRejectedValue(new Error('SECRET-MUST-NOT-LEAK'))
    await expect(call({ capability: 'ai.run', method: 'run', args: { modelId: 'configured', prompt: 'x' } })).rejects.toThrow('平台模型调用失败')
  })
  it.each(['resolve', 'complete'] as const)('redacts %s failures even when the provider uses a plugin-shaped error', async stage => {
    await grant()
    mocks[stage].mockRejectedValue(Object.assign(new Error('SECRET-MUST-NOT-LEAK'), { code: 'PLUGIN_AI_EMPTY' }))
    await expect(call({ capability: 'ai.run', method: 'run', args: { modelId: 'configured', prompt: 'x' } }))
      .rejects.toMatchObject({ code: 'PLUGIN_AI_FAILED', message: '平台模型调用失败，请检查模型配置后重试', statusCode: 502 })
  })
  it.each(['error', 'tool_calls', undefined])('does not mark a %s provider terminal as completed', async finishReason => {
    await grant()
    mocks.complete.mockResolvedValue({ content: 'unfinished', finishReason, promptTokens: 1, completionTokens: 1 })
    await expect(call({ capability: 'ai.run', method: 'run', args: { modelId: 'configured', prompt: 'x' } }))
      .rejects.toMatchObject({ code: 'PLUGIN_AI_INCOMPLETE' })
  })
  it('isolates settings, revokes immediately, preserves published grants until replacement', async () => {
    await grant()
    await call({ capability: 'settings.write', method: 'set', args: { value: { rubric: 'accuracy' } } })
    expect(await call({ capability: 'settings.read', method: 'get', args: {} })).toEqual({ rubric: 'accuracy' })
    await expect(publishedCapabilityAccess(service, 'tenant-b', 'my-json-tool', 1)).rejects.toMatchObject({ code: 'PLUGIN_NOT_FOUND' })
    const template = getPluginTemplate('json-tool'); template.manifest.permissions = { requested: [...permissions] }
    await service.update('tenant-a', 'my-json-tool', { ...template, expectedRevision: 1 })
    expect(await call({ capability: 'settings.read', method: 'get', args: {} })).toEqual({ rubric: 'accuracy' })
    await service.publish('tenant-a', 'my-json-tool', 2)
    await expect(call({ capability: 'settings.read', method: 'get', args: {} })).rejects.toMatchObject({ code: 'PLUGIN_STALE' })
    await expect(call({ capability: 'settings.read', method: 'get', args: {} }, 2)).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION' })
    await service.setPermissionGrants('tenant-a', 'my-json-tool', ['settings.read'], 2)
    expect(await call({ capability: 'settings.read', method: 'get', args: {} }, 2)).toEqual({ rubric: 'accuracy' })
    await service.setPermissionGrants('tenant-a', 'my-json-tool', [], 2)
    await expect(call({ capability: 'settings.read', method: 'get', args: {} }, 2)).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION' })
  })
})

/** Off follows a child model selection without leaking the parent's credentials or wire protocol. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveModelConfig, type ResolvedModelConfig } from '../resolve-model.js'
import { applyThinkingPreference } from '../thinking.js'

const mocks = vi.hoisted(() => ({ getModels: vi.fn(), getWhitelists: vi.fn() }))
vi.mock('../../../storage/sqlite/models.js', () => ({ ModelsStore: class { getModels = mocks.getModels; getWhitelists = mocks.getWhitelists } }))
vi.mock('../../../storage/sqlite/system-config.js', () => ({ systemConfigStore: { get: vi.fn(async () => null) } }))
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks() })

const parent: ResolvedModelConfig = { model: 'deepseek-v4.1-flash', provider: 'deepseek', apiKey: 'parent-key',
  baseUrl: 'https://parent.invalid/v1', capabilities: { thinking: true }, thinkingEnabled: false,
  thinkingConfig: { enable_thinking: false, reasoning_effort: 'low' }, responseThinkingField: null }

describe('thinking intent inherited by child model resolution', () => {
  it('retains Off and the same resolved object for a same-model child', async () => {
    const child = await resolveModelConfig({ tenantId: 't', model: parent.model, parent })
    expect(child).toBe(parent)
    expect(child.thinkingEnabled).toBe(false)
    expect(mocks.getModels).not.toHaveBeenCalled()
  })

  it('retains Off across model changes despite the child whitelist enabling thinking', async () => {
    mocks.getModels.mockResolvedValue([{ id: 'child-id', modelId: 'claude-sonnet-test', provider: 'anthropic', apiKey: 'child-key',
      baseUrl: 'https://child.invalid/anthropic', isEnabled: true, capabilities: { thinking: true } }])
    mocks.getWhitelists.mockResolvedValue([{ modelId: 'claude-sonnet-test', thinkingMode: true,
      thinkingConfig: { thinking: { type: 'enabled', budget_tokens: 1024 } }, responseThinkingField: 'thinking' }])
    const child = await resolveModelConfig({ tenantId: 't', model: 'claude-sonnet-test', parent })
    expect(child).toMatchObject({ model: 'claude-sonnet-test', apiKey: 'child-key', thinkingEnabled: false,
      thinkingConfig: null, responseThinkingField: null })
    const options = applyThinkingPreference({ model: child.model, thinkingEnabled: child.thinkingEnabled,
      thinkingConfig: child.thinkingConfig }, child.provider, child.model, child.baseUrl)
    expect(options?.thinkingConfig).toEqual({ thinking: { type: 'disabled' } })
    expect(options?.thinkingConfig).not.toHaveProperty('enable_thinking')
  })

  it('does not introduce an explicit preference for legacy callers', async () => {
    mocks.getModels.mockResolvedValue([{ id: 'child', modelId: 'qwen3', provider: 'qwen', isEnabled: true, capabilities: { thinking: true } }])
    mocks.getWhitelists.mockResolvedValue([{ modelId: 'qwen3', thinkingMode: true, thinkingConfig: { enable_thinking: true }, responseThinkingField: 'reasoning_content' }])
    const child = await resolveModelConfig({ tenantId: 't', model: 'qwen3' })
    expect(child.thinkingEnabled).toBeUndefined()
    expect(child.thinkingConfig).toEqual({ enable_thinking: true })
  })
})

import { ModelsStore } from '../../storage/sqlite/models.js'
import { loadDbCapabilityOverrides, resolveCapabilities, type ModelCapabilities } from '../model-capabilities/index.js'
import { createLLMAdapter, resolveAdapterOptionsWithDbConfig, type CreateAdapterOptions } from './factory.js'
import type { LLMAdapter } from './types.js'

/** This object holds credentials by memory reference. Never put it in history, events or logs. */
export interface ResolvedModelConfig extends CreateAdapterOptions {
  readonly model: string
  readonly provider: string
  readonly capabilities: ModelCapabilities
  readonly thinkingConfig?: Record<string, unknown> | null
  readonly responseThinkingField?: string | null
}

export interface ResolveModelOptions {
  tenantId: string
  model?: string
  parent?: ResolvedModelConfig
  overrides?: CreateAdapterOptions & {
    thinkingConfig?: Record<string, unknown> | null
    responseThinkingField?: string | null
  }
}

export async function resolveModelConfig({tenantId, model, parent, overrides}: ResolveModelOptions): Promise<ResolvedModelConfig> {
  const requested = model?.trim() || overrides?.model || parent?.model
  if (parent && (!requested || requested === parent.model) && !overrides) return parent
  // A changed model gets its own connection/capability resolution, never the parent's credentials.
  const store = new ModelsStore()
  const records = await store.getModels(tenantId)
  const record = requested ? records.find(value => value.isEnabled && (value.modelId === requested || value.id === requested)) : undefined
  const resolved = await resolveAdapterOptionsWithDbConfig({
    ...(record ? {model: record.modelId, provider: record.provider, apiKey: record.apiKey || undefined, baseUrl: record.baseUrl || undefined} : {model: requested}),
    ...overrides,
  })
  const resolvedModel = resolved.model ?? requested ?? 'gpt-4o-mini'
  const provider = resolved.provider ?? 'openai'
  const capabilities = resolveCapabilities({
    model: resolvedModel, provider, baseUrl: resolved.baseUrl,
    dbOverrides: record?.capabilities ?? await loadDbCapabilityOverrides(resolvedModel),
    overrides: overrides?.capabilities,
  })
  const whitelist = capabilities.thinking ? (await store.getWhitelists()).find(value => value.modelId === resolvedModel && value.thinkingMode) : undefined
  return Object.freeze({
    ...resolved, model: resolvedModel, provider, capabilities,
    thinkingConfig: overrides?.thinkingConfig !== undefined ? overrides.thinkingConfig : whitelist?.thinkingConfig,
    responseThinkingField: overrides?.responseThinkingField !== undefined ? overrides.responseThinkingField : whitelist?.responseThinkingField,
  })
}

export function createAdapterFromResolved(config: ResolvedModelConfig): LLMAdapter {
  return createLLMAdapter(config)
}

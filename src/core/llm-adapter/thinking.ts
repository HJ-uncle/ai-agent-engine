import type { LLMAdapterOptions } from './types.js'

type ThinkingPreference = Pick<LLMAdapterOptions, 'thinkingEnabled' | 'thinkingConfig'>

/** A non-empty configuration can explicitly disable thinking; object truthiness is insufficient. */
export function isThinkingDisabled(options?: ThinkingPreference): boolean {
  if (options?.thinkingEnabled !== undefined) return options.thinkingEnabled === false
  const config = options?.thinkingConfig
  const thinking = config?.thinking
  return config?.enable_thinking === false || config?.think === false || config?.reasoning_effort === 'none'
    || (typeof thinking === 'object' && thinking !== null && 'type' in thinking && thinking.type === 'disabled')
}

/** Resolve the user's intent at the actual wire adapter, including a fallback/child model. */
export function applyThinkingPreference(
  options: LLMAdapterOptions | undefined,
  provider: string,
  model: string,
  baseUrl?: string,
): LLMAdapterOptions | undefined {
  // Legacy callers already supplied their wire configuration; preserve it intact.
  if (options?.thinkingEnabled !== false) return options
  let thinkingConfig: Record<string, unknown> | null = null
  if (provider === 'anthropic') {
    thinkingConfig = { thinking: { type: 'disabled' } }
  } else if (provider === 'ollama') {
    thinkingConfig = { think: false }
  } else if (provider === 'deepseek' || /deepseek/i.test(model)) {
    let official = false
    try { official = new URL(baseUrl ?? '').hostname.toLowerCase() === 'api.deepseek.com' } catch { /* Unconfigured/custom gateways use the existing gateway contract. */ }
    thinkingConfig = official
      ? { thinking: { type: 'disabled' } }
      : { enable_thinking: false, reasoning_effort: 'low' }
  } else if (provider === 'qwen' || /qwen|qwq/i.test(model)) {
    thinkingConfig = { enable_thinking: false }
  }
  // Unknown compatible models have no universal off switch. Do not invent one,
  // or accidentally send the route's default medium effort after the user chose Off.
  return { ...options, model, thinkingEnabled: false, thinkingConfig, reasoningEffort: undefined, responseThinkingField: null }
}

/** Compatibility retries must not silently discard the user's explicit off switch. */
export function isProtectedThinkingParameter(name: string, options?: ThinkingPreference): boolean {
  return isThinkingDisabled(options) && ['thinking', 'enable_thinking', 'think', 'reasoning_effort'].includes(name.split('.')[0])
}

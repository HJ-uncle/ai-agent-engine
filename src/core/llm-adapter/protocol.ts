export type ApiFormat = 'auto' | 'openai' | 'anthropic'

/** Empty values explicitly restore inference; unknown protocols must not be silently guessed. */
export function normalizeApiFormat(value: unknown): ApiFormat {
  if (value == null || value === '' || value === 'auto') return 'auto'
  if (value === 'openai' || value === 'anthropic') return value
  throw new Error('API format must be auto, openai, or anthropic.')
}

/** An endpoint path can declare a protocol when no manual format is selected. */
export function declaresAnthropicProtocol(baseUrl?: string): boolean {
  return !!baseUrl && /\/anthropic(\/|$)/i.test(baseUrl)
}

export function usesAnthropicProtocol(provider?: string, baseUrl?: string, apiFormat?: ApiFormat): boolean {
  if (apiFormat && apiFormat !== 'auto') return apiFormat === 'anthropic'
  return provider?.toLowerCase() === 'anthropic' || declaresAnthropicProtocol(baseUrl)
}

export function usesNativeOllama(provider?: string, baseUrl?: string, apiFormat?: ApiFormat): boolean {
  return (!apiFormat || apiFormat === 'auto') && provider?.toLowerCase() === 'ollama' && !declaresAnthropicProtocol(baseUrl)
}

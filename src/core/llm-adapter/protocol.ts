/** An explicit wire protocol takes precedence over model-family routing. */
export function declaresAnthropicProtocol(baseUrl?: string): boolean {
  return !!baseUrl && /\/anthropic(\/|$)/i.test(baseUrl)
}

export function usesNativeOllama(provider?: string, baseUrl?: string): boolean {
  return provider?.toLowerCase() === 'ollama' && !declaresAnthropicProtocol(baseUrl)
}

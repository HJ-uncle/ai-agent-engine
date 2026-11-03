/** Preserve MCP envelopes when text alone would discard structured/resource data. */
export function renderMcpResult(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  const result = value as Record<string, unknown>
  const content = Array.isArray(result.content) ? result.content : undefined
  if (result.isError === true) {
    const text = content?.map(block => block && typeof block === 'object' && typeof block.text === 'string' ? block.text : '').filter(Boolean).join('\n')
    throw new Error(text || (result.structuredContent !== undefined ? JSON.stringify(result.structuredContent) : 'MCP tool reported an error'))
  }
  if (result.structuredContent !== undefined || content?.some(block => !block || typeof block !== 'object' || block.type !== 'text')) {
    // This is a lossless data envelope, not a claim that image/audio blocks
    // have entered a provider's native multimodal channel.
    return JSON.stringify({ ...result, contentDelivery: 'structured-data-not-native-media' })
  }
  if (content) return content.map(block => typeof block.text === 'string' ? block.text : '').join('\n')
  return typeof result.result === 'string' ? result.result : JSON.stringify(value)
}

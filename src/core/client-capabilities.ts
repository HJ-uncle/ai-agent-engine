/** A UI declaration is descriptive data, never an execution authority. */
export const CLIENT_CAPABILITY_ACTIONS = ['artifact.open', 'workspace.context', 'terminal.read', 'artifact.render'] as const
export const CLIENT_PREVIEW_FORMATS = [
  'pdf', 'docx', 'xlsx', 'pptx', 'csv', 'tsv', 'md', 'txt', 'json', 'html', 'htm',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'mp4', 'webm',
] as const

export interface ClientCapabilityManifest {
  version: 1
  application: 'aether'
  mode: 'work' | 'code'
  platform: 'win32' | 'darwin' | 'linux' | 'unknown'
  previewFormats: Array<typeof CLIENT_PREVIEW_FORMATS[number]>
  actions: Array<typeof CLIENT_CAPABILITY_ACTIONS[number]>
  connected: boolean
}

/** Drop unknown/free-text fields so client data cannot inject extra instructions. */
export function normalizeClientCapabilities(value: unknown): ClientCapabilityManifest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (input.version !== 1 || input.application !== 'aether' || !['work', 'code'].includes(String(input.mode))
    || !['win32', 'darwin', 'linux', 'unknown'].includes(String(input.platform)) || typeof input.connected !== 'boolean') return undefined
  const select = <T extends string>(raw: unknown, allowed: readonly T[]): T[] => Array.isArray(raw)
    ? [...new Set(raw.filter((item): item is T => typeof item === 'string' && allowed.includes(item as T)))].slice(0, allowed.length) : []
  return {
    version: 1, application: 'aether', mode: input.mode as ClientCapabilityManifest['mode'],
    platform: input.platform as ClientCapabilityManifest['platform'], connected: input.connected,
    previewFormats: select(input.previewFormats, CLIENT_PREVIEW_FORMATS),
    actions: select(input.actions, CLIENT_CAPABILITY_ACTIONS),
  }
}

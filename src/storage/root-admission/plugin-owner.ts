/** Ownership is minted by the server, never from plugin JSON or chat bodies. */
export interface PluginRootProvenance { pluginId: string; revision: number; boundSessionId: string }
const marked = new WeakMap<object, Readonly<PluginRootProvenance>>()

function checked(value: unknown): Readonly<PluginRootProvenance> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const owner = value as Record<string, unknown>
  if (typeof owner.pluginId !== 'string' || !owner.pluginId || owner.pluginId.length > 128
    || !Number.isSafeInteger(owner.revision) || Number(owner.revision) < 1
    || typeof owner.boundSessionId !== 'string' || !owner.boundSessionId || owner.boundSessionId.length > 256) return undefined
  return Object.freeze({ pluginId: owner.pluginId, revision: Number(owner.revision), boundSessionId: owner.boundSessionId })
}

/** Call on the exact request object passed to RootRunStore.create(). */
export function markPluginRootRequest<T extends Record<string, unknown>>(request: T, owner: PluginRootProvenance): T {
  const captured = checked(owner)
  if (!captured) throw new Error('PLUGIN_ROOT_OWNER_INVALID')
  const prior = marked.get(request)
  if (prior && JSON.stringify(prior) !== JSON.stringify(captured)) throw new Error('PLUGIN_ROOT_OWNER_CONFLICT')
  marked.set(request, captured)
  return request
}

/** Admission uses this identity-only lookup; copying JSON cannot copy authority. */
export function markedPluginRootProvenance(request: Record<string, unknown>): Readonly<PluginRootProvenance> | undefined {
  return marked.get(request)
}

/** Only pass the private request read back from RootRunStore, never client JSON. */
export function readPluginRootProvenance(storedRequest: Record<string, unknown>): Readonly<PluginRootProvenance> | undefined {
  return checked(storedRequest.pluginAgentOwner)
}

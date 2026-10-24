import type { MemoryContext, MemoryNode, MemoryScope } from '../../storage/memory/types.js'
import type { MemoryMode } from '../../storage/memory/settings.js'

export interface MemoryPolicy {
  /** Server-resolved scopes are authoritative, including an explicit empty list. */
  memoryScopes?: readonly MemoryScope[]
  /** Compatibility for internal callers predating independent preferences. */
  memoryScope?: MemoryMode
  toolProfile?: string
}

export function effectiveMemoryScopes(policy: MemoryPolicy): MemoryScope[] {
  if (process.env.ENABLE_LONG_TERM_MEMORY === 'false') return []
  if (policy.memoryScopes !== undefined) {
    return (['session', 'global'] as const).filter(scope => policy.memoryScopes!.includes(scope))
  }
  if (policy.memoryScope === 'off') return []
  if (policy.memoryScope === 'global' || policy.memoryScope === 'session') return [policy.memoryScope]
  // Legacy Code registries stay closed unless their request resolved a policy.
  // Production requests always supply scopes, with session memory on by default.
  return policy.toolProfile === 'code' ? [] : ['session']
}

export function memoryContexts(policy: MemoryPolicy & { tenantId: string; sessionId?: string }): MemoryContext[] {
  return effectiveMemoryScopes(policy).filter(scope => scope !== 'session' || !!policy.sessionId)
    .map(scope => ({ tenantId: policy.tenantId, scope, sessionId: scope === 'session' ? policy.sessionId! : '' }))
}

export function memoryWriteScope(policy: MemoryPolicy): MemoryScope | undefined {
  // Reading both must never promote private conversation content into global memory.
  return effectiveMemoryScopes(policy)[0]
}

export function deduplicateMemories<T extends Pick<MemoryNode, 'id' | 'type' | 'summary'>>(nodes: readonly T[]): T[] {
  const seen = new Set<string>()
  return nodes.filter(node => {
    const key = node.type + ':' + node.summary.trim().replace(/\s+/g, ' ').toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

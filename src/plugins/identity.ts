import type { IToolRegistry, Tool } from '../core/agent-context/types.js'

export interface PluginToolIdentity { tenantId: string; id: string; revision: number; hash: string }
/** Server-persisted code identity, separate from model-visible tool definitions. */
export interface PluginToolkitBinding extends PluginToolIdentity { toolNames: string[] }
const trustedTools = new WeakMap<Tool, Readonly<PluginToolIdentity>>()
const registries = new WeakMap<IToolRegistry, Map<string, PluginToolIdentity & { registrationVersion?: number }>>()

/** Called only after the service has verified an immutable installed snapshot. Public JSON fields grant no identity. */
export function trustPluginTool<T extends Tool>(tool: T, identity: PluginToolIdentity): T {
  trustedTools.set(tool, Object.freeze({ ...identity })); return tool
}
export function bindPluginRegistry(registry: IToolRegistry, tools: readonly Tool[]): void {
  const bindings = new Map<string, PluginToolIdentity & { registrationVersion?: number }>()
  for (const tool of tools) {
    const identity = trustedTools.get(tool)
    if (identity && registry.has(tool.name)) bindings.set(tool.name, { ...identity, registrationVersion: registry.modelToolRegistrationVersion?.(tool.name) })
  }
  registries.set(registry, bindings)
}
/** Omit removed/replaced implementations even when an extension reuses the same public name. */
export function pluginRegistryBindings(registry: IToolRegistry): PluginToolkitBinding[] {
  const grouped = new Map<string, PluginToolkitBinding>()
  for (const [name, identity] of registries.get(registry) ?? []) {
    if (!registry.has(name) || registry.modelToolRegistrationVersion?.(name) !== identity.registrationVersion) continue
    const key = JSON.stringify([identity.tenantId, identity.id, identity.revision, identity.hash])
    const group = grouped.get(key) ?? { tenantId: identity.tenantId, id: identity.id, revision: identity.revision, hash: identity.hash, toolNames: [] }
    group.toolNames.push(name); grouped.set(key, group)
  }
  return [...grouped.values()]
}
/** Carry trusted identities across server-built permission views; never hydrate them from client definitions. */
export function inheritPluginRegistryBindings(target: IToolRegistry, ...parents: IToolRegistry[]): void {
  const bindings = new Map<string, PluginToolIdentity & { registrationVersion?: number }>()
  for (const parent of parents) for (const group of pluginRegistryBindings(parent)) for (const name of group.toolNames) {
    if (target.has(name)) bindings.set(name, { tenantId: group.tenantId, id: group.id, revision: group.revision, hash: group.hash, registrationVersion: target.modelToolRegistrationVersion?.(name) })
  }
  registries.set(target, bindings)
}

import type { IToolRegistry, Tool } from '../core/agent-context/types.js'
import { ToolRegistry } from '../core/tool-registry/index.js'
import { createSelectedPluginTools, pluginToolkitId } from './catalogue.js'
import { bindPluginRegistry, inheritPluginRegistryBindings, pluginRegistryBindings, type PluginToolkitBinding } from './identity.js'
import { PluginError } from './types.js'

/** Restore original code while intersecting every original tool with the current parent's trusted plugin authority. */
export async function restorePluginBindings(tenantId: string, saved: readonly PluginToolkitBinding[], parent: IToolRegistry, names: readonly string[]): Promise<Tool[]> {
  const authorized = pluginRegistryBindings(parent)
  const selected: Tool[] = [], seen = new Set<string>(), allowedNames = new Set(names)
  for (const binding of saved) {
    if (!binding || binding.tenantId !== tenantId || typeof binding.id !== 'string' || !Number.isSafeInteger(binding.revision) || binding.revision < 1 || typeof binding.hash !== 'string' || !/^sha256:[a-f\d]{64}$/.test(binding.hash) || !Array.isArray(binding.toolNames) || !binding.toolNames.length) throw new PluginError('PLUGIN_CONTINUATION', '子代理未保存当前账户的有效插件版本，请重新创建子代理', 409)
    for (const name of binding.toolNames) {
      if (typeof name !== 'string' || seen.has(name) || !allowedNames.has(name) || !parent.has(name) || !authorized.some(current => current.tenantId === tenantId && current.id === binding.id && current.toolNames.includes(name))) throw new PluginError('PLUGIN_CONTINUATION_FORBIDDEN', '原子代理插件已不在当前父任务授权范围内，请重新选择该插件后继续', 403)
      seen.add(name)
    }
    const tools = await createSelectedPluginTools(tenantId, [pluginToolkitId(binding.id, binding.revision)])
    const registry = new ToolRegistry(); for (const tool of tools) registry.register(tool)
    bindPluginRegistry(registry, tools)
    const restored = pluginRegistryBindings(registry)
    if (!restored.some(current => current.id === binding.id && current.revision === binding.revision && current.hash === binding.hash && binding.toolNames.every(name => current.toolNames.includes(name)))) throw new PluginError('PLUGIN_CONTINUATION_CHANGED', '原子代理插件版本校验失败，拒绝用同名新版本替换', 409)
    selected.push(...tools.filter(tool => binding.toolNames.includes(tool.name)))
  }
  return selected
}

/** Use fixed plugin implementations alongside ordinary skills/MCP/builtins reconstructed for a configured Agent. */
export function withPluginTools(base: IToolRegistry, tools: readonly Tool[]): IToolRegistry {
  if (!tools.length) return base
  const plugins = new ToolRegistry(); for (const tool of tools) plugins.register(tool)
  bindPluginRegistry(plugins, tools)
  const names = new Set(tools.map(tool => tool.name)), hidden = new Set<string>(), owner = (name: string) => names.has(name) ? plugins : base
  const definitions = (forModel = false) => [...(forModel ? base.listForModel?.() ?? base.list() : base.list()).filter(tool => !names.has(tool.name)), ...plugins.list()].filter(tool => !hidden.has(tool.name))
  const view: IToolRegistry = {
    register: () => { throw new Error('Frozen plugin registry view is immutable') },
    unregister: name => { hidden.add(name) },
    has: name => !hidden.has(name) && owner(name).has(name), list: () => definitions(), listForModel: () => definitions(true),
    execute: (name, args, ctx) => { if (hidden.has(name)) throw new PluginError('PLUGIN_TOOL', '工具不在此执行目录内', 403); return owner(name).execute(name, args, ctx) },
    preflight: (name, args, ctx) => owner(name).preflight?.(name, args, ctx) ?? Promise.resolve(undefined),
    executionMode: (name, args) => owner(name).executionMode?.(name, args) ?? 'serial',
    modelToolRegistrationVersion: name => owner(name).modelToolRegistrationVersion?.(name),
    hasModelToolLoader: () => base.hasModelToolLoader?.() === true,
    modelToolLoadingCandidates: () => (base.modelToolLoadingCandidates?.() ?? []).filter(name => !names.has(name)),
    supportsHistoryProjection: name => !names.has(name) && base.supportsHistoryProjection?.(name) === true,
    supportsOfficeEvidence: name => !names.has(name) && base.supportsOfficeEvidence?.(name) === true,
    supportsScreenshotEvidence: name => !names.has(name) && base.supportsScreenshotEvidence?.(name) === true,
    skillsForPrompt: () => base.skillsForPrompt?.() ?? [],
  }
  inheritPluginRegistryBindings(view, base, plugins)
  return view
}

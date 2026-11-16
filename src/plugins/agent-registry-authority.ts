import type { AgentContext, IToolRegistry, ToolResult } from '../core/agent-context/types.js'
import { PluginError } from './types.js'

type Guard = (name: string, context: AgentContext) => Promise<void>
const authorities = new WeakMap<IToolRegistry, readonly Guard[]>()
const guarded = new WeakSet<IToolRegistry>()

/** A server-owned capability follows native registry views; JSON definitions cannot copy it. */
export function bindPluginAgentRegistryAuthority(registry: IToolRegistry, guard: Guard): void {
  authorities.set(registry, [guard])
}

export function inheritPluginAgentRegistryAuthority(target: IToolRegistry, ...parents: IToolRegistry[]): void {
  const guards = [...new Set(parents.flatMap(parent => authorities.get(parent) ?? []))]
  if (!guards.length) return
  authorities.set(target, guards)
}

/** Only concrete new registries are wrapped; Proxy views merely inherit identity. */
export function guardPluginAgentChildRegistry(target: IToolRegistry, parent: IToolRegistry): void {
  inheritPluginAgentRegistryAuthority(target, parent)
  if (!authorities.has(target)) return
  for (const tool of target.list()) if (!parent.has(tool.name)) target.unregister(tool.name)
  if (guarded.has(target)) return
  guarded.add(target)
  const check = async (name: string, ctx: AgentContext): Promise<ToolResult | undefined> => {
    try { for (const guard of authorities.get(target) ?? []) await guard(name, ctx) }
    catch (error) { return { success: false, error: 'PLUGIN_AGENT_TOOL_FORBIDDEN', output: error instanceof PluginError ? error.message : '工具授权校验失败' } }
  }
  const preflight = target.preflight?.bind(target), execute = target.execute.bind(target)
  target.preflight = async (name, args, ctx) => await check(name, ctx) ?? await preflight?.(name, args, ctx)
  target.execute = async (name, args, ctx) => await check(name, ctx) ?? await execute(name, args, ctx)
}

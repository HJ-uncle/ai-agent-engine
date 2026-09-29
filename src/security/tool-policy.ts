import type { AgentContext, Tool, ToolResult } from '../core/agent-context/index.js'
import { getSecurityMode } from './policy-engine.js'

/** Trust attaches to implementations, not model-supplied or extension-supplied names. */
const trustedModes = new WeakMap<Tool, 'readonly' | 'subagent' | 'serial'>()
export function trustBuiltinTool<T extends Tool>(tool: T, mode: 'readonly' | 'subagent' | 'serial' = 'serial'): T {
  trustedModes.set(tool, mode)
  return tool
}

export function toolExecutionMode(tool: Tool): 'readonly' | 'subagent' | 'serial' {
  return trustedModes.get(tool) ?? 'serial'
}

export function extensionPolicy(ctx: Pick<AgentContext, 'tenantId' | 'sessionId'>): ToolResult | undefined {
  if (getSecurityMode(ctx.tenantId, ctx.sessionId) !== 'safe') return undefined
  return { success: false, output: '安全模式无法约束此扩展的文件、命令或网络副作用，因此当前不可执行。',
    metadata: { blocked: true, policy: 'uncontained_extension', securityMode: 'safe' } }
}

export async function preflightTool(tool: Tool, args: unknown, ctx: AgentContext): Promise<ToolResult | undefined> {
  const source = (tool as Tool & { source?: string }).source
  if (!trustedModes.has(tool) && (source === 'skill' || source === 'mcp' || tool.name.startsWith('mcp_'))) {
    const denied = extensionPolicy(ctx)
    if (denied) return denied
  }
  return tool.preflight?.(args, ctx)
}

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { PluginError } from './types.js'
import { pluginAgentConfigurationSchema, type PluginAgentConfiguration } from './capability-contract.js'
import type { PluginCapabilityId } from './capabilities.js'
import type { JSONSchema } from '../core/agent-context/types.js'

export function resolvePluginAgentConfiguration(input: PluginAgentConfiguration, prior?: PluginAgentConfiguration, resuming = false): PluginAgentConfiguration {
  const normalize = (config: PluginAgentConfiguration) => ({ ...config,
    ...(config.skillIds ? { skillIds: [...new Set(config.skillIds)].sort() } : {}),
    ...(config.mcpServerIds ? { mcpServerIds: [...new Set(config.mcpServerIds)].sort() } : {}),
    ...(config.disabledTools ? { disabledTools: [...new Set(config.disabledTools)].sort() } : {}) })
  const next = normalize(pluginAgentConfigurationSchema.parse(input))
  if (!resuming) return next
  const supplied = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined))
  return normalize({ ...prior, ...supplied, ...(next.identity ? { identity: { ...prior?.identity, ...next.identity } } : {}) })
}

export interface PluginMountedMcpTool { registrationName: string; serverId: string; name: string; description: string; inputSchema: JSONSchema }
type HostCall = (capability: PluginCapabilityId, method: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>

/** Read current mounted content only through the same authorized SDK dispatcher as plugin code. */
export async function preparePluginAgentMounts(config: PluginAgentConfiguration, invoke: HostCall, signal?: AbortSignal) {
  const skills: string[] = [], mcpTools: PluginMountedMcpTool[] = []
  for (const id of config.skillIds ?? []) {
    const skill = z.object({ id: z.string(), name: z.string(), content: z.string() }).parse(await invoke('skills.read', 'get', { id }, signal))
    skills.push(`### ${skill.name}\n${skill.content}`)
  }
  for (const serverId of config.mcpServerIds ?? []) {
    const result = z.object({ tools: z.array(z.object({ name: z.string().min(1), description: z.string().optional(), inputSchema: z.record(z.unknown()) })) })
      .parse(await invoke('mcp.read', 'tools', { serverId }, signal))
    for (const tool of result.tools) {
      const registrationName = 'ae_mcp_' + createHash('sha256').update(JSON.stringify([serverId, tool.name])).digest('hex').slice(0, 12)
        + '_' + tool.name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32)
      // Root object parameters are required by supported model tool protocols.
      if (tool.inputSchema.type !== 'object') throw new PluginError('PLUGIN_MCP_SCHEMA', '挂载 MCP 工具的参数必须是 object 类型，请检查服务器工具定义')
      if (mcpTools.some(item => item.registrationName === registrationName)) throw new PluginError('PLUGIN_MCP_SCHEMA', 'MCP 服务器返回了重复工具定义')
      mcpTools.push({ registrationName, serverId, name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema as JSONSchema })
    }
  }
  return { skillPrompt: skills.join('\n\n'), mcpTools }
}

export function assertPluginAgentMountScope(config: PluginAgentConfiguration, capability: PluginCapabilityId, method: string, args: Record<string, unknown>): void {
  if (config.skillIds !== undefined && capability === 'skills.read' && method === 'get' && !config.skillIds.includes(String(args.id)))
    throw new PluginError('PLUGIN_AGENT_SCOPE', '此 Skill 未挂载到当前 Agent', 403)
  if (config.mcpServerIds !== undefined && ((capability === 'mcp.read' && method === 'tools') || capability === 'mcp.invoke')) {
    if (!config.mcpServerIds.includes(String(args.serverId))) throw new PluginError('PLUGIN_AGENT_SCOPE', '此 MCP 服务器未挂载到当前 Agent', 403)
  }
}


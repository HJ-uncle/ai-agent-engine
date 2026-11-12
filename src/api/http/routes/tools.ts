import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getRequestToolProfile } from '../tool-profile.js'
import { createToolRegistry } from '../../../tools/registry-factory.js'
import { paginateArray, success } from '../response.js'
import { skillsRegistry } from '../../../skills/index.js'
import { SQLiteAgentStore } from '../../../storage/agent/index.js'
import { workspaceManager } from '../../../workspace/index.js'
import { toolSource } from '../../../core/runtime-capabilities.js'
import { recommendedAgentTools } from '../../../core/agent-management.js'
import { SessionStore } from '../../../storage/session/index.js'
import { TOOLKIT_CATALOGUE, assertToolkitPermissions } from '../../../tools/toolkits.js'
import type { AuthContext } from '../../../auth/types.js'
import { pluginCatalogue, pluginToolDefinitions } from '../../../plugins/catalogue.js'
import { assertPluginManagementAccess } from '../../../plugins/access.js'
import { assertMcpManagementAccess } from '../../../storage/mcp/management-service.js'

interface ToolQuery { current?: number; pageSize?: number; agentId?: string; path?: string }

function catalogueWorkspaceRoot(request: FastifyRequest<{ Querystring: ToolQuery }>, tenantId: string): string | undefined {
  const value: unknown = request.query.path
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw Object.assign(new Error('path must be a valid workspace directory'), { statusCode: 400 })
  }
  try { return workspaceManager.resolveProjectDirectory(tenantId, value) }
  catch (error) {
    throw Object.assign(new Error(error instanceof Error ? error.message : 'Workspace directory is not available'), { statusCode: 403 })
  }
}

export async function toolRoutes(fastify: FastifyInstance) {
  const agentStore = new SQLiteAgentStore()

  fastify.get<{ Querystring: ToolQuery & { sessionId?: string } }>('/toolkits', async (request, reply) => {
    if (getRequestToolProfile(request) !== 'general') return reply.send(success({ toolkits: [] }))
    const auth = (request as FastifyRequest & { authContext?: AuthContext }).authContext
    const tenantId = auth?.tenantId ?? 'default'
    if (request.query.path) catalogueWorkspaceRoot(request, tenantId)
    const binding = request.query.sessionId ? await new SessionStore().getBinding(request.query.sessionId, tenantId) : undefined
    const agentId = binding ? binding.agentId : request.query.agentId
    const agent = agentId ? await agentStore.getById(agentId, tenantId) : undefined
    const canManageSkills = process.env.AUTH_ENABLED === 'false' && (!auth || auth.method === 'none') ||
      auth?.roles?.some(role => role === 'admin' || role === 'skill-manager') === true
    const builtin = TOOLKIT_CATALOGUE.map(toolkit => {
      let reason: string | undefined
      if (agentId && !agent) reason = '绑定的 Agent 已不可用，请重新选择'
      else {
        try { assertToolkitPermissions([toolkit.id], agent?.allowedTools) }
        catch (error) { reason = error instanceof Error ? error.message : String(error) }
      }
      if (!reason && toolkit.id === 'skill-management' && !canManageSkills) reason = '需要技能管理权限'
      if (!reason && toolkit.id === 'plugin-management') {
        try { assertPluginManagementAccess(tenantId, auth) }
        catch (error) { reason = error instanceof Error ? error.message : String(error) }
      }
      if (!reason && toolkit.id === 'mcp-management') {
        try { assertMcpManagementAccess(tenantId, auth) }
        catch (error) { reason = error instanceof Error ? error.message : String(error) }
      }
      return { ...toolkit, available: !reason, ...(reason ? { reason } : {}) }
    })
    const plugins = await pluginCatalogue(tenantId, [agent?.allowedTools])
    return reply.send(success({ toolkits: [...builtin, ...plugins.map(plugin => agentId && !agent ? { ...plugin, available: false, reason: '绑定的 Agent 已不可用，请重新选择' } : plugin)] }))
  })

  // 获取所有工具列表（包括系统工具和技能工具）
  fastify.get<{ Querystring: ToolQuery }>('/tools', async (request, reply) => {
    const toolProfile = getRequestToolProfile(request)
    const { current, pageSize, agentId } = request.query
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const workspaceRoot = catalogueWorkspaceRoot(request, tenantId)

    let allowedTools: string[] | null = null
    let allowedSkills: string[] | null = null
    let allowedMcpServers: string[] | null = null
    let agentAvailable = !agentId
    if (agentId) {
      const agent = await agentStore.getById(agentId, tenantId)
      if (agent) {
        agentAvailable = true
        allowedTools = agent.allowedTools
        allowedSkills = agent.skills
        allowedMcpServers = agent.mcpServers
      }
    }

    const defaultTools = new Set(await recommendedAgentTools(toolProfile))
    const { registry } = await createToolRegistry({ toolProfile, allowedTools, allowedSkills, allowedMcpServers, workspaceRoot,
      ...(!agentId ? { toolExposure: 'catalogue' as const } : {}) })
    const pluginDefinitions = toolProfile === 'general' && agentAvailable ? await pluginToolDefinitions(tenantId, allowedTools) : []
    const toolsList = [...registry.list(), ...pluginDefinitions].map(t => ({
      name: t.name,
      displayName: t.displayName,
      description: t.description,
      parameters: t.parameters,
      source: toolSource(t),
      defaultEnabled: defaultTools.has(t.name),
      ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
    }))
    return reply.code(200).send(paginateArray(toolsList, current, pageSize))
  })

  // 获取系统工具列表（排除技能工具）
  fastify.get<{ Querystring: ToolQuery }>('/system-tools', async (request, reply) => {
    const toolProfile = getRequestToolProfile(request)
    const { current, pageSize, agentId } = request.query
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const workspaceRoot = catalogueWorkspaceRoot(request, tenantId)

    // 不传 agentId 时：不做任何过滤，返回全量系统工具（用于展示可选工具列表）
    // 传 agentId 时：按 Agent 配置过滤，返回该 Agent 实际可用的工具
    let allowedTools: string[] | null = null
    let allowedSkills: string[] | null = null
    let allowedMcpServers: string[] | null = null
    let agentAvailable = !agentId
    if (agentId) {
      const agent = await agentStore.getById(agentId, tenantId)
      if (agent) {
        agentAvailable = true
        allowedTools = agent.allowedTools
        allowedSkills = agent.skills
        allowedMcpServers = agent.mcpServers
      }
    }

    const defaultTools = new Set(await recommendedAgentTools(toolProfile))
    const { registry } = await createToolRegistry({ toolProfile, allowedTools, allowedSkills, allowedMcpServers, workspaceRoot,
      ...(!agentId ? { toolExposure: 'catalogue' as const } : {}) })
    const pluginDefinitions = toolProfile === 'general' && agentAvailable ? await pluginToolDefinitions(tenantId, allowedTools) : []
    const toolsList = [...registry.list(), ...pluginDefinitions]
      .filter(t => toolSource(t) !== 'skill')
      .map(t => ({
        name: t.name,
        displayName: t.displayName,
        description: t.description,
        parameters: t.parameters,
        source: toolSource(t),
        defaultEnabled: defaultTools.has(t.name),
        ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
      }))
    return reply.code(200).send(paginateArray(toolsList, current, pageSize))
  })

  // 获取自定义技能列表（SKILLs 目录中的技能）
  fastify.get<{ Querystring: { current?: number; pageSize?: number } }>('/external-skills', async (request, reply) => {
    const skills = skillsRegistry.getSkills()
    const skillsList = skills.map(s => ({
      name: s.name,
      description: s.description,
      enabled: s.enabled,
      order: s.order,
    }))
    const { current, pageSize } = request.query
    return reply.code(200).send(paginateArray(skillsList, current, pageSize))
  })
}

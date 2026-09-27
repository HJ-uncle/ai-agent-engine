import type { FastifyInstance } from 'fastify'
import { createToolRegistry } from '../../../tools/registry-factory.js'
import { paginateArray } from '../response.js'
import { skillsRegistry } from '../../../skills/index.js'
import { SQLiteAgentStore } from '../../../storage/agent/index.js'

export async function toolRoutes(fastify: FastifyInstance) {
  const agentStore = new SQLiteAgentStore()

  // 获取所有工具列表（包括系统工具和技能工具）
  fastify.get<{ Querystring: { current?: number; pageSize?: number; agentId?: string } }>('/tools', async (request, reply) => {
    const { current, pageSize, agentId } = request.query
    const tenantId = (request as any).authContext?.tenantId ?? 'default'

    let allowedTools: string[] | null = null
    let allowedSkills: string[] | null = null
    if (agentId) {
      const agent = await agentStore.getById(agentId, tenantId)
      if (agent) {
        allowedTools = agent.allowedTools
        allowedSkills = agent.skills
      }
    }

    const { registry } = await createToolRegistry({ allowedTools, allowedSkills })
    const toolsList = registry.list().map(t => ({
      name: t.name,
      displayName: (t as any).displayName,
      description: t.description,
      parameters: t.parameters,
      source: (t as any).source === 'skill' ? 'skill' : 'builtin'
    }))
    return reply.code(200).send(paginateArray(toolsList, current, pageSize))
  })

  // 获取系统工具列表（排除技能工具）
  fastify.get<{ Querystring: { current?: number; pageSize?: number; agentId?: string } }>('/system-tools', async (request, reply) => {
    const { current, pageSize, agentId } = request.query
    const tenantId = (request as any).authContext?.tenantId ?? 'default'

    // 不传 agentId 时：不做任何过滤，返回全量系统工具（用于展示可选工具列表）
    // 传 agentId 时：按 Agent 配置过滤，返回该 Agent 实际可用的工具
    let allowedTools: string[] | null = null
    let allowedSkills: string[] | null = null
    if (agentId) {
      const agent = await agentStore.getById(agentId, tenantId)
      if (agent) {
        allowedTools = agent.allowedTools
        allowedSkills = agent.skills
      }
    }

    const { registry } = await createToolRegistry({ allowedTools, allowedSkills })
    const toolsList = registry.list()
      .filter(t => (t as any).source !== 'skill')
      .map(t => ({
        name: t.name,
        displayName: (t as any).displayName,
        description: t.description,
        parameters: t.parameters,
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
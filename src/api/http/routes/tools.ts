import type { FastifyInstance } from 'fastify'
import { createToolRegistry } from '../../../tools/registry-factory.js'
import { paginateArray } from '../response.js'
import { skillsRegistry } from '../../../skills/index.js'

export async function toolRoutes(fastify: FastifyInstance) {
  // 获取所有工具列表（包括系统工具和技能工具）
  fastify.get<{ Querystring: { current?: number; pageSize?: number } }>('/tools', async (request, reply) => {
    const { registry } = await createToolRegistry()
    const toolsList = registry.list().map(t => ({
      name: t.name,
      displayName: (t as any).displayName,
      description: t.description,
      parameters: t.parameters,
      source: (t as any).source === 'skill' ? 'skill' : 'builtin'
    }))
    const { current, pageSize } = request.query
    return reply.code(200).send(paginateArray(toolsList, current, pageSize))
  })

  // 获取系统工具列表（排除技能工具）
  fastify.get<{ Querystring: { current?: number; pageSize?: number } }>('/system-tools', async (request, reply) => {
    const { registry } = await createToolRegistry()
    const toolsList = registry.list()
      .filter(t => (t as any).source !== 'skill')
      .map(t => ({
        name: t.name,
        displayName: (t as any).displayName,
        description: t.description,
        parameters: t.parameters,
      }))
    const { current, pageSize } = request.query
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

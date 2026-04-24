import type { FastifyInstance } from 'fastify'
import { ToolRegistry } from '../../../core/tool-registry/index.js'
import { registerBuiltinSkills } from '../../../skills/index.js'
import { fileTools } from '../../../tools/file/index.js'
import { cmdTool } from '../../../tools/cmd/index.js'
import { createMemoryTools } from '../../../tools/memory/index.js'
import { SQLiteMemoryStore } from '../../../storage/memory-store/index.js'
import { registerMCPTools } from '../../../tools/mcp/loader.js'
import { paginateArray } from '../response.js'

export async function toolRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { current?: number; pageSize?: number } }>('/tools', async (request, reply) => {
    const registry = new ToolRegistry()
    registerBuiltinSkills(registry)
    fileTools.forEach((t) => registry.register(t))
    registry.register(cmdTool)
    createMemoryTools(new SQLiteMemoryStore()).forEach((t) => registry.register(t))
    // 加载 MCP 工具（与 chat 路由保持一致）
    await registerMCPTools(registry)
    const toolsList = registry.list().map(t => ({
      name: t.name,
      displayName: (t as any).displayName,
      description: t.description,
      parameters: t.parameters,
      source: 'builtin'
    }))
    const { current, pageSize } = request.query
    return reply.code(200).send(paginateArray(toolsList, current, pageSize))
  })
}

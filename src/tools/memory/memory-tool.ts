import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { SQLiteMemoryManager } from '../../storage/memory/memory-manager.js'
import { getMemoryDb } from '../../storage/memory/db.js'

export function createMemoryTools(): Tool[] {
  const manager = new SQLiteMemoryManager()

  const rememberTool: Tool = {
    name: 'remember',
    displayName: '记录记忆',
    description: '使用三脑架构的语义记忆体记录重要信息、偏好、经验或决策。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '记忆的内容，使用简洁完整的陈述句' },
        type: { type: 'string', enum: ['fact', 'preference', 'decision', 'lesson', 'narrative', 'milestone'], description: '记忆类型' },
        tags: { type: 'array', items: { type: 'string' }, description: '3-5个分类标签' },
        emotionalValence: { type: 'number', description: '情感效价 (-1.0 到 1.0)，-1为极度负面，1为极度正面', default: 0.0 },
        emotionalTrigger: { type: 'string', description: '具体激发该情绪的事物或情境，如果情绪强烈请务必填写' },
      },
      required: ['content', 'type', 'tags'],
    },
    async execute(args: unknown, ctx: AgentContext): Promise<ToolResult> {
      const { content, type, tags, emotionalValence, emotionalTrigger } = args as any
      
      const node = await manager.createNode({
        type: type,
        summary: content,
        importance: 0.8,
        sourceSessionId: ctx.sessionId,
        tags: tags,
        emotionalValence: emotionalValence ?? 0.0,
        emotionalTrigger: emotionalTrigger,
      }, { tenantId: ctx.tenantId, sessionId: ctx.sessionId })
      
      return { success: true, output: `✅ 已成功记录记忆 (ID: ${node.id}): ${content}\n💡 提示: 如果你认为这条记忆与其他记忆存在关联（如矛盾、相似等），请接着使用 link_memories 工具进行连线。` }
    },
  }

  const recallTool: Tool = {
    name: 'recall',
    displayName: '记忆检索',
    description: '通过标签检索语义记忆网络中的相关记忆节点',
    parameters: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' }, description: '用于检索的标签列表' },
      },
      required: ['tags'],
    },
    async execute(args: unknown, ctx: AgentContext): Promise<ToolResult> {
      const { tags } = args as { tags: string[] }
      const nodes = await manager.recallByTags(tags, { tenantId: ctx.tenantId, sessionId: ctx.sessionId })
      
      if (nodes.length === 0) {
        return { success: true, output: `未找到与标签 ${tags.join(', ')} 相关的记忆。` }
      }
      
      const lines = nodes.map(n => `- [${n.type}] ${n.summary} (相关度: ${n.strength.toFixed(2)})`)
      return { success: true, output: `找到 ${nodes.length} 条相关记忆:\n${lines.join('\n')}` }
    },
  }

  const listMemoriesTool: Tool = {
    name: 'list_memories',
    displayName: '列出近期记忆',
    description: '列出记忆体中最近更新的记忆节点',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回数量限制，默认10' }
      },
      required: [],
    },
    async execute(args: unknown, ctx: AgentContext): Promise<ToolResult> {
      const { limit = 10 } = args as any
      const nodes = await manager.recallRecent(limit, { tenantId: ctx.tenantId, sessionId: ctx.sessionId })
      
      if (nodes.length === 0) {
        return { success: true, output: '记忆体为空。' }
      }
      
      const lines = nodes.map(n => `- [${n.id}] [${n.type}] ${n.summary} (标签: ${n.tags?.join(',')})`)
      return { success: true, output: `最近的 ${nodes.length} 条记忆:\n${lines.join('\n')}` }
    },
  }

  const forgetTool: Tool = {
    name: 'forget',
    displayName: '删除记忆',
    description: '根据记忆 ID 从记忆体中删除节点',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删除的记忆节点 ID' },
      },
      required: ['id'],
    },
    async execute(args: unknown, ctx: AgentContext): Promise<ToolResult> {
      const { id } = args as { id: string }
      await manager.deleteNode(id, { tenantId: ctx.tenantId, sessionId: ctx.sessionId })
      return { success: true, output: `✅ 记忆 ${id} 已被删除。` }
    },
  }

  const linkMemoriesTool: Tool = {
    name: 'link_memories',
    displayName: '建立记忆关联',
    description: '主动在两个记忆节点之间建立关联边（如：矛盾、相似、导致等），用于构建认知图谱',
    parameters: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: '源记忆节点的 ID' },
        targetId: { type: 'string', description: '目标记忆节点的 ID' },
        type: { 
          type: 'string', 
          enum: ['reinforces', 'contradicts', 'leads_to', 'part_of', 'similar_to', 'tagged_with'],
          description: '关联类型：强化(reinforces)、矛盾(contradicts)、导致(leads_to)、组成部分(part_of)、相似(similar_to)、共享标签(tagged_with)' 
        },
        description: { type: 'string', description: '描述这种关联的具体原因或你的理解（如：这次决策与之前的偏好相矛盾，说明偏好在演变）' },
        strength: { type: 'number', description: '关联强度 (0.0 到 1.0)', default: 0.5 },
      },
      required: ['sourceId', 'targetId', 'type', 'description'],
    },
    async execute(args: unknown, ctx: AgentContext): Promise<ToolResult> {
      const { sourceId, targetId, type, description, strength = 0.5 } = args as any
      if (sourceId === targetId) return { success: false, output: '源节点和目标节点不能是同一个' }
      
      const db = (manager as any).db || getMemoryDb()
      const tenantId = ctx.tenantId || 'default'
      const id = 'EDGE-' + crypto.randomUUID()
      
      try {
        await db.execute({
          sql: `INSERT INTO memory_edges (id, tenant_id, source_node_id, target_node_id, type, strength, description) 
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [id, tenantId, sourceId, targetId, type, strength, description]
        })
        return { success: true, output: `✅ 成功建立关联: [${sourceId}] -(${type})-> [${targetId}]` }
      } catch (e: any) {
        return { success: false, output: `建立关联失败: ${e.message}。请确保节点ID正确存在。` }
      }
    },
  }

  return [rememberTool, recallTool, listMemoriesTool, forgetTool, linkMemoriesTool]
}

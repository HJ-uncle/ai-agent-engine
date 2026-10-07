import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { SQLiteMemoryManager } from '../../storage/memory/memory-manager.js'
import type { MemoryContext, MemoryEdgeType, MemoryNodeType, MemoryScope } from '../../storage/memory/types.js'

type MemoryToolContext = AgentContext & {
  /** Request-level setting; never supplied by model tool arguments. */
  memoryScope?: 'off' | MemoryScope
}

function resolveMemoryContext(ctx: MemoryToolContext): { context?: MemoryContext; error?: string } {
  const configured = ctx.memoryScope ?? (ctx.toolProfile === 'code' ? 'off' : 'global')
  if (configured === 'off') return { error: '长期记忆已对当前会话关闭。' }
  if (configured === 'session' && !ctx.sessionId) return { error: '当前会话缺少 sessionId，无法使用会话记忆。' }
  // Deliberately use only the current context session.  rootSessionId is
  // metadata for the run and must never let a subagent read the parent memory.
  return {
    context: {
      tenantId: ctx.tenantId,
      sessionId: configured === 'session' ? ctx.sessionId : '',
      scope: configured,
    },
  }
}

function disabledResult(message: string): ToolResult {
  return { success: false, output: message, error: 'MEMORY_DISABLED' }
}

export function createMemoryTools(): Tool[] {
  const manager = new SQLiteMemoryManager()

  const rememberTool: Tool = {
    name: 'remember',
    displayName: '记录记忆',
    description: '使用三脑架构的语义记忆体记录重要信息、偏好、经验或决策。记忆范围由当前会话设置决定。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '记忆的内容，使用简洁完整的陈述句' },
        type: { type: 'string', enum: ['fact', 'preference', 'decision', 'lesson', 'narrative', 'milestone'], description: '记忆类型' },
        tags: { type: 'array', items: { type: 'string' }, description: '3-5个分类标签' },
        emotionalValence: { type: 'number', description: '情感效价 (-1.0 到 1.0)' },
        emotionalTrigger: { type: 'string', description: '触发情绪的事物或情境' },
      },
      required: ['content', 'type', 'tags'],
    },
    async execute(args: unknown, rawCtx: AgentContext): Promise<ToolResult> {
      const ctx = rawCtx as MemoryToolContext
      const resolved = resolveMemoryContext(ctx)
      if (!resolved.context) return disabledResult(resolved.error!)
      const { content, type, tags, emotionalValence, emotionalTrigger } = args as any
      const node = await manager.createNode({
        type: type as MemoryNodeType,
        summary: content,
        importance: 0.8,
        sourceSessionId: ctx.sessionId,
        tags,
        emotionalValence: emotionalValence ?? 0.0,
        emotionalTrigger,
      }, resolved.context)
      return { success: true, output: `✅ 已成功记录记忆 (ID: ${node.id}): ${content}` }
    },
  }

  const recallTool: Tool = {
    name: 'recall',
    displayName: '记忆检索',
    description: '通过标签检索当前记忆范围内的相关节点。',
    parameters: {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' }, description: '用于检索的标签列表' } },
      required: ['tags'],
    },
    async execute(args: unknown, rawCtx: AgentContext): Promise<ToolResult> {
      const ctx = rawCtx as MemoryToolContext
      const resolved = resolveMemoryContext(ctx)
      if (!resolved.context) return disabledResult(resolved.error!)
      const { tags } = args as { tags: string[] }
      const nodes = await manager.recallByTags(tags, resolved.context)
      if (nodes.length === 0) return { success: true, output: `未找到与标签 ${tags.join(', ')} 相关的记忆。` }
      return { success: true, output: `找到 ${nodes.length} 条相关记忆:\n${nodes.map(n => `- [${n.type}] ${n.summary} (相关度: ${n.strength.toFixed(2)})`).join('\n')}` }
    },
  }

  const listMemoriesTool: Tool = {
    name: 'list_memories',
    displayName: '列出近期记忆',
    description: '列出当前记忆范围内最近更新的节点。',
    parameters: { type: 'object', properties: { limit: { type: 'number', description: '返回数量限制，默认10' } }, required: [] },
    async execute(args: unknown, rawCtx: AgentContext): Promise<ToolResult> {
      const ctx = rawCtx as MemoryToolContext
      const resolved = resolveMemoryContext(ctx)
      if (!resolved.context) return disabledResult(resolved.error!)
      const { limit = 10 } = args as any
      const nodes = await manager.recallRecent(Math.min(Math.max(Number(limit) || 10, 1), 100), resolved.context)
      if (nodes.length === 0) return { success: true, output: '记忆体为空。' }
      return { success: true, output: `最近的 ${nodes.length} 条记忆:\n${nodes.map(n => `- [${n.id}] [${n.type}] ${n.summary} (标签: ${n.tags?.join(',') ?? ''})`).join('\n')}` }
    },
  }

  const forgetTool: Tool = {
    name: 'forget',
    displayName: '删除记忆',
    description: '根据记忆 ID 从当前记忆范围中删除节点。',
    parameters: { type: 'object', properties: { id: { type: 'string', description: '要删除的记忆节点 ID' } }, required: ['id'] },
    async execute(args: unknown, rawCtx: AgentContext): Promise<ToolResult> {
      const ctx = rawCtx as MemoryToolContext
      const resolved = resolveMemoryContext(ctx)
      if (!resolved.context) return disabledResult(resolved.error!)
      const { id } = args as { id: string }
      if (!await manager.getNode(id, resolved.context)) return { success: false, output: `记忆 ${id} 不存在于当前记忆范围。`, error: 'MEMORY_NOT_FOUND' }
      await manager.deleteNode(id, resolved.context)
      return { success: true, output: `✅ 记忆 ${id} 已被删除。` }
    },
  }

  const linkMemoriesTool: Tool = {
    name: 'link_memories',
    displayName: '建立记忆关联',
    description: '在当前记忆范围内的两个节点之间建立关联。',
    parameters: {
      type: 'object',
      properties: {
        sourceId: { type: 'string' },
        targetId: { type: 'string' },
        type: { type: 'string', enum: ['reinforces', 'contradicts', 'leads_to', 'part_of', 'similar_to', 'tagged_with'] },
        description: { type: 'string' },
        strength: { type: 'number', default: 0.5 },
      },
      required: ['sourceId', 'targetId', 'type', 'description'],
    },
    async execute(args: unknown, rawCtx: AgentContext): Promise<ToolResult> {
      const ctx = rawCtx as MemoryToolContext
      const resolved = resolveMemoryContext(ctx)
      if (!resolved.context) return disabledResult(resolved.error!)
      const { sourceId, targetId, type, description, strength = 0.5 } = args as any
      if (sourceId === targetId) return { success: false, output: '源节点和目标节点不能是同一个' }
      const [source, target] = await Promise.all([manager.getNode(sourceId, resolved.context), manager.getNode(targetId, resolved.context)])
      if (!source || !target) return { success: false, output: '建立关联失败：两个节点都必须属于当前记忆范围。', error: 'MEMORY_NOT_FOUND' }
      try {
        const edge = await manager.createEdge({ sourceNodeId: sourceId, targetNodeId: targetId, type: type as MemoryEdgeType, strength, description }, resolved.context)
        return { success: true, output: `✅ 成功建立关联: [${sourceId}] -(${edge.type})-> [${targetId}]` }
      } catch (e: any) {
        return { success: false, output: `建立关联失败: ${e?.message ?? e}` }
      }
    },
  }

  return [rememberTool, recallTool, listMemoriesTool, forgetTool, linkMemoriesTool]
}

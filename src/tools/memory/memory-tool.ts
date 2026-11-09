import { memoryContexts } from '../../middleware/memory/policy.js'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { SQLiteMemoryManager } from '../../storage/memory/memory-manager.js'
import type { MemoryContext, MemoryEdgeType, MemoryNodeType } from '../../storage/memory/types.js'

const memoryPageParameters = {
  keyword: { type: 'string', description: '记忆原文的字面子串，区分大小写；不拆词、不解析通配符或正则。可用来定位标签未知的旧副本。' },
  offset: { type: 'number', description: '从0开始的结果偏移；继续读取用nextOffset。删除会改变偏移，删完一批必须从0重查，避免跳漏。' },
}

function memoryPageArgs(args: { limit?: number; offset?: number; keyword?: string }, defaultLimit: number) {
  return {
    limit: Math.min(100, Math.max(1, Math.floor(Number(args.limit ?? defaultLimit)) || defaultLimit)),
    offset: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(Number(args.offset)) || 0)),
    keyword: typeof args.keyword === 'string' ? args.keyword : undefined,
  }
}

function memoryPageResult(nodes: Awaited<ReturnType<SQLiteMemoryManager['listNodesInContexts']>>, page: ReturnType<typeof memoryPageArgs>, heading: string): ToolResult {
  const hasMore = nodes.length > page.limit
  const visible = nodes.slice(0, page.limit)
  const pagination = { offset: page.offset, limit: page.limit, returned: visible.length, hasMore, nextOffset: hasMore ? page.offset + visible.length : null }
  const lines = visible.map(n => `- [${n.id}] [${n.scope}] [${n.type}] ${n.summary} (标签: ${n.tags?.join(',') ?? ''}; 相关度: ${n.strength.toFixed(2)})`)
  return { success: true, output: `${heading.replace('{count}', String(visible.length))}${lines.length ? '\n' + lines.join('\n') : ''}\n分页: ${JSON.stringify(pagination)}\n删除一批后从 offset=0 重查；hasMore=true 时当前页不足以确认不存在。`,
    metadata: { memoryPage: pagination, memoryNodes: visible.map(n => ({ id: n.id, scope: n.scope, summary: n.summary, tags: n.tags ?? [] })) } }
}

function resolveMemoryContext(ctx: AgentContext): { context?: MemoryContext; contexts: MemoryContext[]; error?: string } {
  // Scope is server policy, never a model argument. Child memory always uses
  // the executing sessionId; rootSessionId only describes run lineage.
  const contexts = memoryContexts(ctx)
  return contexts.length ? { context: contexts[0], contexts } : { contexts, error: '长期记忆已对当前会话关闭。' }
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
      const ctx = rawCtx
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
      return { success: true, output: `✅ 已成功记录记忆 (ID: ${node.id}): ${content}`,
        metadata: { memoryMutation: { action: 'remember', id: node.id, summary: node.summary } } }
    },
  }

  const recallTool: Tool = {
    name: 'recall',
    displayName: '记忆检索',
    description: '分页检索当前记忆范围，返回真实 ID、范围和原文；独立副本分别列出。tags=[]可配合keyword字面搜索。依hasMore/nextOffset翻页；删除一批后从offset=0重查。会话记忆持久保存，不会在会话结束后自动消失。',
    parameters: {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' }, description: '用于检索的标签列表' },
        limit: { type: 'number', description: '本页返回条数，默认30，最多100。' }, ...memoryPageParameters },
      required: ['tags'],
    },
    async execute(args: unknown, rawCtx: AgentContext): Promise<ToolResult> {
      const ctx = rawCtx
      const resolved = resolveMemoryContext(ctx)
      if (!resolved.context) return disabledResult(resolved.error!)
      const { tags } = args as { tags: string[] }
      const page = memoryPageArgs(args as Parameters<typeof memoryPageArgs>[0], 30)
      const nodes = await manager.listNodesInContexts({ tags, summaryContains: page.keyword, orderBy: 'strength', limit: page.limit + 1, offset: page.offset }, resolved.contexts)
      return memoryPageResult(nodes, page, nodes.length ? '本页找到 {count} 条相关记忆:' : '本页没有匹配的记忆。')
    },
  }

  const listMemoriesTool: Tool = {
    name: 'list_memories',
    displayName: '列出近期记忆',
    description: '分页列出当前记忆范围内最近记录的节点，可按keyword字面搜索原文。依hasMore/nextOffset翻页；删除一批后从offset=0重查，避免漏掉移动到前页的副本。',
    parameters: { type: 'object', properties: { limit: { type: 'number', description: '返回数量限制，默认10' }, ...memoryPageParameters }, required: [] },
    async execute(args: unknown, rawCtx: AgentContext): Promise<ToolResult> {
      const ctx = rawCtx
      const resolved = resolveMemoryContext(ctx)
      if (!resolved.context) return disabledResult(resolved.error!)
      const page = memoryPageArgs(args as Parameters<typeof memoryPageArgs>[0], 10)
      const nodes = await manager.listNodesInContexts({ summaryContains: page.keyword, orderBy: 'timestamp', limit: page.limit + 1, offset: page.offset }, resolved.contexts)
      return memoryPageResult(nodes, page, nodes.length ? '本页最近的 {count} 条记忆:' : page.offset === 0 && !page.keyword ? '记忆体为空。' : '本页没有匹配的记忆。')
    },
  }

  const forgetTool: Tool = {
    name: 'forget',
    displayName: '删除记忆',
    description: '只删除当前授权记忆范围内指定 ID 的节点。用户要求按内容忘记时，先检索确认匹配副本并逐个使用真实 ID 删除，每批删除后从offset=0重查，直到无匹配；无须对已授权的同内容副本重复询问。只指定 ID 时不扩大删除范围。',
    parameters: { type: 'object', properties: { id: { type: 'string', description: '要删除的记忆节点 ID' } }, required: ['id'] },
    async execute(args: unknown, rawCtx: AgentContext): Promise<ToolResult> {
      const ctx = rawCtx
      const resolved = resolveMemoryContext(ctx)
      if (!resolved.context) return disabledResult(resolved.error!)
      const { id } = args as { id: string }
      const candidates = await Promise.all(resolved.contexts.map(async context => ({ context, node: await manager.getNode(id, context) })))
      const target = candidates.find(candidate => candidate.node !== null)
      if (!target?.node) return { success: false, output: `记忆 ${id} 不存在于当前记忆范围。`, error: 'MEMORY_NOT_FOUND' }
      await manager.deleteNode(id, target.context)
      return { success: true, output: `✅ 记忆 ${id} 已被删除。`,
        metadata: { memoryMutation: { action: 'forget', id, summary: target.node.summary } } }
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
      const ctx = rawCtx
      const resolved = resolveMemoryContext(ctx)
      if (!resolved.context) return disabledResult(resolved.error!)
      const { sourceId, targetId, type, description, strength = 0.5 } = args as any
      if (sourceId === targetId) return { success: false, output: '源节点和目标节点不能是同一个' }
      const matching = await Promise.all(resolved.contexts.map(async context => {
        const [source, target] = await Promise.all([manager.getNode(sourceId, context), manager.getNode(targetId, context)])
        return source && target ? context : undefined
      }))
      const targetContext = matching.find(context => context !== undefined)
      if (!targetContext) return { success: false, output: '建立关联失败：两个节点都必须属于当前记忆范围。', error: 'MEMORY_NOT_FOUND' }
      try {
        const edge = await manager.createEdge({ sourceNodeId: sourceId, targetNodeId: targetId, type: type as MemoryEdgeType, strength, description }, targetContext)
        return { success: true, output: `✅ 成功建立关联: [${sourceId}] -(${edge.type})-> [${targetId}]` }
      } catch (e: any) {
        return { success: false, output: `建立关联失败: ${e?.message ?? e}` }
      }
    },
  }

  return [rememberTool, recallTool, listMemoriesTool, forgetTool, linkMemoriesTool]
}

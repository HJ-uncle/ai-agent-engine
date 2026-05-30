import { SQLiteMemoryManager } from '../../storage/memory/memory-manager.js'
import { createLLMAdapterWithDbConfig, type LLMAdapter, type LLMAdapterOptions } from '../../core/llm-adapter/index.js'
import type { ExtractedMemory, LLMCredentials } from './types.js'
import type { Message } from '../../core/agent-context/index.js'

// ============================================================================
// Types & Constants
// ============================================================================
const VALID_TYPES = new Set(['fact', 'preference', 'decision', 'lesson', 'narrative', 'milestone'])

const EXTRACTION_SYSTEM_PROMPT = `你是一个记忆提取助手。从以下对话中提取有价值的记忆信息。

请以 JSON 数组格式输出，每个元素包含：
- type: 记忆类型（fact | preference | decision | lesson | narrative | milestone）
- content: 记忆内容（简洁、完整的陈述句）
- importance: 重要性 0-1（0.9+极重要，0.7+重要，0.5+一般，0.3+轻微）
- emotion: 情绪效价 -1~1（-1消极，0中性，1积极）
- tags: 标签数组（如 ["用户信息","技术栈","项目偏好"]）
- relatedTo: 指向本次提取中另一条记忆的 content 关键词（可选）

提取规则：
1. 事实类（fact）：明确的、可验证的信息
2. 偏好类（preference）：用户的喜好、倾向、习惯
3. 决策类（decision）：用户做出的选择或决定
4. 经验教训类（lesson）：从讨论中得出的经验或教训
5. 叙事类（narrative）：用户讲述的个人经历或故事
6. 里程碑类（milestone）：重要的进展或节点

注意：
- 只提取有价值的、非显而易见的记忆
- 偏好、决策、经验教训类比事实类更值得提取
- 避免提取临时性、一次性、无长期价值的内容
- 如果没有有价值的记忆可以提取，返回空数组 []`

const ROUTER_SYSTEM_PROMPT = `作为一个记忆检索路由，请根据用户的输入，决定需要从记忆体中检索什么。
规则：
1. 如果用户只是简单寒暄（如"你好","在吗"、"哈喽"）、或者当前的对话完全不需要参考历史，严格回复: NONE
2. 如果用户问关于自己的身份、过去交互等问题（如"你是谁"、"你认识我吗"），请输出通用检索词：用户 名字 叫什么 身份 职业 偏好 设定 经历。
3. 其他情况，提取1-3个核心名词作为关键词，空格分隔。
切记：只返回核心检索词或 NONE，绝不输出任何其他解释文本。

用户输入: "{query}"
输出:`

// ============================================================================
// Utilities
// ============================================================================
function formatMessages(messages: Array<{ role: string; content: string }>): string {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
    .join('\n\n')
}

function buildExtractionPrompt(historyText: string): string {
  return `${EXTRACTION_SYSTEM_PROMPT}\n\n--- 对话历史开始 ---\n${historyText}\n--- 对话历史结束 ---\n\n请提取记忆，以 JSON 数组格式输出：`
}

function parseMemories(raw: string): ExtractedMemory[] {
  let jsonStr = raw.trim()
  const fenced = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) {
    jsonStr = fenced[1].trim()
  }

  let data: unknown
  try {
    data = JSON.parse(jsonStr)
  } catch {
    return []
  }

  if (!Array.isArray(data)) return []

  return data.filter((item: any): item is ExtractedMemory => {
    if (!item || typeof item !== 'object') return false
    if (!VALID_TYPES.has(item.type)) return false
    if (typeof item.content !== 'string' || item.content.trim().length === 0) return false
    if (typeof item.importance !== 'number' || item.importance < 0 || item.importance > 1) return false
    if (typeof item.emotion !== 'number' || item.emotion < -1 || item.emotion > 1) return false
    if (!Array.isArray(item.tags) || !item.tags.every((t: unknown) => typeof t === 'string')) return false
    return true
  })
}

export { formatMessages, buildExtractionPrompt, parseMemories }

// ============================================================================
// Core Functions
// ============================================================================

/**
 * 提取对话历史中的记忆并存入数据库
 */
export async function extractAndStoreMemories(opts: {
  messages: Array<{ role: string; content: string }>
  sessionId: string
  tenantId: string
  llm: LLMCredentials
  minImportance?: number
}): Promise<{ extracted: number; stored: number; errors: string[] }> {
  const result = { extracted: 0, stored: 0, errors: [] as string[] }
  const minImp = opts.minImportance ?? 0.3

  try {
    const historyText = formatMessages(opts.messages)
    if (historyText.length < 50) return result

    const prompt = buildExtractionPrompt(historyText)

    let adapter: LLMAdapter
    try {
      adapter = await createLLMAdapterWithDbConfig({
        model: opts.llm.model,
        apiKey: opts.llm.apiKey,
        baseUrl: opts.llm.baseUrl,
        provider: opts.llm.provider,
      })
    } catch (err) {
      result.errors.push(`Failed to create LLM adapter: ${(err as Error)?.message}`)
      return result
    }

    const messages: Message[] = [
      { role: 'user', content: prompt, createdAt: Date.now() },
    ]

    let memories: ExtractedMemory[] = []
    try {
      const completeOpts: LLMAdapterOptions = {
        model: opts.llm.model || adapter.model,
        temperature: 0.1,
      }
      if (adapter.provider === 'deepseek') {
        completeOpts.responseFormat = 'json'
      }
      const response = await adapter.complete(messages, completeOpts)
      memories = parseMemories(response.content)
    } catch (err) {
      result.errors.push(`LLM extraction failed: ${(err as Error)?.message}`)
      return result
    }

    result.extracted = memories.length
    if (memories.length === 0) return result

    const filtered = memories.filter((m) => m.importance >= minImp)
    if (filtered.length === 0) return result

    const manager = new SQLiteMemoryManager()
    const ctx = { tenantId: opts.tenantId, sessionId: opts.sessionId }
    const nodeMap = new Map<string, string>()

    for (const memory of filtered) {
      try {
        let embedding: number[] | undefined
        if (adapter.embed) {
          try {
            const embeds = await adapter.embed(memory.content)
            if (embeds && embeds.length > 0) embedding = embeds[0]
          } catch (e) {
            console.warn(`[Memory] Failed to generate embedding for memory node: ${(e as Error).message}`)
          }
        }

        const node = await manager.createNode(
          {
            type: memory.type,
            summary: memory.content,
            importance: memory.importance,
            emotionalValence: memory.emotion,
            sourceSessionId: opts.sessionId,
            tags: memory.tags,
            embedding,
          },
          ctx,
        )

        const nodeId = node.id
        nodeMap.set(memory.content, nodeId)
        result.stored++
      } catch (err) {
        result.errors.push(`Failed to store "${memory.content.slice(0, 50)}": ${(err as Error)?.message}`)
      }
    }

    for (const memory of filtered) {
      if (!memory.relatedTo) continue
      const sourceId = nodeMap.get(memory.content)
      if (!sourceId) continue

      for (const [targetContent, targetId] of nodeMap.entries()) {
        if (targetContent === memory.content) continue
        if (
          targetContent.includes(memory.relatedTo) ||
          memory.relatedTo.includes(targetContent)
        ) {
          try {
            await manager.createEdge(
              {
                sourceNodeId: sourceId,
                targetNodeId: targetId,
                type: 'similar_to',
                strength: 0.7,
                description: `自动关联：${memory.content.slice(0, 30)} ↔ ${targetContent.slice(0, 30)}`,
              },
              ctx,
            )
          } catch {
            // 建边失败不影响整体
          }
          break
        }
      }
    }
  } catch (err) {
    result.errors.push(`Memory extraction pipeline error: ${(err as Error)?.message}`)
  }

  return result
}

/**
 * 核心检索路由：通过大模型分析用户输入，并构建三脑架构所需的查询上下文
 */
async function analyzeQueryIntent(query: string, adapter: LLMAdapter): Promise<string> {
  const prompt = ROUTER_SYSTEM_PROMPT.replace('{query}', query)
  try {
    const res = await adapter.complete(
      [{ role: 'user', content: prompt, createdAt: Date.now() }], 
      { model: adapter.model, temperature: 0.1, maxTokens: 100 }
    )
    return res.content.trim()
  } catch (err) {
    // 降级：如果大模型路由失败，直接将原查询作为关键词
    return query 
  }
}

/**
 * 组装记忆召回块，利用三脑架构（向量、关系、图）综合提取记忆节点
 */
export async function buildMemoryRecallBlock(
  tenantId: string,
  query?: string,
  llm?: LLMCredentials,
): Promise<string> {
  try {
    if (!query || !llm) return ''

    const manager = new SQLiteMemoryManager()
    let aiQuery = ''
    let adapter: LLMAdapter | null = null
    
    try {
      adapter = await createLLMAdapterWithDbConfig({
        model: llm.model,
        apiKey: llm.apiKey,
        baseUrl: llm.baseUrl,
        provider: llm.provider,
      })
      aiQuery = await analyzeQueryIntent(query, adapter)
    } catch (err) {
      aiQuery = query
    }

    if (aiQuery === 'NONE') {
      return '' // 简单寒暄，不需要记忆
    }

    // ==================================================
    // 三脑协同架构 (Three-Brain Architecture) 检索
    // ==================================================
    const nodeMap = new Map<string, any>()
    let anchorIds: string[] = []
    const ctx = { tenantId, sessionId: '' }

    // 1. 向量数据库 (海马体) - 语义直觉与模糊联想
    if (adapter?.embed && aiQuery) {
      try {
        const embeds = await adapter.embed(aiQuery)
        if (embeds && embeds.length > 0) {
          const similarNodes = await manager.recallSimilar(embeds[0], 10, ctx, 0.65)
          for (const n of similarNodes) {
            nodeMap.set(n.id, n)
            anchorIds.push(n.id)
          }
        }
      } catch (err) {
        // ignore vector failure, proceed to keyword fallback
      }
    }

    // 2. 关系型数据库 (皮层) - 兜底与字面量精确匹配
    if (anchorIds.length < 5 && aiQuery) {
      const kwNodes = await manager.listNodes(
        {
          keyword: aiQuery,
          orderBy: 'importance',
          orderDir: 'DESC',
          limit: 50, // 扩大匹配池，防高权噪音截断
        },
        ctx
      )
      for (const n of kwNodes) {
        if (!nodeMap.has(n.id)) {
          nodeMap.set(n.id, n)
          anchorIds.push(n.id)
        }
        if (anchorIds.length >= 15) break // 控制锚点规模
      }
    }
    
    // 3. 图数据库模拟 (联络图) - 深度关联与高阶认知
    if (anchorIds.length > 0) {
      try {
        const relatedNodes = await manager.getRelatedNodes(anchorIds, undefined, ctx)
        for (const n of relatedNodes) {
          if (!nodeMap.has(n.id)) {
            nodeMap.set(n.id, n)
          }
        }
      } catch (err) {
        // ignore graph traversal failure
      }
    }

    const contextualNodes = Array.from(nodeMap.values())
    if (contextualNodes.length === 0) return ''

    // 排序：先按重要性，再按强度
    contextualNodes.sort((a, b) => (b.importance - a.importance) || (b.strength - a.strength))

    const lines = contextualNodes.map((n) => {
      const typeLabel: Record<string, string> = {
        preference: '偏好',
        decision: '决定',
        fact: '事实',
        lesson: '教训',
        narrative: '经历',
        milestone: '里程碑',
      }
      const tagStr = n.tags && n.tags.length > 0 ? ` [${n.tags.join(', ')}]` : ''
      return `- [${typeLabel[n.type] || n.type}] ${n.summary}${tagStr}`
    })

    return `\n\n---\n# 长期记忆（Memory Graph）\n\n以下是从历史对话中自动提取的关于当前用户的已知信息，请在回答时参考：\n\n${lines.join('\n')}\n\n---`
  } catch {
    return ''
  }
}

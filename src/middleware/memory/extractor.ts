import { SQLiteMemoryManager } from '../../storage/memory/memory-manager.js'
import { createLLMAdapterWithDbConfig, type LLMAdapter, type LLMAdapterOptions } from '../../core/llm-adapter/index.js'
import type { ExtractedMemory, LLMCredentials } from './types.js'
import type { Message } from '../../core/agent-context/index.js'

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

function formatMessages(messages: Array<{ role: string; content: string }>): string {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
    .join('\n\n')
}

export { formatMessages }

function buildExtractionPrompt(historyText: string): string {
  return `${EXTRACTION_SYSTEM_PROMPT}\n\n--- 对话历史开始 ---\n${historyText}\n--- 对话历史结束 ---\n\n请提取记忆，以 JSON 数组格式输出：`
}

export { buildExtractionPrompt }

const VALID_TYPES = new Set(['fact', 'preference', 'decision', 'lesson', 'narrative', 'milestone'])

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

export { parseMemories }

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

export async function buildMemoryRecallBlock(
  tenantId: string,
  query?: string,
  llm?: LLMCredentials,
): Promise<string> {
  try {
    const manager = new SQLiteMemoryManager()
    let nodes: any[] = []

    if (query && llm) {
      try {
        const adapter = await createLLMAdapterWithDbConfig({
          model: llm.model,
          apiKey: llm.apiKey,
          baseUrl: llm.baseUrl,
          provider: llm.provider,
        })
        if (adapter.embed) {
          const embeds = await adapter.embed(query)
          if (embeds && embeds.length > 0) {
            const similarNodes = await manager.recallSimilar(embeds[0], 20, { tenantId, sessionId: '' })
            nodes = similarNodes
          }
        }
      } catch (err) {
        console.warn(`[Memory] Vector recall failed: ${(err as Error).message}, falling back to listNodes`)
      }
    }

    if (nodes.length === 0) {
      nodes = await manager.listNodes(
        {
          minImportance: 0.3,
          minStrength: 0.15,
          orderBy: 'importance',
          orderDir: 'DESC',
          limit: 30,
        },
        { tenantId, sessionId: '' },
      )
    }

    if (nodes.length === 0) return ''

    const lines = nodes.map((n) => {
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

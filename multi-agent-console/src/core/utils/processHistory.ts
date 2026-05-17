/**
 * processHistoryMessages
 *
 * 将后端 /conversation/history 返回的原始消息列表（role='user'|'assistant'|'tool'|'system'）
 * 解析成前端 Message[] 格式，合并 reasoningContent / toolCall / tool_role 为 thinkingSteps[]。
 *
 * 逻辑完全对齐 src/web/hooks/useChat.ts 的 fetchHistory 实现，
 * 供 Web 和 Mobile 共同复用。
 */
import type { Message, ThinkingStep, TokenUsage } from '@core/types'

function genId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

function accumulateUsage(
  acc: TokenUsage | null,
  u: TokenUsage | undefined | null,
): TokenUsage | null {
  if (!u) return acc
  if (!acc) return { ...u }
  return {
    promptTokens: (acc.promptTokens ?? 0) + (u.promptTokens ?? 0),
    completionTokens: (acc.completionTokens ?? 0) + (u.completionTokens ?? 0),
    totalTokens: (acc.totalTokens ?? 0) + (u.totalTokens ?? 0),
    systemPromptTokens: (acc.systemPromptTokens ?? 0) + (u.systemPromptTokens ?? 0),
    messagesTokens: (acc.messagesTokens ?? 0) + (u.messagesTokens ?? 0),
    skillTokens: (acc.skillTokens ?? 0) + (u.skillTokens ?? 0),
    systemToolsTokens: (acc.systemToolsTokens ?? 0) + (u.systemToolsTokens ?? 0),
    ragTokens: (acc.ragTokens ?? 0) + (u.ragTokens ?? 0),
    builtinToolsTokens: (acc.builtinToolsTokens ?? 0) + (u.builtinToolsTokens ?? 0),
    mcpToolsTokens: (acc.mcpToolsTokens ?? 0) + (u.mcpToolsTokens ?? 0),
    toolResultsTokens: (acc.toolResultsTokens ?? 0) + (u.toolResultsTokens ?? 0),
    userInputTokens: (acc.userInputTokens ?? 0) + (u.userInputTokens ?? 0),
    cacheHitTokens: (acc.cacheHitTokens ?? 0) + (u.cacheHitTokens ?? 0),
    cacheMissTokens: (acc.cacheMissTokens ?? 0) + (u.cacheMissTokens ?? 0),
    reasoningTokens: (acc.reasoningTokens ?? 0) + (u.reasoningTokens ?? 0),
  }
}

export function processHistoryMessages(list: any[], precomputedUsage?: TokenUsage): {
  messages: Message[]
  totalUsage: TokenUsage
} {
  const msgs: Message[] = []

  let currentThinkingSteps: ThinkingStep[] = []
  let currentRoundUsage: TokenUsage | null = null
  let currentConvId: string | null = null
  let currentConvLastTime = 0

  for (const m of list) {
    if (m.role === 'user') {
      msgs.push({
        id: m.id || `hist-u-${m.createdAt}-${genId()}`,
        role: 'user',
        content: m.content,
        status: 'done',
        createdAt: m.createdAt || Date.now(),
        backendMessageId: m.id,
        conversationId: m.conversationId ?? null,
      })
      // 重置轮次状态
      currentThinkingSteps = []
      currentRoundUsage = null
      currentConvId = null
      currentConvLastTime = 0
    } else if (m.role === 'assistant') {
      currentRoundUsage = accumulateUsage(currentRoundUsage, m.usage)
      if (m.conversationId) currentConvId = m.conversationId
      if (m.createdAt) currentConvLastTime = m.createdAt

      // DeepSeek R1 式 reasoningContent
      if (m.reasoningContent?.trim()) {
        currentThinkingSteps.push({ type: 'thinking', text: m.reasoningContent })
      }

      if (m.toolCall) {
        // 如果没有 reasoningContent，把 content 当作旧格式思考过程
        if (m.content?.trim() && !m.reasoningContent?.trim()) {
          currentThinkingSteps.push({ type: 'thinking', text: m.content })
        }
        currentThinkingSteps.push({
          type: 'tool_start',
          toolName: m.toolCall.name,
          toolArgs: m.toolCall.args,
          toolCallId: m.toolCallId,
        })
      } else {
        // 最终输出消息
        msgs.push({
          id: m.id || `hist-a-${m.createdAt}-${genId()}`,
          role: 'assistant',
          content: m.content,
          status: 'done',
          createdAt: m.createdAt || Date.now(),
          backendMessageId: m.id,
          conversationId: m.conversationId ?? null,
          usage: currentRoundUsage || m.usage || null,
          thinkingSteps: [...currentThinkingSteps],
          modelId: m.modelId || m.model,
        })
        currentThinkingSteps = []
        currentRoundUsage = null
      }
    } else if (m.role === 'tool') {
      const contentStr = String(m.content || '')
      const isError =
        contentStr.startsWith('Tool error:') ||
        contentStr.startsWith('Command timed out') ||
        contentStr.startsWith('Failed to execute command') ||
        (contentStr.includes('exited with code') && !contentStr.includes('exited with code 0'))

      const lastToolIdx = [...currentThinkingSteps]
        .reverse()
        .findIndex(
          (s) =>
            s.type === 'tool_start' &&
            s.success === undefined &&
            (m.toolCallId ? s.toolCallId === m.toolCallId : true),
        )

      if (lastToolIdx !== -1) {
        const idx = currentThinkingSteps.length - 1 - lastToolIdx
        currentThinkingSteps[idx] = {
          ...currentThinkingSteps[idx],
          success: !isError,
          outputPreview: contentStr.slice(0, 500),
        }
      } else {
        if (m.toolName === 'ask_user') {
          const askUserIdx = currentThinkingSteps.findIndex(
            (s) => s.type === 'tool_start' && s.toolName === 'ask_user' && s.success === undefined,
          )
          if (askUserIdx !== -1) {
            currentThinkingSteps[askUserIdx].success = true
            currentThinkingSteps[askUserIdx].outputPreview = contentStr.slice(0, 500)
          }
        } else {
          currentThinkingSteps.push({
            type: 'tool_end',
            toolCallId: m.toolCallId,
            success: !isError,
            outputPreview: contentStr.slice(0, 500),
          })
        }
      }
    } else if (m.role === 'system') {
      msgs.push({
        id: m.id || `hist-s-${m.createdAt}-${genId()}`,
        role: 'system',
        content: m.content,
        status: 'done',
        createdAt: m.createdAt || Date.now(),
        backendMessageId: m.id,
        usage: m.usage || null,
      })
    }
  }

  // 收尾：如果还有未归档的思考步骤（如 ask_user 等待中），补一个 assistant 占位
  if (currentThinkingSteps.length > 0) {
    msgs.push({
      id: `hist-a-${currentConvLastTime || Date.now()}-${genId()}`,
      role: 'assistant',
      content: '',
      status: 'done',
      createdAt: currentConvLastTime || Date.now(),
      thinkingSteps: currentThinkingSteps,
      usage: currentRoundUsage || null,
      conversationId: currentConvId ?? null,
      modelId: list.find(m => m.conversationId === currentConvId && m.modelId)?.modelId, // Try to find modelId in the same conversation
    })
  }

  // 汇总全部 usage
  const totalUsage: TokenUsage = precomputedUsage || {
    promptTokens: 0, completionTokens: 0, totalTokens: 0,
    systemPromptTokens: 0, messagesTokens: 0, skillTokens: 0,
    systemToolsTokens: 0, ragTokens: 0, builtinToolsTokens: 0,
    mcpToolsTokens: 0, toolResultsTokens: 0, userInputTokens: 0,
    cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0,
  }

  // 如果没有预计算用量，则从列表中累加（兼容旧逻辑，但长会话窗口裁剪后会不准）
  if (!precomputedUsage) {
    for (const m of list) {
      if (m.usage) {
        totalUsage.promptTokens! += m.usage.promptTokens || 0
        totalUsage.completionTokens! += m.usage.completionTokens || 0
        totalUsage.totalTokens += m.usage.totalTokens || 0
        totalUsage.systemPromptTokens! += m.usage.systemPromptTokens || 0
        totalUsage.messagesTokens! += m.usage.messagesTokens || 0
        totalUsage.skillTokens! += m.usage.skillTokens || 0
        totalUsage.systemToolsTokens! += m.usage.systemToolsTokens || 0
        totalUsage.ragTokens! += m.usage.ragTokens || 0
        totalUsage.builtinToolsTokens! += m.usage.builtinToolsTokens || 0
        totalUsage.mcpToolsTokens! += m.usage.mcpToolsTokens || 0
        totalUsage.toolResultsTokens! += m.usage.toolResultsTokens || 0
        totalUsage.userInputTokens! += m.usage.userInputTokens || 0
        totalUsage.cacheHitTokens! += m.usage.cacheHitTokens || 0
        totalUsage.cacheMissTokens! += m.usage.cacheMissTokens || 0
        totalUsage.reasoningTokens! += m.usage.reasoningTokens || 0
      }
    }
  }

  return { messages: msgs, totalUsage }
}

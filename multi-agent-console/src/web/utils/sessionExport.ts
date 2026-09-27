/**
 * 会话导出工具 —— 以会话为单位导出/复制完整对话（Markdown）
 *
 * 用途：分析 AI 输出问题。导出内容包含：
 *  - 每轮用户输入全文
 *  - AI 回复全文（含模型、耗时、token 用量）
 *  - 思考过程（thinking）与工具调用（tool_start/tool_end，含参数与输出预览）折叠块
 *
 * 数据获取：优先内存 messageMap（当前会话，含流式最新内容），
 * 否则从后端 getHistory 拉取并复用 processHistoryMessages 解析。
 */
import type { Message, Session, ThinkingStep } from '@core/types'
import { conversationApi } from '@core/api'
import { processHistoryMessages } from '@core/utils/processHistory'
import { useSessionStore } from '@core/store/session'

/** 获取会话完整消息：内存优先，未加载的会话从后端拉取 */
export async function getSessionMessages(sessionId: string): Promise<Message[]> {
  const cached = useSessionStore.getState().messageMap[sessionId]
  if (cached && cached.length > 0) return cached

  const { list, metadata } = await conversationApi.getHistory(sessionId)
  const { messages } = processHistoryMessages(list, metadata?.sessionUsage)
  return messages
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function textOf(content: string | any[] | null | undefined): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (p?.text ?? '')))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function stepDetail(s: ThinkingStep): string {
  switch (s.type) {
    case 'thinking':
      return s.text ?? ''
    case 'tool_start': {
      const args = s.toolArgs
      const argsStr =
        typeof args === 'string' ? args : args ? JSON.stringify(args, null, 2) : ''
      return [`🔧 **调用工具 \`${s.toolName ?? 'unknown'}\`**`, argsStr && '```json\n' + argsStr + '\n```']
        .filter(Boolean)
        .join('\n\n')
    }
    case 'tool_end': {
      const status = s.success === false ? '❌ 失败' : '✅ 完成'
      const preview = s.outputPreview ? '\n\n```\n' + s.outputPreview + '\n```' : ''
      return `🔧 **工具 \`${s.toolName ?? ''}\` ${status}**${preview}`
    }
    default:
      return ''
  }
}

/** 生成会话 Markdown 全文 */
export function buildSessionMarkdown(
  session: Session,
  messages: Message[],
  agentName?: string,
): string {
  const L: string[] = []
  L.push(`# ${session.title}`)
  L.push('')
  L.push(`> 会话 ID：\`${session.id}\`  `)
  if (agentName) L.push(`> Agent：${agentName}  `)
  L.push(`> 创建时间：${fmtTime(session.createdAt)}  `)
  L.push(`> 导出时间：${fmtTime(Date.now())}｜消息数：${messages.length}`)
  L.push('')
  L.push('---')
  L.push('')

  for (const m of messages) {
    const time = fmtTime(m.createdAt)

    if (m.role === 'user') {
      L.push(`## 🧑 用户 · ${time}`)
      L.push('')
      L.push(textOf(m.content) || '（空）')
      L.push('')
      continue
    }

    if (m.role === 'assistant') {
      const meta: string[] = [time]
      if (m.modelId) meta.push(`模型 ${m.modelId}`)
      if (m.durationMs) meta.push(`耗时 ${(m.durationMs / 1000).toFixed(1)}s`)
      if (m.status === 'error') meta.push('⚠️ 出错')
      L.push(`## 🤖 AI · ${meta.join(' · ')}`)
      L.push('')

      // 思考过程 / 工具调用（折叠）
      const steps = m.thinkingSteps ?? []
      if (steps.length > 0) {
        L.push('<details><summary>思考与工具调用（点击展开）</summary>')
        L.push('')
        for (const s of steps) {
          const detail = stepDetail(s)
          if (detail) {
            L.push(detail)
            L.push('')
          }
        }
        L.push('</details>')
        L.push('')
      }

      // 独立推理内容（部分模型返回）
      if (m.reasoningContent?.trim()) {
        L.push('<details><summary>推理内容（reasoning）</summary>')
        L.push('')
        L.push(m.reasoningContent)
        L.push('')
        L.push('</details>')
        L.push('')
      }

      L.push(textOf(m.content) || '（无文本输出）')
      L.push('')

      if (m.usage) {
        L.push(`> tokens：输入 ${m.usage.promptTokens ?? '-'}｜输出 ${m.usage.completionTokens ?? '-'}｜总计 ${m.usage.totalTokens ?? '-'}`)
        L.push('')
      }
      continue
    }

    // system
    L.push(`## ⚙️ ${m.role} · ${time}`)
    L.push('')
    L.push(textOf(m.content) || '（空）')
    L.push('')
  }

  L.push('---')
  L.push('')
  L.push('*由 Aether Engine 导出*')
  return L.join('\n')
}

/** 一轮对话：一条用户消息 + 其后直到下一条用户消息前的全部 AI 回复 */
export interface Round {
  /** 轮次序号（从 1 开始，按时间正序） */
  index: number
  userMessage: Message
  /** 该轮内的 AI 回复（可能多条：重新生成、多轮工具调用） */
  assistantMessages: Message[]
}

/** 把消息流按用户发言切分成轮次（过滤 system 消息） */
export function splitRounds(messages: Message[]): Round[] {
  const rounds: Round[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      rounds.push({ index: rounds.length + 1, userMessage: m, assistantMessages: [] })
    } else if (m.role === 'assistant' && rounds.length > 0) {
      rounds[rounds.length - 1].assistantMessages.push(m)
    }
  }
  return rounds
}

/** 触发浏览器下载文本文件 */
export function downloadText(filename: string, text: string, mime = 'text/markdown'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** 生成安全文件名 */
export function sessionFileName(session: Session): string {
  const safe = session.title.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 50) || session.id.slice(0, 8)
  const ts = new Date().toISOString().slice(0, 10)
  return `${safe}-${ts}.md`
}

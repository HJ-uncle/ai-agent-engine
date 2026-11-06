import type { ConversationDisplayOptions, ConversationDisplayTurn, Message } from '../../core/agent-context/types.js'

export class DisplayHistoryAnchorNotFoundError extends Error {
  constructor() { super('请求的对话已删除，请刷新会话导航') }
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192
export interface DisplayUserIdentity {
  id: string
  rootRunId?: string
  turnId?: string
  conversationId?: string
  hasDelivery: boolean
  followup?: { rootRunId: string; recipientInvocationRunId: string }
}

/** Keep only small presentation identities during JSONL's index pass, never the message body. */
export function displayUserIdentity(message: Pick<Message, 'id' | 'metadata'> & { conversationId?: unknown }): DisplayUserIdentity {
  if (!message.id) throw new Error('Display history user message has no identity')
  const metadata = record(message.metadata) ? message.metadata : {}, delivery = metadata.collaborationDelivery
  return { id: message.id, hasDelivery: delivery !== undefined,
    ...(identity(metadata.rootRunId) && (metadata.runId === undefined || metadata.runId === metadata.rootRunId)
      ? { rootRunId: metadata.rootRunId } : {}),
    ...(identity(metadata.turnId) ? { turnId: metadata.turnId } : {}),
    ...(identity(message.conversationId) ? { conversationId: message.conversationId } : {}),
    ...(record(delivery) && delivery.version === 1 && delivery.source === 'user-controller'
      && identity(delivery.messageId) && identity(delivery.rootRunId) && identity(delivery.recipientInvocationRunId)
      ? { followup: { rootRunId: delivery.rootRunId, recipientInvocationRunId: delivery.recipientInvocationRunId } } : {}) }
}

/** Presentation only: metadata never grants execution authority. Unmatched or ambiguous users remain visible turns. */
export function displayUserTurnIds(users: readonly DisplayUserIdentity[], groupRootFollowups = false): Map<string, string> {
  if (new Set(users.map(user => user.id)).size !== users.length) throw new Error('Display history contains duplicate user message identities')
  const groups = new Map(users.map(user => [user.id, user.id]))
  if (!groupRootFollowups) return groups
  const key = (user: DisplayUserIdentity) => JSON.stringify([user.rootRunId, user.turnId])
  const anchors = new Map<string, { id: string; index: number } | null>()
  users.forEach((user, index) => {
    if (user.hasDelivery || !user.rootRunId || !user.turnId || user.conversationId !== user.turnId) return
    const binding = key(user)
    anchors.set(binding, anchors.has(binding) ? null : { id: user.id, index })
  })
  let currentAnchor: { id: string; index: number } | undefined
  users.forEach((user, index) => {
    const anchor = anchors.get(key(user))
    if (user.followup && user.followup.rootRunId === user.rootRunId && user.turnId && user.conversationId === user.turnId
      && anchor && anchor === currentAnchor && anchor.index < index) {
      groups.set(user.id, anchor.id)
      return
    }
    // Every independent user starts a new physical segment. Never jump backwards across that boundary.
    currentAnchor = !user.hasDelivery && anchor?.id === user.id ? anchor : undefined
  })
  return groups
}

export function selectDisplayTurnIds(ids: string[], options: ConversationDisplayOptions = {}): string[] {
  const limit = options.limit ?? 2
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('Display history limit must be an integer between 1 and 10')
  if (new Set(ids).size !== ids.length) throw new Error('Display history contains duplicate user message identities')
  if (options.anchorMessageId !== undefined) {
    const start = ids.indexOf(options.anchorMessageId)
    if (start < 0) throw new DisplayHistoryAnchorNotFoundError()
    return ids.slice(start, start + limit)
  }
  return ids.slice(-limit)
}

export function displayTurn(message: Message): ConversationDisplayTurn {
  if (!message.id) throw new Error('Display history user message has no identity')
  // Attachment/provider bodies can be megabytes; navigation only needs bounded display text.
  let content: unknown = message.content
  if (typeof content === 'string' && /^\s*\[\s*\{/.test(content)) {
    if (content.length <= 64 * 1024) {
      try { const parsed: unknown = JSON.parse(content); if (Array.isArray(parsed)) content = parsed } catch { /* Keep ordinary user text. */ }
    } else if (/"type"\s*:\s*"(?:text|input_text|image_url|image|input_image)"/.test(content.slice(0, 2048))) {
      // Old stringified image messages can contain multi-megabyte base64 strings.
      content = []
    }
  }
  const text = typeof content === 'string' ? content.slice(0, 1024) : Array.isArray(content) ? content
    .filter((part: unknown): part is { text: string } => Boolean(part && typeof part === 'object' && 'type' in part
      && (part.type === 'text' || part.type === 'input_text') && 'text' in part && typeof part.text === 'string'))
    .slice(0, 4).map(part => part.text.slice(0, 256)).join(' ') : ''
  const preview = text.replace(/data:[^\s]*;base64,[^\s]*/g, '[附件]').replace(/\s+/g, ' ').trim().slice(0, 160) || '附件消息'
  const conversationId = (message as Message & { conversationId?: string }).conversationId
  return { userMessageId: message.id, preview,
    ...(conversationId ? { conversationId } : {}),
    ...(typeof message.createdAt === 'number' && Number.isFinite(message.createdAt) ? { createdAt: message.createdAt } : {}) }
}

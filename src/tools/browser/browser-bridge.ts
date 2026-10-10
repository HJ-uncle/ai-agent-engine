import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { AgentContext, ToolResult } from '../../core/agent-context/index.js'

export const BROWSER_ACTIONS = [
  'open', 'tabs', 'snapshot', 'screenshot', 'click', 'fill', 'scroll', 'press_key', 'wait',
  'console', 'network', 'network_detail', 'navigate', 'viewport', 'close',
] as const
export type BrowserAction = typeof BROWSER_ACTIONS[number]

export interface BrowserCommand {
  requestId: string
  sessionId: string
  action: BrowserAction
  args: Record<string, unknown>
  expiresAt: number
}
export interface BrowserClientIdentity { tenantId: string; userId?: string }
interface Pending {
  command: BrowserCommand
  delivered: boolean
  watched?: () => void
  settle(result: ToolResult): void
}
interface Client {
  id: string
  token: string
  identity: BrowserClientIdentity
  sessionId: string
  expiresAt: number
  pending: Map<string, Pending>
  wake?: () => void
}

export class BrowserBridgeError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message) }
}

const unavailable = (): ToolResult => ({
  success: false,
  output: '当前会话没有连接 Aether 内置浏览器。请在 Aether 打开浏览器并在“设置 → 浏览器”启用 AI 操作，然后重试。远端引擎也需要 Aether 客户端保持在线。',
  metadata: { code: 'BROWSER_CLIENT_UNAVAILABLE', operationPerformed: false },
})
const scopeKey = (tenantId: string, sessionId: string) => JSON.stringify([tenantId, sessionId])

/** Commands never contain a caller-controlled owner; subagents inherit their root chat's browser. */
export class BrowserBridge {
  private clients = new Map<string, Client>()
  private scopes = new Map<string, string>()
  readonly pollTimeoutMs: number
  readonly leaseMs: number
  readonly commandTimeoutMs: number
  private readonly expiryTimer: ReturnType<typeof setInterval>

  constructor(options: { pollTimeoutMs?: number; leaseMs?: number; commandTimeoutMs?: number } = {}) {
    this.pollTimeoutMs = options.pollTimeoutMs ?? 20_000
    this.leaseMs = options.leaseMs ?? 65_000
    this.commandTimeoutMs = options.commandTimeoutMs ?? 60_000
    this.expiryTimer = setInterval(() => this.prune(), Math.min(this.leaseMs, 30_000))
    this.expiryTimer.unref()
  }

  private remove(client: Client, reason: string): void {
    this.clients.delete(client.id)
    this.scopes.delete(scopeKey(client.identity.tenantId, client.sessionId))
    for (const pending of [...client.pending.values()]) pending.settle({
      success: false, output: reason, metadata: { code: 'BROWSER_CLIENT_DISCONNECTED', operationPerformed: pending.delivered ? 'unknown' : false },
    })
    client.wake?.()
  }

  private prune(): void {
    for (const client of this.clients.values()) {
      if (client.expiresAt <= Date.now()) this.remove(client, '浏览器客户端已断开，操作未完成。请连接后重新读取页面状态。')
    }
  }

  private authorize(identity: BrowserClientIdentity, id: string, token: string): Client {
    this.prune()
    const client = this.clients.get(id)
    const expected = Buffer.from(client?.token ?? '')
    const supplied = Buffer.from(token)
    if (!client || client.identity.tenantId !== identity.tenantId || client.identity.userId !== identity.userId ||
      expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new BrowserBridgeError(404, 'Browser client not found or not owned by this connection')
    }
    client.expiresAt = Date.now() + this.leaseMs
    return client
  }

  register(identity: BrowserClientIdentity, sessionId: string, resume?: { clientId: string; clientToken: string }) {
    this.prune()
    if (resume) {
      const client = this.authorize(identity, resume.clientId, resume.clientToken)
      if (client.sessionId !== sessionId) throw new BrowserBridgeError(409, 'Browser client session cannot change')
      return this.registration(client)
    }
    if (this.scopes.has(scopeKey(identity.tenantId, sessionId))) {
      throw new BrowserBridgeError(409, 'This session already has an active browser client')
    }
    const client: Client = {
      id: randomUUID(), token: randomBytes(32).toString('base64url'), identity: { ...identity }, sessionId,
      expiresAt: Date.now() + this.leaseMs, pending: new Map(),
    }
    this.clients.set(client.id, client)
    this.scopes.set(scopeKey(identity.tenantId, sessionId), client.id)
    return this.registration(client)
  }

  private registration(client: Client) {
    return { clientId: client.id, clientToken: client.token, sessionId: client.sessionId, pollTimeoutMs: this.pollTimeoutMs, leaseMs: this.leaseMs, capabilities: { requestWatch: true } }
  }

  unregister(identity: BrowserClientIdentity, id: string, token: string): void {
    this.remove(this.authorize(identity, id, token), '浏览器连接已关闭，操作未完成。')
  }

  async poll(identity: BrowserClientIdentity, id: string, token: string, signal?: AbortSignal): Promise<BrowserCommand[]> {
    const client = this.authorize(identity, id, token)
    if (client.wake) throw new BrowserBridgeError(409, 'Only one browser command poll may be active')
    const take = () => {
      const pending = [...client.pending.values()].find(item => !item.delivered)
      if (!pending) return []
      pending.delivered = true
      return [pending.command]
    }
    if (signal?.aborted) return []
    const queued = take()
    if (queued.length) return queued
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout>
      const wake = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', wake)
        client.wake = undefined
        resolve(signal?.aborted || !this.clients.has(id) ? [] : take())
      }
      timer = setTimeout(wake, this.pollTimeoutMs)
      client.wake = wake
      signal?.addEventListener('abort', wake, { once: true })
    })
  }

  /** Independent from the command consumer, which can be blocked waiting for page visibility. */
  async watchRequest(identity: BrowserClientIdentity, id: string, token: string, requestId: string,
    wait = true, signal?: AbortSignal): Promise<{ active: boolean }> {
    const client = this.authorize(identity, id, token)
    const pending = client.pending.get(requestId)
    const state = () => ({ active: !!pending?.delivered && this.clients.get(id) === client && client.pending.get(requestId) === pending })
    if (!pending?.delivered || !wait || signal?.aborted) return state()
    if (pending.watched) throw new BrowserBridgeError(409, 'Only one browser request watch may be active')
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout>
      const wake = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', wake)
        if (pending.watched === wake) pending.watched = undefined
        resolve(state())
      }
      timer = setTimeout(wake, Math.min(20_000, this.pollTimeoutMs))
      pending.watched = wake
      signal?.addEventListener('abort', wake, { once: true })
      if (signal?.aborted) wake()
    })
  }

  result(identity: BrowserClientIdentity, id: string, token: string, requestId: string, result: ToolResult): boolean {
    const client = this.authorize(identity, id, token)
    const pending = client.pending.get(requestId)
    if (!pending || !pending.delivered) return false
    pending.settle(result)
    return true
  }

  async execute(action: BrowserAction, args: Record<string, unknown>, ctx: Pick<AgentContext, 'tenantId' | 'sessionId' | 'rootSessionId' | 'signal'>): Promise<ToolResult> {
    this.prune()
    if (ctx.signal?.aborted) return { success: false, status: 'cancelled', output: '浏览器操作已取消。', metadata: { code: 'BROWSER_COMMAND_CANCELLED', operationPerformed: false } }
    if (!BROWSER_ACTIONS.includes(action)) return { success: false, output: '未知浏览器操作，未发送到客户端。', metadata: { code: 'BROWSER_UNKNOWN_ACTION', operationPerformed: false } }
    const sessionId = ctx.rootSessionId ?? ctx.sessionId
    const id = this.scopes.get(scopeKey(ctx.tenantId, sessionId))
    const client = id ? this.clients.get(id) : undefined
    if (!client) return unavailable()
    // Bounds memory use when independent agents outpace a disconnected/slow client.
    if (client.pending.size >= 32) return { success: false, output: '浏览器操作队列已满，请等待已有操作结束。', metadata: { code: 'BROWSER_QUEUE_FULL', operationPerformed: false } }
    const requestId = randomUUID()
    const command: BrowserCommand = { requestId, sessionId, action, args, expiresAt: Date.now() + this.commandTimeoutMs }
    return new Promise(resolve => {
      const settle = (result: ToolResult) => {
        const pending = client.pending.get(requestId)
        if (!pending || !client.pending.delete(requestId)) return
        clearTimeout(timer)
        ctx.signal?.removeEventListener('abort', cancel)
        pending.watched?.()
        resolve(result)
      }
      // A command handed to the client may have taken effect before its reply
      // was lost. Only a command still in this broker's queue is known not to run.
      const performed = (): false | 'unknown' => client.pending.get(requestId)?.delivered ? 'unknown' : false
      const cancel = () => settle({ success: false, status: 'cancelled', output: '浏览器操作已取消；如已发送到页面，请重新读取页面状态。',
        metadata: { code: 'BROWSER_COMMAND_CANCELLED', operationPerformed: performed() } })
      const timer = setTimeout(() => settle({ success: false, output: '等待浏览器结果超时。请重新读取页面，不要盲目重复提交。',
        metadata: { code: 'BROWSER_COMMAND_TIMEOUT', operationPerformed: performed() } }), this.commandTimeoutMs)
      client.pending.set(requestId, { command, delivered: false, settle })
      ctx.signal?.addEventListener('abort', cancel, { once: true })
      client.wake?.()
    })
  }

  dispose(): void {
    clearInterval(this.expiryTimer)
    for (const client of [...this.clients.values()]) this.remove(client, '引擎已关闭浏览器连接。')
  }
}

export const browserBridge = new BrowserBridge()

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { ToolResult } from '../../core/agent-context/index.js'
import { browserExecutionIdentity, browserExecutionsMatch, type BrowserExecutionContext, type BrowserExecutionIdentity } from '../../core/browser-execution.js'
import { scheduleDeadline } from '../../core/utils/deadline.js'
import { snapshotBrowserAuthority, type BrowserHostAuthority } from '../../core/browser-authority.js'
import { NativeHostDemandBroker, BrowserHostDemandError, type NativeHostDemandOptions } from './native-host-demand.js'

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
  /** Present only for negotiated v2 clients, and never copied from action args. */
  execution?: Readonly<BrowserExecutionIdentity>
  /** null means no engine-imposed command deadline; cancellation and disconnect still settle it. */
  expiresAt: number | null
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
  protocolVersion: 1 | 2
  expiresAt: number
  pending: Map<string, Pending>
  wake?: () => void
  owned?: { authority: BrowserHostAuthority; execution: Readonly<BrowserExecutionIdentity>; hostId: string }
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
const hostFailureMessages: Readonly<Record<string, string>> = {
  BROWSER_HOST_UNAVAILABLE: '当前任务没有匹配的 Aether 浏览器宿主。请确认内置浏览器已启用 AI 操作且客户端在线。',
  BROWSER_HOST_CLOSED: '浏览器宿主已关闭，本次操作尚未发送到页面。',
  BROWSER_HOST_DISCONNECTED: '浏览器宿主连接已中断，本次操作尚未发送到页面。',
  BROWSER_HOST_DEMAND_TIMEOUT: '等待浏览器首次连接超时，本次操作尚未发送到页面。',
  BROWSER_HOST_DEMAND_CAPACITY: '等待首次连接的浏览器任务已满，请等待已有连接结束。',
  BROWSER_HOST_SLOT_CAPACITY: '正在使用浏览器的任务已满，请等待已有任务结束。',
  BROWSER_HOST_WAITER_CAPACITY: '当前任务等待浏览器连接的操作过多，请等待已有操作结束。',
  BROWSER_HOST_WINDOW_CLOSED: '浏览器所在窗口已关闭，本次操作尚未发送到页面。',
  BROWSER_HOST_AI_DISABLED: '内置浏览器的 AI 操作已关闭，本次操作尚未发送到页面。',
  BROWSER_HOST_CONNECTION_FAILED: '浏览器首次连接失败，本次操作尚未发送到页面。',
  BROWSER_HOST_CLIENT_REGISTRATION_FAILED: '无法为当前任务建立浏览器连接，本次操作尚未发送到页面。',
  BROWSER_COMMAND_CANCELLED: '浏览器连接等待已取消，本次操作尚未发送到页面。',
}

/** Commands never contain a caller-controlled owner; subagents inherit their root chat's browser. */
export class BrowserBridge {
  private clients = new Map<string, Client>()
  private scopes = new Map<string, string>()
  readonly pollTimeoutMs: number
  readonly leaseMs: number
  readonly commandTimeoutMs: number | undefined
  private readonly expiryTimer: ReturnType<typeof setInterval>
  readonly hostDemands: NativeHostDemandBroker<{ clientId: string; clientToken: string; sessionId: string; protocolVersion: 1 | 2 }>

  constructor(options: { pollTimeoutMs?: number; leaseMs?: number; commandTimeoutMs?: number;
    hostDemand?: Omit<NativeHostDemandOptions<{ clientId: string; clientToken: string; sessionId: string; protocolVersion: 1 | 2 }>, 'register' | 'release'> } = {}) {
    this.pollTimeoutMs = options.pollTimeoutMs ?? 20_000
    this.leaseMs = options.leaseMs ?? 65_000
    // Browser operations can legitimately wait on a page or user-visible
    // navigation for longer than a fixed watchdog.  Keep an explicit positive
    // timeout available for deployments that want one; omitted/zero is until
    // completion, cancellation, or client disconnect.
    this.commandTimeoutMs = Number.isFinite(options.commandTimeoutMs) && options.commandTimeoutMs! > 0 ? options.commandTimeoutMs : undefined
    this.expiryTimer = setInterval(() => this.prune(), Math.min(this.leaseMs, 30_000))
    this.expiryTimer.unref()
    this.hostDemands = new NativeHostDemandBroker({ ...options.hostDemand,
      register: (authority, execution, hostId) => this.registerOwned(authority, execution, hostId),
      release: registration => { const client = this.clients.get(registration.clientId); if (client) this.remove(client, '所属浏览器 root run 或宿主已结束。') } })
  }

  private remove(client: Client, reason: string): void {
    this.clients.delete(client.id)
    if (!client.owned) this.scopes.delete(scopeKey(client.identity.tenantId, client.sessionId))
    this.hostDemands.forgetClient(client.id)
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

  register(identity: BrowserClientIdentity, sessionId: string, resume?: { clientId: string; clientToken: string }, protocolVersion: 1 | 2 = 1) {
    this.prune()
    if (protocolVersion !== 1 && protocolVersion !== 2) throw new BrowserBridgeError(400, 'Unsupported browser client protocol')
    if (resume) {
      const client = this.authorize(identity, resume.clientId, resume.clientToken)
      if (client.sessionId !== sessionId) throw new BrowserBridgeError(409, 'Browser client session cannot change')
      if (client.protocolVersion !== protocolVersion) throw new BrowserBridgeError(409, 'Browser client protocol cannot change during renewal')
      return this.registration(client)
    }
    if (this.scopes.has(scopeKey(identity.tenantId, sessionId))) {
      throw new BrowserBridgeError(409, 'This session already has an active browser client')
    }
    const client: Client = {
      id: randomUUID(), token: randomBytes(32).toString('base64url'), identity: { ...identity }, sessionId, protocolVersion,
      expiresAt: Date.now() + this.leaseMs, pending: new Map(),
    }
    this.clients.set(client.id, client)
    this.scopes.set(scopeKey(identity.tenantId, sessionId), client.id)
    return this.registration(client)
  }

  private registration(client: Client) {
    return { clientId: client.id, clientToken: client.token, sessionId: client.sessionId, protocolVersion: client.protocolVersion,
      pollTimeoutMs: this.pollTimeoutMs, leaseMs: this.leaseMs,
      capabilities: { requestWatch: true, ...(client.protocolVersion === 2 ? { executionIdentity: 1, resultMetadata: 1 } : {}) } }
  }

  private registerOwned(authority: BrowserHostAuthority, execution: Readonly<BrowserExecutionIdentity>, hostId: string) {
    const client: Client = { id: randomUUID(), token: randomBytes(32).toString('base64url'),
      identity: { tenantId: authority.tenantId, ...(authority.kind === 'account' ? { userId: authority.userId } : {}) },
      sessionId: execution.rootSessionId, protocolVersion: 2, expiresAt: Date.now() + this.leaseMs, pending: new Map(),
      owned: { authority, execution, hostId } }
    this.clients.set(client.id, client)
    return this.registration(client)
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
    wait = true, signal?: AbortSignal, execution?: BrowserExecutionIdentity): Promise<{ active: boolean; execution?: Readonly<BrowserExecutionIdentity> }> {
    const client = this.authorize(identity, id, token)
    const pending = client.pending.get(requestId)
    const matches = () => client.protocolVersion === 1 || !!pending?.command.execution && browserExecutionsMatch(execution, pending.command.execution)
    const state = () => {
      const active = !!pending?.delivered && matches() && this.clients.get(id) === client && client.pending.get(requestId) === pending
      return { active, ...(active && pending?.command.execution ? { execution: pending.command.execution } : {}) }
    }
    if (!matches()) return { active: false }
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

  result(identity: BrowserClientIdentity, id: string, token: string, requestId: string, result: ToolResult, execution?: BrowserExecutionIdentity): boolean {
    const client = this.authorize(identity, id, token)
    const pending = client.pending.get(requestId)
    if (!pending || !pending.delivered) return false
    if (client.protocolVersion === 2 && (!pending.command.execution || !browserExecutionsMatch(execution, pending.command.execution))) return false
    pending.settle(result)
    return true
  }

  async execute(action: BrowserAction, args: Record<string, unknown>, context: BrowserExecutionContext): Promise<ToolResult> {
    const ctx: BrowserExecutionContext = Object.freeze({ tenantId: context.tenantId, sessionId: context.sessionId,
      rootSessionId: context.rootSessionId, rootRunId: context.rootRunId, runId: context.runId, signal: context.signal,
      browserAuthority: snapshotBrowserAuthority(context.browserAuthority),
      browserPrincipal: context.browserPrincipal && Object.freeze({ ...context.browserPrincipal }) })
    this.prune()
    if (ctx.signal?.aborted) return { success: false, status: 'cancelled', output: '浏览器操作已取消。', metadata: { code: 'BROWSER_COMMAND_CANCELLED', operationPerformed: false } }
    if (!BROWSER_ACTIONS.includes(action)) return { success: false, output: '未知浏览器操作，未发送到客户端。', metadata: { code: 'BROWSER_UNKNOWN_ACTION', operationPerformed: false } }
    const sessionId = ctx.rootSessionId ?? ctx.sessionId
    const id = this.scopes.get(scopeKey(ctx.tenantId, sessionId))
    let client = id ? this.clients.get(id) : undefined
    const execution = browserExecutionIdentity(ctx)
    const authority = snapshotBrowserAuthority(ctx.browserAuthority)
    const principal = ctx.browserPrincipal && Object.freeze({ ...ctx.browserPrincipal })
    const signal = ctx.signal
    // Owned slot resolution snapshots current admission before waiting; direct v1/v2 registrations remain compatible.
    if (authority && execution && principal && authority.tenantId === ctx.tenantId &&
      (authority.kind === 'account' ? principal.method !== 'none' && principal.userId === authority.userId : principal.method === 'none' && principal.userId === undefined)) {
      try {
        const registration = await this.hostDemands.acquire(authority, execution, signal)
        client = this.clients.get(registration.clientId)
      } catch (cause) {
        if (client && cause instanceof BrowserHostDemandError && cause.code === 'BROWSER_HOST_UNAVAILABLE') {
          // Only no-host compatibility can use an existing direct client; capacity/cancellation must not bypass the host barrier.
        } else if (cause instanceof BrowserHostDemandError) return { success: false, status: cause.code === 'BROWSER_COMMAND_CANCELLED' ? 'cancelled' : 'failed',
          output: hostFailureMessages[cause.code] ?? '浏览器首次连接未完成，本次操作尚未发送到页面。', metadata: { code: cause.code, operationPerformed: false } }
        else throw cause
      }
    }
    if (signal?.aborted) return { success: false, status: 'cancelled', output: '浏览器操作已取消。', metadata: { code: 'BROWSER_COMMAND_CANCELLED', operationPerformed: false } }
    if (!client || this.clients.get(client.id) !== client) return unavailable()
    if (client.protocolVersion === 2) {
      if (!execution) return { success: false, output: '当前浏览器请求缺少真实执行身份，尚未发送页面操作。请升级配套引擎并从正常任务入口运行。',
        metadata: { code: 'BROWSER_EXECUTION_IDENTITY_UNAVAILABLE', operationPerformed: false } }
      if (!principal || principal.tenantId !== ctx.tenantId || principal.userId !== client.identity.userId) {
        return { success: false, output: '浏览器客户端与当前任务的认证账户不一致，尚未发送页面操作。',
          metadata: { code: 'BROWSER_EXECUTION_PRINCIPAL_MISMATCH', operationPerformed: false } }
      }
    }
    // Bounds memory use when independent agents outpace a disconnected/slow client.
    if (client.pending.size >= 32) return { success: false, output: '浏览器操作队列已满，请等待已有操作结束。', metadata: { code: 'BROWSER_QUEUE_FULL', operationPerformed: false } }
    const requestId = randomUUID()
    const command: BrowserCommand = { requestId, sessionId, action, args, ...(client.protocolVersion === 2 ? { execution } : {}),
      expiresAt: this.commandTimeoutMs === undefined ? null : Date.now() + this.commandTimeoutMs }
    return new Promise(resolve => {
      let cancelTimer: (() => void) | undefined
      const settle = (result: ToolResult) => {
        const pending = client.pending.get(requestId)
        if (!pending || !client.pending.delete(requestId)) return
        cancelTimer?.()
        ctx.signal?.removeEventListener('abort', cancel)
        pending.watched?.()
        resolve(result)
      }
      // A command handed to the client may have taken effect before its reply
      // was lost. Only a command still in this broker's queue is known not to run.
      const performed = (): false | 'unknown' => client.pending.get(requestId)?.delivered ? 'unknown' : false
      const cancel = () => settle({ success: false, status: 'cancelled', output: '浏览器操作已取消；如已发送到页面，请重新读取页面状态。',
        metadata: { code: 'BROWSER_COMMAND_CANCELLED', operationPerformed: performed() } })
      if (this.commandTimeoutMs !== undefined) cancelTimer = scheduleDeadline(() => settle({ success: false, output: '等待浏览器结果超时。请重新读取页面，不要盲目重复提交。',
        metadata: { code: 'BROWSER_COMMAND_TIMEOUT', operationPerformed: performed() } }), this.commandTimeoutMs)
      client.pending.set(requestId, { command, delivered: false, settle })
      ctx.signal?.addEventListener('abort', cancel, { once: true })
      client.wake?.()
    })
  }

  dispose(): void {
    this.hostDemands.dispose()
    clearInterval(this.expiryTimer)
    for (const client of [...this.clients.values()]) this.remove(client, '引擎已关闭浏览器连接。')
  }
}

export const browserBridge = new BrowserBridge()

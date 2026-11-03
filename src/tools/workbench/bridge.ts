import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { browserExecutionIdentity, browserExecutionsMatch, type BrowserExecutionIdentity } from '../../core/browser-execution.js'

export const WORKBENCH_ACTIONS = ['workspace.context', 'artifact.open', 'terminal.read'] as const
export type WorkbenchAction = typeof WORKBENCH_ACTIONS[number]
export interface WorkbenchIdentity { tenantId: string; userId?: string }
export interface WorkbenchCommand {
  requestId: string
  sessionId: string
  execution: Readonly<BrowserExecutionIdentity>
  action: WorkbenchAction
  args: Record<string, unknown>
  expiresAt: number
}
interface Pending { command: WorkbenchCommand; delivered: boolean; settle(result: ToolResult): void }
interface Client {
  id: string; token: string; identity: WorkbenchIdentity; sessionId: string
  actions: WorkbenchAction[]; expiresAt: number; pending: Map<string, Pending>; wake?: () => void
}
export class WorkbenchBridgeError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message) }
}
const key = (identity: WorkbenchIdentity, sessionId: string) => JSON.stringify([identity.tenantId, identity.userId, sessionId])
const failure = (code: string, output: string, operationPerformed: boolean | 'unknown' = false): ToolResult =>
  ({ success: false, output, metadata: { code, operationPerformed } })

/** The model can request a UI action; only a live, same-session client receipt proves execution. */
export class WorkbenchBridge {
  private clients = new Map<string, Client>()
  private scopes = new Map<string, string>()
  private timer: ReturnType<typeof setInterval>
  constructor(readonly options = { leaseMs: 35_000, pollMs: 10_000, commandMs: 20_000 }) {
    this.timer = setInterval(() => this.prune(), Math.min(options.leaseMs, 10_000))
    this.timer.unref()
  }
  private remove(client: Client): void {
    this.clients.delete(client.id)
    this.scopes.delete(key(client.identity, client.sessionId))
    for (const pending of [...client.pending.values()]) pending.settle(failure('WORKBENCH_DISCONNECTED', '客户端已断开或切换会话。请恢复所属会话后重新读取工作台状态。', pending.delivered ? 'unknown' : false))
    client.wake?.()
  }
  private prune(): void { for (const client of this.clients.values()) if (client.expiresAt <= Date.now()) this.remove(client) }
  private authorize(identity: WorkbenchIdentity, id: string, token: string): Client {
    this.prune()
    const client = this.clients.get(id)
    const actual = Buffer.from(token), expected = Buffer.from(client?.token ?? '')
    if (!client || client.identity.tenantId !== identity.tenantId || client.identity.userId !== identity.userId ||
      actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new WorkbenchBridgeError(404, '工作台连接不存在或不属于当前身份。')
    client.expiresAt = Date.now() + this.options.leaseMs
    return client
  }
  register(identity: WorkbenchIdentity, sessionId: string, actions: WorkbenchAction[]) {
    this.prune()
    if (this.scopes.has(key(identity, sessionId))) throw new WorkbenchBridgeError(409, '当前会话已有工作台连接。')
    const client: Client = { id: randomUUID(), token: randomBytes(32).toString('base64url'), identity: { ...identity }, sessionId,
      actions: [...new Set(actions)], expiresAt: Date.now() + this.options.leaseMs, pending: new Map() }
    this.clients.set(client.id, client); this.scopes.set(key(identity, sessionId), client.id)
    return { clientId: client.id, clientToken: client.token, sessionId, protocolVersion: 1, leaseMs: this.options.leaseMs }
  }
  unregister(identity: WorkbenchIdentity, id: string, token: string): void { this.remove(this.authorize(identity, id, token)) }
  status(ctx: Pick<AgentContext, 'tenantId' | 'sessionId' | 'rootSessionId' | 'browserPrincipal'>) {
    this.prune()
    const identity = { tenantId: ctx.tenantId ?? 'default', userId: ctx.browserPrincipal?.userId }
    const client = this.clients.get(this.scopes.get(key(identity, ctx.rootSessionId ?? ctx.sessionId)) ?? '')
    return { connected: Boolean(client), actions: client?.actions ?? [] }
  }
  async poll(identity: WorkbenchIdentity, id: string, token: string): Promise<WorkbenchCommand[]> {
    const client = this.authorize(identity, id, token)
    if (client.wake) throw new WorkbenchBridgeError(409, '工作台只允许一个命令读取请求。')
    const take = () => {
      const pending = [...client.pending.values()].find(item => !item.delivered)
      if (!pending) return []
      pending.delivered = true
      return [pending.command]
    }
    const queued = take()
    if (queued.length) return queued
    return new Promise(resolve => {
      const timer = setTimeout(() => client.wake?.(), this.options.pollMs)
      client.wake = () => { clearTimeout(timer); client.wake = undefined; resolve(this.clients.has(id) ? take() : []) }
    })
  }
  active(identity: WorkbenchIdentity, id: string, token: string, requestId: string, execution: BrowserExecutionIdentity): boolean {
    const pending = this.authorize(identity, id, token).pending.get(requestId)
    return Boolean(pending?.delivered && browserExecutionsMatch(execution, pending.command.execution))
  }
  result(identity: WorkbenchIdentity, id: string, token: string, requestId: string, execution: BrowserExecutionIdentity, result: ToolResult): boolean {
    const pending = this.authorize(identity, id, token).pending.get(requestId)
    if (!pending?.delivered || !browserExecutionsMatch(execution, pending.command.execution)) return false
    pending.settle(result)
    return true
  }
  execute(action: WorkbenchAction, args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
    this.prune()
    if (ctx.signal?.aborted) return Promise.resolve(failure('WORKBENCH_CANCELLED', '任务已停止，本次工作台操作未执行。'))
    const execution = browserExecutionIdentity(ctx)
    if (!execution) return Promise.resolve(failure('WORKBENCH_RUN_REQUIRED', '工作台操作需要当前任务的执行身份。'))
    const identity = { tenantId: ctx.tenantId ?? 'default', userId: ctx.browserPrincipal?.userId }
    const client = this.clients.get(this.scopes.get(key(identity, execution.rootSessionId)) ?? '')
    if (!client) return Promise.resolve(failure('WORKBENCH_UNAVAILABLE', '所属会话的 Aether 工作台未连接。文件仍可生成并提供真实链接；不要声称已经在客户端打开。'))
    if (!client.actions.includes(action)) return Promise.resolve(failure('WORKBENCH_UNSUPPORTED', '当前工作台未提供此操作，请先调用 workbench_context 查询。'))
    if (client.pending.size >= 8) return Promise.resolve(failure('WORKBENCH_BUSY', '当前工作台已有待处理操作，请等待已有操作回执。'))
    const command: WorkbenchCommand = { requestId: randomUUID(), sessionId: execution.rootSessionId, execution, action, args, expiresAt: Date.now() + this.options.commandMs }
    return new Promise(resolve => {
      const finish = (result: ToolResult) => {
        if (!client.pending.delete(command.requestId)) return
        clearTimeout(timer); ctx.signal?.removeEventListener('abort', cancel); resolve(result)
      }
      const pending: Pending = { command, delivered: false, settle: finish }
      const cancel = () => finish(failure('WORKBENCH_CANCELLED', '任务已停止。已投递操作的结果需重新查询，不应盲目重放。', pending.delivered ? 'unknown' : false))
      const timer = setTimeout(() => finish(failure('WORKBENCH_TIMEOUT', '工作台未及时确认。请读取工作台状态；不要将请求发出当成文件显示成功。', pending.delivered ? 'unknown' : false)), this.options.commandMs)
      client.pending.set(command.requestId, pending)
      ctx.signal?.addEventListener('abort', cancel, { once: true })
      if (ctx.signal?.aborted) cancel()
      else client.wake?.()
    })
  }
  dispose(): void { clearInterval(this.timer); for (const client of [...this.clients.values()]) this.remove(client) }
}
export const workbenchBridge = new WorkbenchBridge()

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { browserAuthorityKey, snapshotBrowserAuthority, type BrowserHostAuthority } from '../../core/browser-authority.js'
import { browserExecutionsMatch, type BrowserExecutionIdentity } from '../../core/browser-execution.js'

export class BrowserHostDemandError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message) }
}
export interface BrowserHostDemand {
  demandId: string
  demandToken: string
  execution: Readonly<BrowserExecutionIdentity>
  expiresAt: number
}
interface Host {
  id: string; token: string; authority: BrowserHostAuthority; expiresAt: number
  wake?: () => void
}
interface Waiter<T> { finish(error: BrowserHostDemandError | undefined, registration?: T): void }
interface Demand<T> {
  public: BrowserHostDemand; host: Host; key: string; delivered: boolean; waiters: Set<Waiter<T>>
  timer: ReturnType<typeof setTimeout>; watches: Set<() => void>
}
interface Slot<T> { host: Host; execution: Readonly<BrowserExecutionIdentity>; registration: T }
export interface NativeHostDemandOptions<T> {
  register(authority: BrowserHostAuthority, execution: Readonly<BrowserExecutionIdentity>, hostId: string): T
  release(registration: T): void
  leaseMs?: number; pollTimeoutMs?: number; demandTimeoutMs?: number
  maxHosts?: number; maxDemands?: number; maxDemandsPerHost?: number; maxSlotsPerHost?: number
  maxWaitersPerDemand?: number
}
const tokenMatches = (supplied: string, expected: string) => {
  const a = Buffer.from(supplied), b = Buffer.from(expected)
  return !!a.length && a.length === b.length && timingSafeEqual(a, b)
}
const error = (status: number, code: string, message: string) => new BrowserHostDemandError(status, code, message)
const rootKey = (authority: BrowserHostAuthority, execution: BrowserExecutionIdentity) => JSON.stringify([browserAuthorityKey(authority), execution.rootSessionId, execution.rootRunId])

/** First use is a bounded server-owned handshake, not a UI selection or model retry heuristic. */
export class NativeHostDemandBroker<T extends { clientId: string }> {
  private readonly hosts = new Map<string, Host>()
  private readonly authorities = new Map<string, Host>()
  private readonly demands = new Map<string, Demand<T>>()
  private readonly roots = new Map<string, Demand<T>>()
  private readonly slots = new Map<string, Slot<T>>()
  private disposed = false
  readonly leaseMs: number
  readonly pollTimeoutMs: number
  readonly demandTimeoutMs: number
  private readonly timer: ReturnType<typeof setInterval>
  constructor(private readonly options: NativeHostDemandOptions<T>) {
    this.leaseMs = options.leaseMs ?? 65_000
    this.pollTimeoutMs = options.pollTimeoutMs ?? 20_000
    this.demandTimeoutMs = options.demandTimeoutMs ?? 20_000
    this.timer = setInterval(() => this.prune(), Math.max(1, Math.min(this.leaseMs, 30_000)))
    this.timer.unref()
  }
  register(authorityInput: BrowserHostAuthority, resume?: { hostId: string; hostToken: string }) {
    this.prune()
    if (this.disposed) throw error(503, 'BROWSER_HOST_CLOSED', 'Browser host service is closed')
    const authority = snapshotBrowserAuthority(authorityInput)
    if (!authority) throw error(403, 'BROWSER_HOST_AUTHORITY_UNAVAILABLE', 'Trusted browser authority is required')
    if (resume) return this.registration(this.authorize(authority, resume.hostId, resume.hostToken))
    const key = browserAuthorityKey(authority)
    if (this.authorities.has(key)) throw error(409, 'BROWSER_HOST_CONFLICT', 'This authority already has a browser host')
    if (this.hosts.size >= (this.options.maxHosts ?? 32)) throw error(429, 'BROWSER_HOST_CAPACITY', 'Browser host limit reached')
    const host: Host = { id: randomUUID(), token: randomBytes(32).toString('base64url'), authority, expiresAt: Date.now() + this.leaseMs }
    this.hosts.set(host.id, host); this.authorities.set(key, host)
    return this.registration(host)
  }
  private registration(host: Host) {
    return { hostId: host.id, hostToken: host.token, authority: host.authority, protocolVersion: 1 as const,
      leaseMs: this.leaseMs, pollTimeoutMs: this.pollTimeoutMs, demandTimeoutMs: this.demandTimeoutMs,
      capabilities: { nativeHostDemand: 1 as const } }
  }
  private authorize(authority: BrowserHostAuthority, id: string, token: string): Host {
    this.prune()
    const host = this.hosts.get(id)
    if (!host || browserAuthorityKey(host.authority) !== browserAuthorityKey(authority) || !tokenMatches(token, host.token)) {
      throw error(404, 'BROWSER_HOST_UNAVAILABLE', 'Browser host not found or not owned')
    }
    host.expiresAt = Date.now() + this.leaseMs
    return host
  }
  private prune(): void {
    for (const host of this.hosts.values()) if (host.expiresAt <= Date.now()) this.remove(host, 'BROWSER_HOST_DISCONNECTED')
  }
  private closeDemand(demand: Demand<T>, failure?: BrowserHostDemandError, registration?: T): void {
    if (!this.demands.delete(demand.public.demandId)) return
    this.roots.delete(demand.key)
    clearTimeout(demand.timer)
    for (const waiter of [...demand.waiters]) waiter.finish(failure, registration)
    for (const wake of [...demand.watches]) wake()
    demand.host.wake?.()
  }
  private remove(host: Host, code: string): void {
    this.hosts.delete(host.id); this.authorities.delete(browserAuthorityKey(host.authority))
    for (const demand of [...this.demands.values()]) if (demand.host === host) this.closeDemand(demand, error(503, code, 'Native browser host disconnected before handshake'))
    for (const [key, slot] of [...this.slots]) if (slot.host === host) { this.slots.delete(key); this.options.release(slot.registration) }
    host.wake?.()
  }
  unregister(authority: BrowserHostAuthority, id: string, token: string): void { this.remove(this.authorize(authority, id, token), 'BROWSER_HOST_DISCONNECTED') }
  async poll(authority: BrowserHostAuthority, id: string, token: string, signal?: AbortSignal): Promise<BrowserHostDemand[]> {
    const host = this.authorize(authority, id, token)
    if (host.wake) throw error(409, 'BROWSER_HOST_POLL_CONFLICT', 'Only one host demand poll may be active')
    const take = () => {
      const demand = [...this.demands.values()].find(item => item.host === host && !item.delivered)
      if (!demand) return []
      demand.delivered = true
      return [demand.public]
    }
    if (signal?.aborted) return []
    const immediate = take()
    if (immediate.length) return immediate
    return new Promise(resolve => {
      const wake = () => {
        clearTimeout(timer); signal?.removeEventListener('abort', wake)
        if (host.wake === wake) host.wake = undefined
        resolve(signal?.aborted || this.hosts.get(host.id) !== host ? [] : take())
      }
      const timer = setTimeout(wake, this.pollTimeoutMs)
      host.wake = wake; signal?.addEventListener('abort', wake, { once: true })
      if (signal?.aborted) wake()
    })
  }
  async acquire(authority: BrowserHostAuthority, execution: Readonly<BrowserExecutionIdentity>, signal?: AbortSignal): Promise<T> {
    this.prune()
    if (signal?.aborted) throw error(409, 'BROWSER_COMMAND_CANCELLED', 'Browser handshake was cancelled before any page operation')
    const key = rootKey(authority, execution)
    const slot = this.slots.get(key)
    if (slot) return slot.registration
    const host = this.authorities.get(browserAuthorityKey(authority))
    if (!host || this.disposed) throw error(503, 'BROWSER_HOST_UNAVAILABLE', 'No matching live native browser host')
    let demand = this.roots.get(key)
    if (!demand) {
      if (this.demands.size >= (this.options.maxDemands ?? 128) || [...this.demands.values()].filter(item => item.host === host).length >= (this.options.maxDemandsPerHost ?? 32)) {
        throw error(429, 'BROWSER_HOST_DEMAND_CAPACITY', 'Browser first-use handshake limit reached')
      }
      const capacity = [...this.slots.values()].filter(item => item.host === host).length + [...this.demands.values()].filter(item => item.host === host).length
      if (capacity >= (this.options.maxSlotsPerHost ?? 32)) throw error(429, 'BROWSER_HOST_SLOT_CAPACITY', 'Browser active root limit reached')
      const publicDemand = Object.freeze({ demandId: randomUUID(), demandToken: randomBytes(32).toString('base64url'), execution: Object.freeze({ ...execution }), expiresAt: Date.now() + this.demandTimeoutMs })
      const created: Demand<T> = { public: publicDemand, host, key, delivered: false, waiters: new Set(), watches: new Set(),
        timer: setTimeout(() => this.closeDemand(created, error(504, 'BROWSER_HOST_DEMAND_TIMEOUT', 'Native browser first-use handshake timed out')), this.demandTimeoutMs) }
      created.timer.unref()
      demand = created; this.demands.set(publicDemand.demandId, created); this.roots.set(key, created)
    }
    const current = demand
    if (current.waiters.size >= (this.options.maxWaitersPerDemand ?? 32)) throw error(429, 'BROWSER_HOST_WAITER_CAPACITY', 'Browser handshake waiter limit reached')
    return new Promise<T>((resolve, reject) => {
      let finished = false
      const waiter: Waiter<T> = { finish: (failure, registration) => {
        if (finished) return
        finished = true; current.waiters.delete(waiter); signal?.removeEventListener('abort', cancel)
        if (failure) reject(failure)
        else if (registration) resolve(registration)
        else reject(error(503, 'BROWSER_HOST_UNAVAILABLE', 'Native browser handshake ended without a client'))
      } }
      const cancel = () => {
        waiter.finish(error(409, 'BROWSER_COMMAND_CANCELLED', 'Browser handshake was cancelled before any page operation'))
        if (!current.waiters.size) this.closeDemand(current, error(409, 'BROWSER_COMMAND_CANCELLED', 'All browser handshake waiters cancelled'))
      }
      current.waiters.add(waiter); signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
      else host.wake?.()
    })
  }
  private demandFor(host: Host, id: string, token: string, execution: BrowserExecutionIdentity): Demand<T> | undefined {
    const demand = this.demands.get(id)
    return demand && demand.host === host && demand.delivered && demand.public.expiresAt > Date.now() &&
      tokenMatches(token, demand.public.demandToken) && browserExecutionsMatch(execution, demand.public.execution) ? demand : undefined
  }
  async state(authority: BrowserHostAuthority, id: string, hostToken: string, demandId: string, demandToken: string,
    execution: BrowserExecutionIdentity, wait = false, signal?: AbortSignal): Promise<{ active: boolean; execution?: Readonly<BrowserExecutionIdentity> }> {
    const host = this.authorize(authority, id, hostToken), demand = this.demandFor(host, demandId, demandToken, execution)
    const state = () => ({ active: !!demand && this.demands.get(demandId) === demand && !!demand.waiters.size,
      ...(demand && this.demands.get(demandId) === demand ? { execution: demand.public.execution } : {}) })
    if (!demand || !wait || signal?.aborted) return state()
    if (demand.watches.size >= 4) throw error(429, 'BROWSER_HOST_WATCH_CAPACITY', 'Too many handshake cancellation watches')
    return new Promise(resolve => {
      const wake = () => { clearTimeout(timer); signal?.removeEventListener('abort', wake); demand.watches.delete(wake); resolve(state()) }
      const timer = setTimeout(wake, Math.min(this.pollTimeoutMs, this.demandTimeoutMs))
      demand.watches.add(wake); signal?.addEventListener('abort', wake, { once: true })
      if (signal?.aborted) wake()
    })
  }
  ready(authority: BrowserHostAuthority, id: string, hostToken: string, demandId: string, demandToken: string, execution: BrowserExecutionIdentity): T {
    const host = this.authorize(authority, id, hostToken), demand = this.demandFor(host, demandId, demandToken, execution)
    if (!demand || !demand.waiters.size) throw error(409, 'BROWSER_HOST_DEMAND_CLOSED', 'First-use handshake no longer active')
    // Registration, ownership indexing and readiness settlement share one synchronous barrier.
    let registration: T
    try { registration = this.options.register(host.authority, demand.public.execution, host.id) }
    catch (cause) { this.closeDemand(demand, error(409, 'BROWSER_HOST_CLIENT_REGISTRATION_FAILED', 'Owned browser client registration failed')); throw cause }
    this.slots.set(demand.key, { host, execution: demand.public.execution, registration })
    this.closeDemand(demand, undefined, registration)
    return registration
  }
  reject(authority: BrowserHostAuthority, id: string, hostToken: string, demandId: string, demandToken: string, execution: BrowserExecutionIdentity, code: string): boolean {
    const host = this.authorize(authority, id, hostToken), demand = this.demandFor(host, demandId, demandToken, execution)
    if (!demand) return false
    this.closeDemand(demand, error(503, code, 'Native browser host could not establish the owned root client'))
    return true
  }
  releaseRoot(authority: BrowserHostAuthority, rootSessionId: string, rootRunId: string): void {
    const key = rootKey(authority, { rootSessionId, rootRunId, ownerRunId: rootRunId })
    const demand = this.roots.get(key)
    if (demand) this.closeDemand(demand, error(409, 'BROWSER_COMMAND_CANCELLED', 'Root run ended before browser handshake'))
    const slot = this.slots.get(key)
    if (slot) { this.slots.delete(key); this.options.release(slot.registration) }
  }
  forgetClient(clientId: string): void {
    for (const [key, slot] of this.slots) if (slot.registration.clientId === clientId) this.slots.delete(key)
  }
  releaseOwnedRoot(authority: BrowserHostAuthority, id: string, token: string, rootSessionId: string, rootRunId: string): void {
    this.authorize(authority, id, token); this.releaseRoot(authority, rootSessionId, rootRunId)
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true; clearInterval(this.timer)
    for (const host of [...this.hosts.values()]) this.remove(host, 'BROWSER_HOST_CLOSED')
  }
}

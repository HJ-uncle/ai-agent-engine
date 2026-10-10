/** Terminal processes are owned by a tenant/user and never fall back to a host shell. */
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import * as pty from 'node-pty'
import { getWorkspaceRuntimeMode, prepareWorkspaceExecution, type WorkspaceExecutionPlan } from '../runtime/workspace-runtime.js'
import { verifyTerminalDependencyPatch } from '../runtime/dependency-patches.js'

export interface TerminalSession {
  id: string
  pty: pty.IPty
  cwd: string
  title: string
  events: EventEmitter
  tenantId: string
  userId?: string
}

interface CleanupFailure {
  code?: string
  message?: string
  errors?: Array<{ phase?: string; code?: string; name?: string; message?: string; stack?: string }>
}

interface ExitInfo {
  exitCode: number
  signal?: number
  cleanupError?: CleanupFailure
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(value => { resolve = value })
  return { promise, resolve }
}

const EXIT_WAIT_MS = 5_000

export interface TerminalOwner {
  tenantId: string
  userId?: string
  sessionId?: string
}

class TerminalManager {
  private sessions = new Map<string, TerminalSession>()
  private ownerCounts = new Map<string, number>()
  private cleanups = new Map<string, () => Promise<void>>()
  private starting = new Set<string>()
  private pending = new Map<string, Promise<TerminalSession>>()
  private cancelled = new Set<string>()
  private generation = 0
  private closing = new Map<string, Promise<void>>()
  private exits = new Map<string, Deferred<ExitInfo>>()
  private exitInfo = new Map<string, ExitInfo>()
  private cleanupErrors = new Map<string, CleanupFailure>()
  private cleanupPromises = new Map<string, Promise<void>>()
  private publishedExits = new Set<string>()
  private killIssued = new Set<string>()
  private killErrors = new Map<string, unknown>()
  private receipts = new Map<string, { tenantId: string; userId?: string; expires: number }>()

  create(id: string, cwd: string, cols = 120, rows = 30, workspaceRoots?: string[], owner?: TerminalOwner): Promise<TerminalSession> {
    if (this.pending.has(id)) return Promise.reject(new Error('Terminal id already exists'))
    const creation = this.createSession(id, cwd, cols, rows, workspaceRoots, owner, this.generation)
    this.pending.set(id, creation)
    void creation.finally(() => this.pending.delete(id)).catch(() => {})
    return creation
  }

  private async createSession(id: string, cwd: string, cols: number, rows: number, workspaceRoots: string[] | undefined, owner: TerminalOwner | undefined, generation: number): Promise<TerminalSession> {
    const tenantId = owner?.tenantId ?? 'default'
    const ownerKey = `${tenantId}\u0000${owner?.userId ?? ''}`
    if (this.sessions.has(id) || this.starting.has(id)) throw new Error('Terminal id already exists')
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || cols > 500 || rows < 1 || rows > 500) throw new Error('Terminal dimensions are invalid')
    if (!existsSync(cwd)) throw new Error('Terminal working directory does not exist')
    if ((this.ownerCounts.get(ownerKey) ?? 0) >= 32) throw new Error('Terminal limit reached for this owner')
    // Reserve before the runtime's asynchronous availability check, so concurrent
    // create requests cannot all pass the same owner capacity check.
    this.starting.add(id)
    this.ownerCounts.set(ownerKey, (this.ownerCounts.get(ownerKey) ?? 0) + 1)
    let plan: WorkspaceExecutionPlan | undefined
    try {
      const roots = workspaceRoots && workspaceRoots.length > 0 ? workspaceRoots : [cwd]
      const mode = getWorkspaceRuntimeMode()
      if (mode === 'docker') {
        plan = await prepareWorkspaceExecution({ tenantId, userId: owner?.userId, sessionId: owner?.sessionId ?? id,
          workspaceRoot: roots[0], cwd, command: '/bin/bash', args: ['--noprofile', '--norc'], interactive: true })
      }
      if (generation !== this.generation || this.cancelled.has(id)) throw new Error('Terminal creation cancelled')
      const shellScript = resolve(dirname(fileURLToPath(import.meta.url)), './workspace-shell.mjs')
      verifyTerminalDependencyPatch()
      const spawnOptions: pty.IPtyForkOptions = {
        name: 'xterm-256color', cols, rows, cwd: plan?.cwd ?? cwd,
        env: plan?.env ?? { ...executionEnvironment(), TERM: 'xterm-256color', COLORTERM: 'truecolor',
          WORKSPACE_ROOT: roots[0], WORKSPACE_ROOTS: JSON.stringify(roots) },
      }
      if (globalThis.process.platform === 'win32') Object.assign(spawnOptions, { useConpty: true, useConptyDll: false })
      let process: pty.IPty | undefined
      if (plan) {
        // A configured isolation runtime failing to start is fatal. Trying a
        // host executable here would turn a runtime outage into an escape.
        process = pty.spawn(plan.binary, plan.args, spawnOptions)
      } else {
        const candidates = [globalThis.process.env.AETHER_ENGINE_NODE, globalThis.process.platform === 'win32' ? 'node.exe' : 'node'].filter((value): value is string => Boolean(value))
        for (const binary of candidates) {
          try { process = pty.spawn(binary, [shellScript], spawnOptions); break }
          catch { /* Only another Node binary for the same file-only shell may be tried. */ }
        }
      }
      if (!process) throw new Error('Failed to start restricted workspace shell')
      const events = new EventEmitter()
      const session: TerminalSession = { id, pty: process, cwd, title: plan ? 'isolated-linux' : 'workspace-shell', events,
        tenantId, userId: owner?.userId }
      this.sessions.set(id, session)
      if (plan) this.cleanups.set(id, plan.cleanup)
      const exit = deferred<ExitInfo>()
      this.exits.set(id, exit)
      process.onData(data => events.emit('data', data))
      const ptyWithCleanup = process as pty.IPty & { onCleanup?: (listener: (event: { cleanupError?: CleanupFailure }) => void) => { dispose?: () => void } }
      ptyWithCleanup.onCleanup?.(({ cleanupError }) => {
        if (cleanupError) this.cleanupErrors.set(id, cleanupError)
        const current = this.exitInfo.get(id)
        if (current && cleanupError) current.cleanupError = cleanupError
      })
      process.onExit((info) => {
        const exitInfo: ExitInfo = { exitCode: info.exitCode, signal: info.signal,
          cleanupError: (info as typeof info & { cleanupError?: CleanupFailure }).cleanupError ?? this.cleanupErrors.get(id) }
        this.exitInfo.set(id, exitInfo)
        this.exits.get(id)?.resolve(exitInfo)
        // Docker's CLI can exit before its owned container is gone. A natural
        // exit still waits for owned cleanup before publishing or releasing the
        // owner slot. An explicit kill shares this same close promise.
        if (!this.closing.has(id)) void this.finalizeNatural(id, ownerKey)
      })
      return session
    } catch (error) {
      this.decrementOwner(ownerKey)
      if (plan) await plan.cleanup()
      throw error
    } finally { this.starting.delete(id); this.cancelled.delete(id) }
  }

  get(id: string): TerminalSession | undefined { return this.sessions.get(id) }

  getCloseOwner(id: string): { tenantId: string; userId?: string } | undefined {
    const session = this.sessions.get(id)
    if (session) return session
    this.pruneReceipts()
    return this.receipts.get(id)
  }

  write(id: string, data: string): boolean {
    if (typeof data !== 'string' || data.length > 64 * 1024) return false
    const session = this.sessions.get(id)
    if (!session || this.closing.has(id) || this.killIssued.has(id) || this.exitInfo.has(id)) return false
    session.pty.write(data)
    return true
  }

  resize(id: string, cols: number, rows: number): boolean {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || cols > 500 || rows < 1 || rows > 500) return false
    const session = this.sessions.get(id)
    if (!session || this.closing.has(id) || this.killIssued.has(id) || this.exitInfo.has(id)) return false
    session.pty.resize(cols, rows)
    return true
  }

  async kill(id: string): Promise<void> {
    const existing = this.closing.get(id)
    if (existing) return existing
    // Publish the shared operation before kill can synchronously emit onExit.
    const close = Promise.resolve().then(() => this.close(id))
    this.closing.set(id, close)
    try { await close } finally { this.closing.delete(id) }
  }

  private async close(id: string): Promise<void> {
    const pending = this.pending.get(id)
    if (this.starting.has(id) && pending) {
      this.cancelled.add(id)
      await pending.catch(() => {})
    }
    const session = this.sessions.get(id)
    if (!session) { await this.cleanup(id); return }
    if (!this.killIssued.has(id) && !this.exitInfo.has(id)) {
      this.killIssued.add(id)
      try { session.pty.kill() } catch (error) { this.killErrors.set(id, error) }
    }
    const killError = this.killErrors.get(id)
    // Start owned cleanup immediately after kill; do not wait for a potentially
    // blocked shell exit before removing the Docker/container resource.
    const cleanup = this.withTimeout(this.cleanup(id), EXIT_WAIT_MS, 'PTY_RUNTIME_CLEANUP_TIMEOUT')
    const observedCleanup = cleanup.then(() => undefined, error => error)
    const exit = this.exits.get(id)?.promise ?? Promise.reject(new Error('PTY_EXIT_UNAVAILABLE'))
    let exitInfo: ExitInfo
    try { exitInfo = await this.withTimeout(exit, EXIT_WAIT_MS, 'PTY_EXIT_TIMEOUT') }
    catch (error) {
      const cleanupError = await observedCleanup
      throw this.combineCloseErrors(killError, this.combineCloseErrors(error,
        this.combineCloseErrors(cleanupError, this.cleanupErrors.get(id))))
    }
    const cleanupError = await observedCleanup
    const reportedCleanup = exitInfo.cleanupError
    if (killError || cleanupError || reportedCleanup) {
      // Keep the session and owner reservation for a retry. The PTY may have
      // exited, but cleanup did not reach a confirmed terminal state.
      throw this.combineCloseErrors(killError, this.combineCloseErrors(cleanupError, reportedCleanup))
    }
    this.publishExit(id, exitInfo.exitCode)
    this.releaseSession(id, session)
  }

  async killAll(): Promise<void> {
    this.generation++
    // Shutdown must also wait for creates currently inside the Docker probe;
    // otherwise a container could be provisioned after the shutdown sweep.
    await Promise.allSettled([...this.pending.values()])
    const results = await Promise.allSettled([...new Set([...this.sessions.keys(), ...this.cleanups.keys()])].map(id => this.kill(id)))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Some isolated terminal containers could not be removed')
  }

  list(): Array<{ id: string; cwd: string; title: string }> {
    return [...this.sessions.values()].map(session => ({ id: session.id, cwd: session.cwd, title: session.title }))
  }

  private async cleanup(id: string): Promise<void> {
    const existing = this.cleanupPromises.get(id)
    if (existing) return existing
    const cleanup = this.cleanups.get(id)
    if (!cleanup) return
    const operation = Promise.resolve().then(() => cleanup())
    this.cleanupPromises.set(id, operation)
    try { await operation }
    finally {
      this.cleanupPromises.delete(id)
      // Keep a failed callback available for an explicit retry; successful
      // cleanup is released only after the PTY exit has also been observed.
      if (!this.sessions.has(id) && !this.exitInfo.has(id)) this.cleanups.delete(id)
    }
  }

  private async finalizeNatural(id: string, ownerKey: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    const info = await (this.exits.get(id)?.promise ?? Promise.resolve(this.exitInfo.get(id)!))
    try { await this.withTimeout(this.cleanup(id), EXIT_WAIT_MS, 'PTY_RUNTIME_CLEANUP_TIMEOUT') }
    catch (error) {
      session.events.emit('data', `\r\n[Isolated terminal cleanup failed: ${error instanceof Error ? error.message : String(error)}]\r\n`)
      this.publishExit(id, 1)
      return
    }
    if (info.cleanupError) {
      session.events.emit('data', `\r\n[Terminal cleanup failed: ${this.cleanupErrorMessage(info.cleanupError)}]\r\n`)
      this.publishExit(id, 1)
      return
    }
    this.publishExit(id, info.exitCode)
    this.releaseSession(id, session, ownerKey)
  }

  private releaseSession(id: string, session: TerminalSession, ownerKey = `${session.tenantId}\u0000${session.userId ?? ''}`): void {
    if (this.sessions.delete(id)) this.decrementOwner(ownerKey)
    this.cleanups.delete(id)
    this.cleanupPromises.delete(id)
    this.exits.delete(id)
    this.exitInfo.delete(id)
    this.cleanupErrors.delete(id)
    this.killIssued.delete(id)
    this.killErrors.delete(id)
    this.pruneReceipts()
    this.receipts.set(id, { tenantId: session.tenantId, userId: session.userId, expires: Date.now() + 30_000 })
    while (this.receipts.size > 256) this.receipts.delete(this.receipts.keys().next().value!)
  }

  private publishExit(id: string, code: number): void {
    if (this.publishedExits.has(id)) return
    this.publishedExits.add(id)
    this.sessions.get(id)?.events.emit('exit', code)
    // No session remains after release; retain only a bounded synchronous guard
    // against duplicate native exit callbacks in this process turn.
    queueMicrotask(() => this.publishedExits.delete(id))
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([promise, new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), timeoutMs)
        timer.unref()
      })])
    } finally { if (timer) clearTimeout(timer) }
  }

  private cleanupErrorMessage(error: CleanupFailure): string {
    return error.message ?? error.errors?.map(item => `${item.phase ?? 'cleanup'}: ${item.message ?? item.code ?? 'failed'}`).join('; ') ?? 'unknown cleanup error'
  }

  private combineCloseErrors(first: unknown, second: unknown): Error | undefined {
    if (!first && !second) return undefined
    const normalize = (value: unknown): Error => value instanceof Error ? value : new Error(`PTY_CLEANUP_FAILED: ${this.cleanupErrorMessage(value as CleanupFailure)}`)
    if (first && second) return new AggregateError([first, second], `Terminal close failed: ${normalize(first).message}; ${normalize(second).message}`)
    return normalize(first ?? second)
  }

  private pruneReceipts(): void {
    for (const [id, receipt] of this.receipts) if (receipt.expires <= Date.now()) this.receipts.delete(id)
  }

  private decrementOwner(ownerKey: string): void {
    const remaining = (this.ownerCounts.get(ownerKey) ?? 1) - 1
    if (remaining > 0) this.ownerCounts.set(ownerKey, remaining); else this.ownerCounts.delete(ownerKey)
  }
}

export const terminalManager = new TerminalManager()

/** The file-only helper has no reason to inherit service credentials. */
function executionEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'Path', 'PATHEXT', 'ComSpec', 'COMSPEC', 'SystemRoot', 'SYSTEMROOT',
    'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'LANG', 'TERM', 'COLORTERM', 'AETHER_ENGINE_NODE'])
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key) || key.startsWith('LC_')))
}

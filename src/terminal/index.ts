/** Terminal processes are owned by a tenant/user and never fall back to a host shell. */
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import * as pty from 'node-pty'
import { getWorkspaceRuntimeMode, prepareWorkspaceExecution, type WorkspaceExecutionPlan } from '../runtime/workspace-runtime.js'

export interface TerminalSession {
  id: string
  pty: pty.IPty
  cwd: string
  title: string
  events: EventEmitter
  tenantId: string
  userId?: string
}

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
      const spawnOptions: pty.IPtyForkOptions = {
        name: 'xterm-256color', cols, rows, cwd: plan?.cwd ?? cwd,
        env: plan?.env ?? { ...executionEnvironment(), TERM: 'xterm-256color', COLORTERM: 'truecolor',
          WORKSPACE_ROOT: roots[0], WORKSPACE_ROOTS: JSON.stringify(roots) },
      }
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
      process.onData(data => events.emit('data', data))
      process.onExit(({ exitCode }) => {
        if (this.sessions.delete(id)) this.decrementOwner(ownerKey)
        // Docker's CLI can exit before its owned container is gone. Do not
        // publish a clean exit until container removal has been confirmed.
        void this.cleanup(id).then(() => events.emit('exit', exitCode)).catch(error => {
          events.emit('data', `\r\n[Isolated terminal cleanup failed: ${error instanceof Error ? error.message : String(error)}]\r\n`)
          events.emit('exit', 1)
        })
      })
      return session
    } catch (error) {
      this.decrementOwner(ownerKey)
      if (plan) await plan.cleanup()
      throw error
    } finally { this.starting.delete(id); this.cancelled.delete(id) }
  }

  get(id: string): TerminalSession | undefined { return this.sessions.get(id) }

  write(id: string, data: string): boolean {
    if (typeof data !== 'string' || data.length > 64 * 1024) return false
    const session = this.sessions.get(id)
    if (!session) return false
    session.pty.write(data)
    return true
  }

  resize(id: string, cols: number, rows: number): boolean {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || cols > 500 || rows < 1 || rows > 500) return false
    const session = this.sessions.get(id)
    if (!session) return false
    session.pty.resize(cols, rows)
    return true
  }

  async kill(id: string): Promise<void> {
    const pending = this.pending.get(id)
    if (this.starting.has(id) && pending) {
      this.cancelled.add(id)
      await pending.catch(() => {})
    }
    const session = this.sessions.get(id)
    if (!session) { await this.cleanup(id); return }
    try { session.pty.kill() } catch { /* Exit still requires the runtime cleanup below. */ }
    await this.cleanup(id)
    if (this.sessions.delete(id)) this.decrementOwner(`${session.tenantId}\u0000${session.userId ?? ''}`)
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
    const cleanup = this.cleanups.get(id)
    if (!cleanup) return
    await cleanup()
    // Keep the cleanup callback until the PTY has exited. An early missing
    // container result can race Docker's create call while a terminal is killed.
    if (!this.sessions.has(id)) this.cleanups.delete(id)
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

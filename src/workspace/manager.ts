import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { AgentContext } from '../core/agent-context/index.js'
import { getSecurityMode } from '../security/policy-engine.js'

type CtxLike = Pick<AgentContext, 'tenantId' | 'sessionId' | 'workspacePaths' | 'cwd' | 'projectRoot' | 'scratchDir'>

export class WorkspaceManager {
  private readonly root: string
  private readonly allowedRoots: string[]

  constructor(root?: string) {
    this.root = path.resolve(root ?? process.env.WORKSPACE_ROOT ?? './workspace')
    this.allowedRoots = [...new Set([
      this.root,
      ...(process.env.AETHER_ALLOWED_WORKSPACE_ROOTS ?? '').split(path.delimiter).filter(Boolean).map(value => path.resolve(value))
    ])]
  }

  /**
   * Workspace selection is user state, not process state. Keep it beside the
   * configured engine database so a remote engine restart cannot silently
   * send an existing session back to its scratch directory. The optional
   * override is useful for managed deployments and isolated tests.
   */
  private bindingsFile(): string {
    const configured = process.env.AETHER_WORKSPACE_BINDINGS_FILE
    if (configured?.trim()) return path.resolve(configured)
    const dbFile = path.resolve(process.env.DATA_DIR ?? path.join(this.root, '..', 'agent.db'))
    // Keep test/custom roots self-contained. Production deployments may set
    // DATA_DIR to place this small state file beside the main database.
    return process.env.DATA_DIR ? path.join(path.dirname(dbFile), 'workspace-bindings.json') :
      path.join(this.root, '.aether-workspace-bindings.json')
  }

  private readBindings(): Map<string, string> {
    const file = this.bindingsFile()
    const bindings = new Map<string, string>()
    let parsed: unknown
    try {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('binding state must not be a symbolic link')
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return bindings
      throw new Error(`Workspace binding state is unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!parsed || typeof parsed !== 'object' || (parsed as any).version !== 1 || !Array.isArray((parsed as any).bindings)) {
      throw new Error('Workspace binding state is invalid')
    }
    for (const item of (parsed as any).bindings) {
      if (!item || typeof item !== 'object' || typeof item.tenantId !== 'string' ||
        typeof item.sessionId !== 'string' || typeof item.workspaceRoot !== 'string') {
        throw new Error('Workspace binding state contains an invalid entry')
      }
      this.validateId(item.tenantId, 'tenantId')
      this.validateId(item.sessionId, 'sessionId')
      if (!path.isAbsolute(item.workspaceRoot)) throw new Error('Workspace binding state contains a relative path')
      const key = `${item.tenantId}\u0000${item.sessionId}`
      if (bindings.has(key)) throw new Error('Workspace binding state contains duplicate session bindings')
      // Retain unavailable/disallowed selections. Reading that session must
      // report the problem, never quietly change its development directory.
      bindings.set(key, path.resolve(item.workspaceRoot))
    }
    return bindings
  }

  private persistBindings(state: Map<string, string>): void {
    const file = this.bindingsFile()
    try {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Workspace binding state must not be a symbolic link')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const bindings = [...state.entries()].map(([key, workspaceRoot]) => {
      const separator = key.indexOf('\u0000')
      return { tenantId: key.slice(0, separator), sessionId: key.slice(separator + 1), workspaceRoot }
    })
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    try {
      const descriptor = fs.openSync(temporary, 'wx', 0o600)
      try {
        fs.writeFileSync(descriptor, JSON.stringify({ version: 1, bindings }, null, 2) + '\n', 'utf8')
        fs.fsyncSync(descriptor)
      } finally { fs.closeSync(descriptor) }
      fs.renameSync(temporary, file)
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }) } catch { /* preserve original error */ }
      throw error
    }
  }

  private validateBoundDirectory(ctx: CtxLike, bound: string, bindings: Map<string, string>): string {
    if (!fs.existsSync(bound) || !fs.statSync(bound).isDirectory()) throw new Error('Bound workspace is no longer available')
    const canonical = fs.realpathSync(bound)
    if (!this.allowedRoots.some(base => this.isContained(this.realpathIfExists(base), canonical))) {
      throw new Error('Bound workspace is outside the engine allowed workspace roots')
    }
    if (this.isAuthenticated()) {
      const privateRoot = this.canonicalPrivateRoot()
      const tenant = this.isContained(privateRoot, canonical)
        ? path.relative(privateRoot, canonical).split(path.sep).filter(Boolean)[0]
        : undefined
      if (tenant && tenant !== ctx.tenantId) throw new Error('Bound workspace belongs to another tenant')
      if (this.isContained(privateRoot, canonical) && !tenant) throw new Error('The private workspace root cannot be bound')
    }
    if (this.isAuthenticated()) {
      for (const [key, owned] of bindings) {
        if (key.split('\u0000')[0] === ctx.tenantId) continue
        if (!fs.existsSync(owned) || !fs.statSync(owned).isDirectory()) continue
        const other = fs.realpathSync(owned)
        if (this.isContained(other, canonical) || this.isContained(canonical, other)) {
          throw new Error('Bound workspace overlaps a binding belonging to another tenant')
        }
      }
    }
    return canonical
  }

  private isAuthenticated(): boolean { return process.env.AUTH_ENABLED !== 'false' }

  private canonicalPrivateRoot(): string {
    return fs.existsSync(this.root) ? this.realpathIfExists(this.root) : path.resolve(this.root)
  }

  /** IDs are path components, never user supplied paths. Keep this strict on
   * every API entry so the private tenant/session root cannot be redirected. */
  private validateId(value: string | undefined, label: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 128 || value.trim() !== value ||
      value === '.' || value === '..' || value.includes('\0') || /[\\/]/.test(value) ||
      /[:*?"<>|]/.test(value) || /[\u0000-\u001f]/.test(value) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value)) {
      throw new Error(`${label} is not a valid identifier`)
    }
    return value
  }

  private assertContext(ctx: Pick<CtxLike, 'tenantId' | 'sessionId'>): void {
    this.validateId(ctx.tenantId, 'tenantId')
    this.validateId(ctx.sessionId, 'sessionId')
  }

  // getPath remains the private session directory: API deletion/upload callers rely on it.
  getPath(ctx: CtxLike): string {
    this.assertContext(ctx)
    return path.join(this.root, ctx.tenantId, ctx.sessionId)
  }

  getScratchDirectory(ctx: CtxLike): string {
    this.assertContext(ctx)
    return path.resolve(ctx.scratchDir ?? this.getPath(ctx))
  }

  getWorkingDirectory(ctx: CtxLike): string {
    this.assertContext(ctx)
    const bindings = this.readBindings()
    const bound = bindings.get(this.bindingKey(ctx))
    if (bound) return this.validateBoundDirectory(ctx, bound, bindings)
    // Authenticated requests must bind through the operator-checked endpoint;
    // request context paths are not an authorization mechanism.
    if (this.isAuthenticated()) {
      return this.getScratchDirectory(ctx)
    }
    return path.resolve(ctx.cwd ?? ctx.projectRoot ?? ctx.workspacePaths?.[0] ?? this.getScratchDirectory(ctx))
  }

  getPaths(ctx: CtxLike): string[] {
    this.assertContext(ctx)
    const paths = [this.getWorkingDirectory(ctx), this.getScratchDirectory(ctx)]
    if (!this.isAuthenticated()) {
      paths.push(...(ctx.projectRoot ? [path.resolve(ctx.projectRoot)] : []))
      paths.push(...(ctx.workspacePaths ?? []).map(p => path.resolve(p)))
    }
    return [...new Set(paths)]
  }

  /** Bind a session only inside operator-declared engine workspace roots. */
  bind(ctx: CtxLike, workspaceRoot: string): string {
    this.assertContext(ctx)
    const bindings = this.readBindings()
    if (!workspaceRoot.trim() || !path.isAbsolute(workspaceRoot)) throw new Error('workspaceRoot must be an absolute server path')
    const resolved = path.resolve(workspaceRoot)
    const allowed = this.allowedRoots.some(base => {
      const relative = path.relative(base, resolved)
      return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
    })
    if (!allowed) throw new Error('workspaceRoot is outside the engine allowed workspace roots')
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error('workspaceRoot must be an existing directory')
    const canonical = fs.realpathSync(resolved)
    const canonicalAllowed = this.allowedRoots.some(base => this.isContained(this.realpathIfExists(base), canonical))
    if (!canonicalAllowed) throw new Error('workspaceRoot resolves outside the engine allowed workspace roots')
    // A configured root is an operator allow-list, not a tenant sharing grant.
    // In authenticated deployments do not let one tenant bind another tenant's
    // project (including a nested directory). Desktop/no-auth mode retains the
    // existing single-user ability to select any operator-allowed project.
    if (this.isAuthenticated()) {
      // The engine's private root is partitioned as root/tenant/session. A
      // tenant must never bind another tenant's private scratch directory,
      // even before that directory has been explicitly bound.
      const privateRoot = this.canonicalPrivateRoot()
      const isPrivate = this.isContained(privateRoot, canonical)
      const privateParts = isPrivate ? path.relative(privateRoot, canonical).split(path.sep).filter(Boolean) : []
      // Only apply the tenant/session partition rule to paths inside the
      // engine's private root. Operator-allowed project roots may legitimately
      // live beside that private root and are protected by persisted ownership below.
      if (isPrivate && privateParts.length === 0) throw new Error('The private workspace root cannot be bound')
      if (isPrivate && privateParts.length > 0 && privateParts[0] !== ctx.tenantId) {
        throw new Error('workspaceRoot belongs to another tenant')
      }
      const owner = [...bindings.entries()].find(([key, owned]) =>
        key.split('\u0000')[0] !== ctx.tenantId && fs.existsSync(owned) && fs.statSync(owned).isDirectory() &&
        (this.isContained(fs.realpathSync(owned), canonical) || this.isContained(canonical, fs.realpathSync(owned))))
      if (owner) throw new Error('workspaceRoot is already bound to another tenant')
    }
    bindings.set(this.bindingKey(ctx), canonical)
    this.persistBindings(bindings)
    return canonical
  }

  private bindingKey(ctx: Pick<CtxLike, 'tenantId' | 'sessionId'>): string {
    return `${ctx.tenantId ?? 'default'}\u0000${ctx.sessionId ?? 'default'}`
  }


  init(ctx: CtxLike): string {
    const dir = this.getScratchDirectory(ctx)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  resolveSafePath(ctx: CtxLike, userPath: string): string {
    this.assertContext(ctx)
    if (typeof userPath !== 'string' || userPath.includes('\0')) throw new Error('Path is invalid')
    const scratch = this.getScratchDirectory(ctx)
    if (this.hasSymlinkComponent(this.root, scratch)) throw new Error('Workspace session root contains a symbolic link')
    const resolved = path.resolve(this.getWorkingDirectory(ctx), userPath)
    if (getSecurityMode(ctx.tenantId, ctx.sessionId) !== 'safe') return resolved
    // Normalize before testing containment so absolute paths with '..' cannot bypass it.
    const contained = this.getPaths(ctx).some(base => {
      const lexical = this.isContained(path.resolve(base), resolved)
      if (!lexical) return false
      // Check the actual target when it exists, otherwise check the nearest
      // existing parent. This catches junctions/symlinks while retaining the
      // documented caveat that a concurrent rename can still race this check.
      const actual = this.realpathIfExists(resolved)
      const actualBase = this.realpathIfExists(base)
      return this.isContained(actualBase, actual)
    })
    if (!contained) throw new Error(`Path "${userPath}" is outside any bound workspace`)
    return resolved
  }

  private isContained(base: string, target: string): boolean {
    const relative = path.relative(path.resolve(base), path.resolve(target))
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  }

  private realpathIfExists(target: string): string {
    let candidate = path.resolve(target)
    while (!fs.existsSync(candidate)) {
      const parent = path.dirname(candidate)
      if (parent === candidate) return candidate
      candidate = parent
    }
    try { return fs.realpathSync.native(candidate) } catch { return candidate }
  }

  private hasSymlinkComponent(base: string, target: string): boolean {
    const root = path.resolve(base)
    const absolute = path.resolve(target)
    if (!this.isContained(root, absolute)) return false
    let current = root
    for (const part of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
      current = path.join(current, part)
      try { if (fs.lstatSync(current).isSymbolicLink()) return true } catch { break }
    }
    return false
  }

  // P1 placeholder
  async snapshot(ctx: CtxLike): Promise<string> {
    throw new Error('Workspace snapshot not implemented yet (P1 feature)')
  }

  // P1 placeholder
  async restore(snapshotPath: string, ctx: CtxLike): Promise<void> {
    throw new Error('Workspace restore not implemented yet (P1 feature)')
  }
}

// Singleton instance
export const workspaceManager = new WorkspaceManager()

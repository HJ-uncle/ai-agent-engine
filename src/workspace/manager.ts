import path from 'node:path'
import fs from 'node:fs'
import type { AgentContext } from '../core/agent-context/index.js'
import { getSecurityMode } from '../security/policy-engine.js'

type CtxLike = Pick<AgentContext, 'tenantId' | 'sessionId' | 'workspacePaths' | 'cwd' | 'projectRoot' | 'scratchDir'>

export class WorkspaceManager {
  private readonly root: string
  private readonly bindings = new Map<string, string>()
  private readonly bindingOwners = new Map<string, string>()
  private readonly allowedRoots: string[]

  constructor(root?: string) {
    this.root = path.resolve(root ?? process.env.WORKSPACE_ROOT ?? './workspace')
    this.allowedRoots = [...new Set([
      this.root,
      ...(process.env.AETHER_ALLOWED_WORKSPACE_ROOTS ?? '').split(path.delimiter).filter(Boolean).map(value => path.resolve(value))
    ])]
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
    const bound = this.bindings.get(this.bindingKey(ctx))
    // Authenticated requests must bind through the operator-checked endpoint;
    // request context paths are not an authorization mechanism.
    if (process.env.AUTH_ENABLED === 'true') {
      if (bound && (!fs.existsSync(bound) || !fs.statSync(bound).isDirectory())) throw new Error('Bound workspace is no longer available')
      return path.resolve(bound ?? this.getScratchDirectory(ctx))
    }
    return path.resolve(bound ?? ctx.cwd ?? ctx.projectRoot ?? ctx.workspacePaths?.[0] ?? this.getScratchDirectory(ctx))
  }

  getPaths(ctx: CtxLike): string[] {
    this.assertContext(ctx)
    const paths = [this.getWorkingDirectory(ctx), this.getScratchDirectory(ctx)]
    if (process.env.AUTH_ENABLED !== 'true') {
      paths.push(...(ctx.projectRoot ? [path.resolve(ctx.projectRoot)] : []))
      paths.push(...(ctx.workspacePaths ?? []).map(p => path.resolve(p)))
    }
    return [...new Set(paths)]
  }

  /** Bind a session only inside operator-declared engine workspace roots. */
  bind(ctx: CtxLike, workspaceRoot: string): string {
    this.assertContext(ctx)
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
    if (process.env.AUTH_ENABLED !== 'false') {
      // The engine's private root is partitioned as root/tenant/session. A
      // tenant must never bind another tenant's private scratch directory,
      // even before that directory has been explicitly bound.
      const privateRelative = path.relative(path.resolve(this.root), canonical)
      const privateParts = privateRelative.split(path.sep).filter(Boolean)
      // Only apply the tenant/session partition rule to paths inside the
      // engine's private root. Operator-allowed project roots may legitimately
      // live beside that private root and are protected by bindingOwners below.
      if (this.isContained(path.resolve(this.root), canonical) && privateParts.length > 0 && privateParts[0] !== ctx.tenantId) {
        throw new Error('workspaceRoot belongs to another tenant')
      }
      const owner = [...this.bindingOwners.entries()].find(([owned, ownerTenant]) =>
        ownerTenant !== ctx.tenantId && (this.isContained(owned, canonical) || this.isContained(canonical, owned)))
      if (owner) throw new Error('workspaceRoot is already bound to another tenant')
    }
    this.bindings.set(this.bindingKey(ctx), canonical)
    this.bindingOwners.set(canonical, ctx.tenantId)
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

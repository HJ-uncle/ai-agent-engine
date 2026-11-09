import path from 'node:path'
import fs from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { acquireResourceLease, acquireResourceLeaseAsync } from './binding-lease.js'
import { recoverGitBindingLease } from './binding-git-recovery.js'
import type { AgentContext } from '../core/agent-context/index.js'
import { getSecurityMode } from '../security/policy-engine.js'
import { canonicalFilePathSync } from '../shared/file-version.js'
import { serviceForOwner, type ExecutionOwner } from '../core/collaboration/execution-owner.js'

/** Reject traversal hidden behind an HTTP client's percent-encoding pass. */
function hasEncodedPathTraversal(value: string): boolean {
  let current = value
  for (let depth = 0; depth < 8; depth += 1) {
    if (current.includes('\u0000')) return true
    // Keep ordinary names such as `100%done.txt` valid. Once a real escape is
    // present, malformed escapes are rejected instead of reaching a parser
    // with a different decoding policy.
    if (!/%[0-9a-f]{2}/i.test(current)) return false
    let decoded: string
    try { decoded = decodeURIComponent(current) } catch { return true }
    if (decoded === current) return false
    current = decoded
    if (current.includes('\u0000') || current.replace(/\\/g, '/').split('/').some(segment => segment === '..')) return true
  }
  return true
}

type CtxLike = Pick<AgentContext, 'tenantId' | 'sessionId' | 'workspacePaths' | 'cwd' | 'projectRoot' | 'scratchDir'>
  & Pick<Partial<AgentContext>, 'executionOwner' | 'runId' | 'rootRunId' | 'turnId' | 'parentSessionId'>
interface ChildWorkspaceScope {
  parent: CtxLike
  snapshot: Readonly<WorkspaceBindingSnapshot>
  roots: readonly string[]
  scratch: string
}
type Bindings = Map<string, string> & { epochs: Map<string, string> }
export interface WorkspaceBindingSnapshot { root: string; epoch: string }
export interface WorkspaceBindingGuard { snapshot: Readonly<WorkspaceBindingSnapshot>; assertCurrent(): void }
export interface WorkspaceBindingLease extends WorkspaceBindingGuard { resource:{file:string;generation:string;pid:number} }

export class WorkspaceManager {
  private readonly root: string
  private readonly allowedRoots: string[]
  private readonly childScopes = new WeakMap<ExecutionOwner, ChildWorkspaceScope>()

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

  private readBindings(): Bindings {
    const file = this.bindingsFile()
    const bindings: Bindings = Object.assign(new Map<string, string>(), { epochs: new Map<string, string>() })
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
      if (item.epoch !== undefined && (typeof item.epoch !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.epoch))) {
        throw new Error('Workspace binding state contains an invalid epoch')
      }
      bindings.epochs.set(key, item.epoch ?? `legacy:${createHash('sha256').update(key + '\0' + path.resolve(item.workspaceRoot)).digest('hex')}`)
    }
    return bindings
  }

  private persistBindings(state: Bindings): void {
    const file = this.bindingsFile()
    try {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Workspace binding state must not be a symbolic link')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const bindings = [...state.entries()].map(([key, workspaceRoot]) => {
      const separator = key.indexOf('\u0000')
      const epoch = state.epochs.get(key)
      return { tenantId: key.slice(0, separator), sessionId: key.slice(separator + 1), workspaceRoot,
        ...(epoch && !epoch.startsWith('legacy:') ? { epoch } : {}) }
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
    const actual = canonicalFilePathSync(bound)
    // A desktop-owned, no-auth engine may bind an operator-selected local
    // project outside its private scratch root.  `bindSnapshot` already uses
    // the same exception when accepting the selection; applying it here keeps
    // persisted bindings valid after restart instead of rejecting the exact
    // project that was just selected.
    const allowDesktopSelection = process.env.AETHER_DESKTOP_OWNED === '1' && !this.isAuthenticated()
    if (!allowDesktopSelection && !this.allowedRoots.some(base => this.isContained(canonicalFilePathSync(base), actual))) {
      throw new Error('Bound workspace is outside the engine allowed workspace roots')
    }
    if (this.isAuthenticated()) {
      const privateRoot = this.canonicalPrivateRoot()
      const tenant = this.isContained(privateRoot, actual)
        ? path.relative(privateRoot, actual).split(path.sep).filter(Boolean)[0]
        : undefined
      if (tenant && tenant !== ctx.tenantId) throw new Error('Bound workspace belongs to another tenant')
      if (this.isContained(privateRoot, actual) && !tenant) throw new Error('The private workspace root cannot be bound')
    }
    if (this.isAuthenticated()) {
      for (const [key, owned] of bindings) {
        if (key.split('\u0000')[0] === ctx.tenantId) continue
        if (!fs.existsSync(owned) || !fs.statSync(owned).isDirectory()) continue
        const other = canonicalFilePathSync(owned)
        if (this.isContained(other, actual) || this.isContained(actual, other)) {
          throw new Error('Bound workspace overlaps a binding belonging to another tenant')
        }
      }
    }
    return canonical
  }

  private isAuthenticated(): boolean { return process.env.AUTH_ENABLED !== 'false' }

  private canonicalPrivateRoot(): string {
    return canonicalFilePathSync(this.root)
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
    const child = this.childScope(ctx)
    if (child) return child.scratch
    return path.resolve(ctx.scratchDir ?? this.getPath(ctx))
  }

  /** Called by trusted child construction, never by an HTTP/model supplied context. */
  inheritChildWorkspace(child: AgentContext, parent: AgentContext, frozenRoots: readonly string[]): void {
    if (!child.executionOwner || !parent.executionOwner) throw new Error('Workspace inheritance requires live parent and child owners')
    const service = serviceForOwner(child.executionOwner)
    if (service !== serviceForOwner(parent.executionOwner)) throw new Error('Workspace inheritance owner mismatch')
    service.assertDispatch(child.executionOwner)
    const b = service.collaboration.executionBinding(service.producerForExecution(child.executionOwner))
    const p = service.record(parent.executionOwner).binding
    if (b.kind !== 'child' || p.kind !== 'root' || b.tenantId !== child.tenantId || b.sessionId !== child.sessionId
      || b.invocationRunId !== child.runId || b.rootRunId !== p.rootRunId || b.rootAttemptId !== p.rootAttemptId
      || b.rootSessionId !== parent.sessionId || p.sessionId !== parent.sessionId || p.tenantId !== parent.tenantId
      || child.parentSessionId !== parent.sessionId) throw new Error('Workspace inheritance owner mismatch')
    const parentContext: CtxLike = { tenantId: parent.tenantId, sessionId: parent.sessionId,
      workspacePaths: parent.workspacePaths ? [...parent.workspacePaths] : undefined,
      projectRoot: parent.projectRoot, cwd: parent.cwd, scratchDir: parent.scratchDir }
    const snapshot = this.getBindingSnapshot(parentContext)
    const parentRoots = this.getPaths(parentContext).map(root => canonicalFilePathSync(root))
    const roots = [...new Set(frozenRoots.map(root => canonicalFilePathSync(root)))].filter(root =>
      parentRoots.some(allowed => this.isContained(allowed, root)))
    if (!roots.some(root => this.isContained(root, canonicalFilePathSync(snapshot.root)))) throw new Error('Child workspace is outside the current parent binding')
    const scratch = path.resolve(child.scratchDir ?? this.getPath(child))
    this.childScopes.set(child.executionOwner, { parent: parentContext, snapshot, roots, scratch })
  }

  private childScope(ctx: CtxLike): ChildWorkspaceScope | undefined {
    const scope = ctx.executionOwner ? this.childScopes.get(ctx.executionOwner) : undefined
    if (!scope || !ctx.executionOwner) return undefined
    const service = serviceForOwner(ctx.executionOwner)
    service.assertDispatch(ctx.executionOwner)
    const binding = service.collaboration.executionBinding(service.producerForExecution(ctx.executionOwner))
    if (binding.kind !== 'child' || binding.tenantId !== ctx.tenantId || binding.sessionId !== ctx.sessionId
      || binding.invocationRunId !== ctx.runId || binding.rootRunId !== ctx.rootRunId || binding.turnId !== ctx.turnId
      || binding.rootSessionId !== ctx.parentSessionId) throw new Error('Child workspace owner mismatch')
    const current = this.getBindingSnapshot(scope.parent)
    if (current.root !== scope.snapshot.root || current.epoch !== scope.snapshot.epoch) throw new Error('Parent workspace binding changed during child execution')
    return scope
  }

  getWorkingDirectory(ctx: CtxLike): string {
    return this.getBindingSnapshot(ctx).root
  }

  getBindingSnapshot(ctx: CtxLike): Readonly<WorkspaceBindingSnapshot> {
    this.assertContext(ctx)
    const child = this.childScope(ctx)
    if (child) return child.snapshot
    const bindings = this.readBindings()
    const bound = bindings.get(this.bindingKey(ctx))
    if (bound) return Object.freeze({ root: this.validateBoundDirectory(ctx, bound, bindings), epoch: bindings.epochs.get(this.bindingKey(ctx))! })
    // Authenticated requests must bind through the operator-checked endpoint;
    // request context paths are not an authorization mechanism.
    if (this.isAuthenticated()) {
      const root = this.getScratchDirectory(ctx)
      return Object.freeze({ root, epoch: `scratch:${createHash('sha256').update(this.bindingKey(ctx) + '\0' + root).digest('hex')}` })
    }
    const root = path.resolve(ctx.cwd ?? ctx.projectRoot ?? ctx.workspacePaths?.[0] ?? this.getScratchDirectory(ctx))
    return Object.freeze({ root, epoch: `unbound:${createHash('sha256').update(this.bindingKey(ctx) + '\0' + root).digest('hex')}` })
  }

  private sessionLeaseFile(ctx: Pick<CtxLike, 'tenantId' | 'sessionId'>): string {
    const child = this.childScope(ctx as CtxLike)
    return `${this.bindingsFile()}.session-${createHash('sha256').update(this.bindingKey(child?.parent ?? ctx)).digest('hex')}.lock`
  }

  /** Read-only listing and preview capture the same binding before and after
   * their async I/O. They must not wait for a long Git scan of the same session;
   * a concurrent rebind still invalidates the response instead of mixing roots. */
  bindingReadGuard(ctx: CtxLike, expected?: WorkspaceBindingSnapshot): WorkspaceBindingGuard {
    const snapshot = this.getBindingSnapshot(ctx)
    if (expected && (expected.root !== snapshot.root || expected.epoch !== snapshot.epoch)) throw new Error('Workspace binding changed; refresh the task target before retrying')
    return {
      snapshot,
      assertCurrent: () => {
        const next = this.getBindingSnapshot(ctx)
        if (snapshot.root !== next.root || snapshot.epoch !== next.epoch) throw new Error('Workspace binding changed during read; operation rejected')
      }
    }
  }

  /** Use an already captured binding for a read-only path lookup. This avoids
   * repeatedly synchronously parsing workspace-bindings.json for one request. */
  resolveSafePathForSnapshot(ctx: CtxLike, snapshot: Readonly<WorkspaceBindingSnapshot>, userPath: string): string {
    this.assertContext(ctx)
    if (typeof userPath !== 'string' || userPath.includes('\0') || hasEncodedPathTraversal(userPath)) throw new Error('Path is invalid')
    const scratch = this.getScratchDirectory(ctx)
    if (this.hasSymlinkComponent(this.root, scratch)) throw new Error('Workspace session root contains a symbolic link')
    const resolved = path.resolve(snapshot.root, userPath)
    const child = this.childScope(ctx)
    if (child && (snapshot.root !== child.snapshot.root || snapshot.epoch !== child.snapshot.epoch)) throw new Error('Child workspace snapshot mismatch')
    if (!child && getSecurityMode(ctx.tenantId, ctx.sessionId) !== 'safe') return resolved
    const actual = canonicalFilePathSync(resolved)
    const allowed = child ? [...child.roots, scratch] : [snapshot.root, scratch]
    if (!child && !this.isAuthenticated()) {
      if (ctx.projectRoot) allowed.push(path.resolve(ctx.projectRoot))
      allowed.push(...(ctx.workspacePaths ?? []).map(value => path.resolve(value)))
    }
    const contained = [...new Set(allowed)].some(base => {
      const actualBase = canonicalFilePathSync(base)
      return this.hasAllowedPathSpelling(base, resolved, actualBase, actual) && this.isContained(actualBase, actual)
    })
    if (!contained) throw new Error(`Path "${userPath}" is outside any bound workspace`)
    return resolved
  }

  /** Hold the selection through asynchronous side effects. CAS also guards
   * every actual dispatch against direct external state edits while awaiting. */
  async withBindingLease<T>(ctx: CtxLike, expected: WorkspaceBindingSnapshot | undefined, action: (lease: WorkspaceBindingLease) => Promise<T>, waitMs = 0): Promise<T> {
    this.assertContext(ctx)
    if (fs.existsSync(this.sessionLeaseFile(ctx)) || fs.existsSync(this.sessionLeaseFile(ctx) + '.recovery.lock')) {
      const current = this.getBindingSnapshot(ctx)
      await recoverGitBindingLease(this.sessionLeaseFile(ctx), current.root, { tenantId: ctx.tenantId!, sessionId: ctx.sessionId! })
    }
    const held = await acquireResourceLeaseAsync(this.sessionLeaseFile(ctx), 'workspace session', { tenantId: ctx.tenantId!, sessionId: ctx.sessionId! }, waitMs)
    try {
      const snapshot = this.getBindingSnapshot(ctx)
      if (expected && (expected.root !== snapshot.root || expected.epoch !== snapshot.epoch)) throw new Error('Workspace binding changed; refresh the task target before retrying')
      const assertCurrent = () => {
        held.assertOwned()
        const next = this.getBindingSnapshot(ctx)
        if (snapshot.root !== next.root || snapshot.epoch !== next.epoch) throw new Error('Workspace binding changed before dispatch; operation rejected')
      }
      assertCurrent()
      return await action({ snapshot, assertCurrent, resource:{file:this.sessionLeaseFile(ctx),generation:held.owner.generation,pid:held.owner.pid} })
    } finally { held.release() }
  }

  /** Git recovery may release only the exact interrupted selection lease that
   * its native-audited repository owner recorded before any child dispatch.
   *
   * A repository lock can outlive an engine process or be recovered by a
   * different session that happens to share the same physical repository.
   * In those cases the binding receipt is useful evidence, but it is not a
   * release certificate for this session.  Keep the external/stale binding
   * lease in place and let its owner (or a later explicit recovery) handle it.
   */
  recoverInterruptedGitBinding(ctx: CtxLike, expected: WorkspaceBindingSnapshot, resource:{file:string;generation:string;pid:number;root:string;epoch:string}, originalPid:number): boolean {
    this.assertContext(ctx)
    const file=this.sessionLeaseFile(ctx),snapshot=this.getBindingSnapshot(ctx)
    if(fs.existsSync(file+'.recovery.lock')) return false
    const samePath=(left:string,right:string):boolean=>{
      if(!path.isAbsolute(left) || !path.isAbsolute(right)) return false
      const a=path.resolve(left),b=path.resolve(right)
      return process.platform==='win32' ? a.toLowerCase()===b.toLowerCase() : a===b
    }
    // A mismatch identifies a stale lease from another session, an older
    // binding selection, or a newer engine owner.  It is safe to retain it,
    // but unsafe to remove it just because the repository lease was verified.
    if(!samePath(resource.file,file) || resource.pid!==originalPid || resource.root!==expected.root || resource.epoch!==expected.epoch || snapshot.root!==expected.root || snapshot.epoch!==expected.epoch) return false
    let held: {pid?:number;generation?:string}
    try {
      const stat=fs.lstatSync(file)
      if(stat.isSymbolicLink() || stat.size>16*1024) return false
      held=JSON.parse(fs.readFileSync(file,'utf8')) as typeof held
    } catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT') return false
      // The file is not ours to repair when its metadata cannot be trusted.
      // Keep it for explicit operator investigation instead of blocking the
      // verified repository recovery with a second error.
      return false
    }
    if(held.pid!==resource.pid || held.generation!==resource.generation) return false
    try {
      if(fs.existsSync(file+'.recovery.lock')) return false
      fs.renameSync(file,`${file}.recovered-${resource.generation}.json`)
      return true
    } catch(error) {
      if((error as NodeJS.ErrnoException).code==='ENOENT') return false
      throw error
    }
  }

  /** Automation follows an explicit project selection; scratch is not a selected project. */
  getBoundDirectory(ctx: Pick<CtxLike, 'tenantId' | 'sessionId'>): string | null {
    this.assertContext(ctx)
    const bindings = this.readBindings()
    const bound = bindings.get(this.bindingKey(ctx))
    return bound ? this.validateBoundDirectory(ctx, bound, bindings) : null
  }

  getPaths(ctx: CtxLike): string[] {
    this.assertContext(ctx)
    const child = this.childScope(ctx)
    // Frozen permission roots may come from legacy continuations in arbitrary
    // order. The relative-path base is always the inherited binding, never the
    // first output/scratch directory mentioned in that permission list.
    if (child) return [...new Set([child.snapshot.root, ...child.roots, child.scratch])]
    const paths = [this.getWorkingDirectory(ctx), this.getScratchDirectory(ctx)]
    if (!this.isAuthenticated()) {
      paths.push(...(ctx.projectRoot ? [path.resolve(ctx.projectRoot)] : []))
      paths.push(...(ctx.workspacePaths ?? []).map(p => path.resolve(p)))
    }
    return [...new Set(paths)]
  }

  /**
   * Bind a session to an explicitly selected project.
   *
   * The embedded desktop engine is a single-user, instance-token protected
   * process.  In that mode the directory picker is the operator grant, so a
   * project selected in Aether Code/Work must not be rejected merely because
   * it lives outside the engine's private scratch directory.  Remote and
   * authenticated engines continue to require their declared allow-list.
   */
  bind(ctx: CtxLike, workspaceRoot: string): string {
    return this.bindSnapshot(ctx, workspaceRoot).root
  }

  bindSnapshot(ctx: CtxLike, workspaceRoot: string): Readonly<WorkspaceBindingSnapshot> {
    this.assertContext(ctx)
    const session = acquireResourceLease(this.sessionLeaseFile(ctx), 'workspace session', { tenantId: ctx.tenantId!, sessionId: ctx.sessionId! })
    try {
      const state = acquireResourceLease(`${this.bindingsFile()}.write.lock`, 'workspace binding state')
      try {
        const bindings = this.readBindings()
        const allowDesktopSelection = process.env.AETHER_DESKTOP_OWNED === '1' && !this.isAuthenticated()
        const canonical = this.validateSelectedDirectory(
          ctx.tenantId,
          workspaceRoot,
          bindings,
          !allowDesktopSelection
        )
        bindings.set(this.bindingKey(ctx), canonical)
        const epoch = randomUUID()
        bindings.epochs.set(this.bindingKey(ctx), epoch)
        this.persistBindings(bindings)
        return Object.freeze({ root: canonical, epoch })
      } finally { state.release() }
    } finally { session.release() }
  }

  /**
   * Bind a session while queuing behind an in-flight bind for the same
   * session. Work mode can mount the workspace and Git panels together; both
   * issue the bind request during their first render. The synchronous API
   * intentionally keeps its fail-fast behaviour for callers that already
   * own the lifecycle lock, while HTTP callers use this variant so a
   * duplicate request waits for the first one to finish.
   */
  async bindSnapshotAsync(ctx: CtxLike, workspaceRoot: string, waitMs = 30_000): Promise<Readonly<WorkspaceBindingSnapshot>> {
    this.assertContext(ctx)
    if (fs.existsSync(this.sessionLeaseFile(ctx)) || fs.existsSync(this.sessionLeaseFile(ctx) + '.recovery.lock')) {
      const allowDesktopSelection = process.env.AETHER_DESKTOP_OWNED === '1' && !this.isAuthenticated()
      const selected = this.validateSelectedDirectory(ctx.tenantId, workspaceRoot, this.readBindings(), !allowDesktopSelection)
      await recoverGitBindingLease(this.sessionLeaseFile(ctx), selected, { tenantId: ctx.tenantId!, sessionId: ctx.sessionId! })
    }
    const session = await acquireResourceLeaseAsync(
      this.sessionLeaseFile(ctx),
      'workspace session',
      { tenantId: ctx.tenantId!, sessionId: ctx.sessionId! },
      waitMs
    )
    try {
      const state = await acquireResourceLeaseAsync(`${this.bindingsFile()}.write.lock`, 'workspace binding state', undefined, waitMs)
      try {
        const bindings = this.readBindings()
        const allowDesktopSelection = process.env.AETHER_DESKTOP_OWNED === '1' && !this.isAuthenticated()
        const canonical = this.validateSelectedDirectory(
          ctx.tenantId,
          workspaceRoot,
          bindings,
          !allowDesktopSelection
        )
        bindings.set(this.bindingKey(ctx), canonical)
        const epoch = randomUUID()
        bindings.epochs.set(this.bindingKey(ctx), epoch)
        this.persistBindings(bindings)
        return Object.freeze({ root: canonical, epoch })
      } finally { state.release() }
    } finally { session.release() }
  }

  /** Catalogue discovery checks the same directory boundary as binding, without
   * changing any session selection. Single-user desktop contexts already allow
   * explicit local projects; authenticated engines require the operator roots. */
  resolveProjectDirectory(tenantId: string, workspaceRoot: string): string {
    this.validateId(tenantId, 'tenantId')
    const authenticated = this.isAuthenticated()
    return this.validateSelectedDirectory(tenantId, workspaceRoot, authenticated ? this.readBindings() : new Map(), authenticated)
  }

  private validateSelectedDirectory(tenantId: string, workspaceRoot: string, bindings: Map<string, string>, restrictToAllowedRoots = true): string {
    if (typeof workspaceRoot !== 'string' || workspaceRoot.length > 4096 || /[\u0000-\u001f\u007f]/.test(workspaceRoot)) throw new Error('workspaceRoot must be a valid server path')
    if (!workspaceRoot.trim() || !path.isAbsolute(workspaceRoot)) throw new Error('workspaceRoot must be an absolute server path')
    const resolved = path.resolve(workspaceRoot)
    const actual = canonicalFilePathSync(resolved)
    const allowed = this.allowedRoots.some(base => this.hasAllowedPathSpelling(base, resolved, canonicalFilePathSync(base), actual))
    if (restrictToAllowedRoots && !allowed) throw new Error('workspaceRoot is outside the engine allowed workspace roots')
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error('workspaceRoot must be an existing directory')
    const canonical = fs.realpathSync(resolved)
    const canonicalAllowed = this.allowedRoots.some(base => this.isContained(canonicalFilePathSync(base), actual))
    if (restrictToAllowedRoots && !canonicalAllowed) throw new Error('workspaceRoot resolves outside the engine allowed workspace roots')
    // A configured root is an operator allow-list, not a tenant sharing grant.
    // In authenticated deployments do not let one tenant bind another tenant's
    // project (including a nested directory). Desktop/no-auth mode retains the
    // existing single-user ability to select any operator-allowed project.
    if (this.isAuthenticated()) {
      // The engine's private root is partitioned as root/tenant/session. A
      // tenant must never bind another tenant's private scratch directory,
      // even before that directory has been explicitly bound.
      const privateRoot = this.canonicalPrivateRoot()
      const isPrivate = this.isContained(privateRoot, actual)
      const privateParts = isPrivate ? path.relative(privateRoot, actual).split(path.sep).filter(Boolean) : []
      // Only apply the tenant/session partition rule to paths inside the
      // engine's private root. Operator-allowed project roots may legitimately
      // live beside that private root and are protected by persisted ownership below.
      if (isPrivate && privateParts.length === 0) throw new Error('The private workspace root cannot be bound')
      if (isPrivate && privateParts.length > 0 && privateParts[0] !== tenantId) {
        throw new Error('workspaceRoot belongs to another tenant')
      }
      const owner = [...bindings.entries()].find(([key, owned]) =>
        key.split('\u0000')[0] !== tenantId && fs.existsSync(owned) && fs.statSync(owned).isDirectory() &&
        (this.isContained(canonicalFilePathSync(owned), actual) || this.isContained(actual, canonicalFilePathSync(owned))))
      if (owner) throw new Error('workspaceRoot is already bound to another tenant')
    }
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
    return this.resolveSafePathForSnapshot(ctx, this.getBindingSnapshot(ctx), userPath)
  }

  private isContained(base: string, target: string): boolean {
    const relative = path.relative(path.resolve(base), path.resolve(target))
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  }

  private hasAllowedPathSpelling(base: string, target: string, actualBase: string, actual: string): boolean {
    if (this.isContained(base, target) || this.isContained(actualBase, target)) return true
    // An external link pointing inward is not an 8.3 alias. Returning that
    // spelling could let an unlink/rename act on the external directory entry.
    // Alias fallback therefore requires both real containment and a link-free
    // path. Callers still check real containment for lexically accepted paths.
    return this.isContained(actualBase, actual) && !this.hasSymlinkComponent(path.parse(target).root, target)
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

import path from 'node:path'
import fs from 'node:fs'
import type { AgentContext } from '../core/agent-context/index.js'
import { getSecurityMode } from '../security/policy-engine.js'

type CtxLike = Pick<AgentContext, 'tenantId' | 'sessionId' | 'workspacePaths' | 'cwd' | 'projectRoot' | 'scratchDir'>

export class WorkspaceManager {
  private readonly root: string

  constructor(root?: string) {
    this.root = path.resolve(root ?? process.env.WORKSPACE_ROOT ?? './workspace')
  }

  // getPath remains the private session directory: API deletion/upload callers rely on it.
  getPath(ctx: CtxLike): string {
    return path.join(this.root, ctx.tenantId, ctx.sessionId)
  }

  getScratchDirectory(ctx: CtxLike): string {
    return path.resolve(ctx.scratchDir ?? this.getPath(ctx))
  }

  getWorkingDirectory(ctx: CtxLike): string {
    return path.resolve(ctx.cwd ?? ctx.projectRoot ?? ctx.workspacePaths?.[0] ?? this.getScratchDirectory(ctx))
  }

  getPaths(ctx: CtxLike): string[] {
    return [...new Set([
      this.getWorkingDirectory(ctx),
      ...(ctx.projectRoot ? [path.resolve(ctx.projectRoot)] : []),
      ...(ctx.workspacePaths ?? []).map(p => path.resolve(p)),
      this.getScratchDirectory(ctx),
    ])]
  }

  init(ctx: CtxLike): string {
    const dir = this.getScratchDirectory(ctx)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  resolveSafePath(ctx: CtxLike, userPath: string): string {
    const resolved = path.resolve(this.getWorkingDirectory(ctx), userPath)
    if (getSecurityMode(ctx.tenantId, ctx.sessionId) !== 'safe') return resolved
    // Normalize before testing containment so absolute paths with '..' cannot bypass it.
    const contained = this.getPaths(ctx).some(base => {
      const relative = path.relative(base, resolved)
      return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
    })
    if (!contained) throw new Error(`Path "${userPath}" is outside any bound workspace`)
    return resolved
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

import path from 'node:path'
import fs from 'node:fs'
import type { AgentContext } from '../core/agent-context/index.js'

type CtxLike = Pick<AgentContext, 'tenantId' | 'sessionId'>

export class WorkspaceManager {
  private readonly root: string

  constructor(root?: string) {
    this.root = path.resolve(root ?? process.env.WORKSPACE_ROOT ?? './workspace')
  }

  getPath(ctx: CtxLike): string {
    return path.join(this.root, ctx.tenantId, ctx.sessionId)
  }

  init(ctx: CtxLike): string {
    const dir = this.getPath(ctx)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  // Resolve a user-provided path safely within the workspace
  resolveSafePath(ctx: CtxLike, userPath: string): string {
    const base = this.getPath(ctx)
    const resolved = path.resolve(base, userPath)
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      throw new Error(`Path traversal detected: "${userPath}" resolves outside workspace`)
    }
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

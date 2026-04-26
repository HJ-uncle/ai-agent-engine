import path from 'node:path'
import fs from 'node:fs'
import type { AgentContext } from '../core/agent-context/index.js'

type CtxLike = Pick<AgentContext, 'tenantId' | 'sessionId' | 'workspacePaths'>

export class WorkspaceManager {
  private readonly root: string

  constructor(root?: string) {
    this.root = path.resolve(root ?? process.env.WORKSPACE_ROOT ?? './workspace')
  }

  // 获取会话绑定的所有工作区路径（包括默认路径和自定义路径）
  getPaths(ctx: CtxLike): string[] {
    const defaultPath = path.join(this.root, ctx.tenantId, ctx.sessionId)
    const customPaths = ctx.workspacePaths || []
    return [defaultPath, ...customPaths]
  }

  getPath(ctx: CtxLike): string {
    return this.getPaths(ctx)[0]
  }

  init(ctx: CtxLike): string {
    const dir = this.getPath(ctx)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  // Resolve a user-provided path safely within any of the bound workspaces
  resolveSafePath(ctx: CtxLike, userPath: string): string {
    const bases = this.getPaths(ctx)
    
    // 如果是绝对路径，检查是否在任何一个 base 中
    if (path.isAbsolute(userPath)) {
      for (const base of bases) {
        if (userPath.startsWith(base + path.sep) || userPath === base) {
          return userPath
        }
      }
      throw new Error(`Path "${userPath}" is outside any bound workspace`)
    }

    // 如果是相对路径，默认尝试在第一个 (primary) workspace 中解析
    // 或者，如果文件已存在于某个 workspace，则返回那个路径
    for (const base of bases) {
      const resolved = path.resolve(base, userPath)
      if ((resolved.startsWith(base + path.sep) || resolved === base) && fs.existsSync(resolved)) {
        return resolved
      }
    }

    // 如果都不存在，则默认解析到第一个 workspace
    const primaryBase = bases[0]
    const resolved = path.resolve(primaryBase, userPath)
    if (!resolved.startsWith(primaryBase + path.sep) && resolved !== primaryBase) {
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

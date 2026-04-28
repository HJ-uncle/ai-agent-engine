/**
 * Glob 工具 — 文件模式匹配搜索
 * 在工作区中用 glob 模式匹配文件路径
 */
import { glob } from 'glob'
import path from 'node:path'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { workspaceManager } from '../../workspace/index.js'

export const globTool: Tool = {
  name: 'glob_search',
  displayName: 'Glob 文件搜索',
  description: 'Glob 模式搜索文件路径，如 **/*.ts',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      cwd: { type: 'string' },
      limit: { type: 'number' },
    },
    required: ['pattern'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { pattern, cwd = '.', limit = 100 } = rawArgs as { pattern: string; cwd?: string; limit?: number }
    try {
      const basePath = workspaceManager.resolveSafePath(ctx, cwd)
      const matches = await glob(pattern, {
        cwd: basePath,
        nodir: false,
        dot: false,
        absolute: false,
        maxDepth: 10,
      })
      const results = matches.slice(0, limit)
      if (results.length === 0) {
        return { success: true, output: `No files matched pattern "${pattern}"` }
      }
      return {
        success: true,
        output: `Found ${results.length} file(s):\n${results.join('\n')}`,
      }
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : 'Unknown error' }
    }
  },
}

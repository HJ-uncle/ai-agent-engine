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
  description: '用 glob 模式在工作区中搜索匹配的文件路径。支持 *, **, ? 等通配符。例如：**/*.ts 匹配所有 TypeScript 文件。',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob 匹配模式，如 "**/*.json"、"src/**/*.ts"',
      },
      cwd: {
        type: 'string',
        description: '搜索基准目录（相对工作区根目录，默认为根目录）',
        default: '.',
      },
      limit: {
        type: 'number',
        description: '最多返回结果数量，默认 100',
        default: 100,
      },
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

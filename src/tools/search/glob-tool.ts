/**
 * Glob 工具 — 文件模式匹配搜索
 * 在工作区中用 glob 模式匹配文件路径
 */
import { globIterate } from 'glob'
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
      offset: { type: 'number', description: '跳过前 offset 个结果，用于继续分页' },
    },
    required: ['pattern'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { pattern, cwd = '.', limit = 100, offset = 0 } = rawArgs as { pattern: string; cwd?: string; limit?: number; offset?: number }
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset) || offset < 0) {
      return { success: false, output: 'glob_search: limit 必须为正整数，offset 必须为非负整数。' }
    }
    try {
      const basePath = workspaceManager.resolveSafePath(ctx, cwd)
      const matches: string[] = []
      const needed = offset + limit + 1
      for await (const match of globIterate(pattern, {
        cwd: basePath,
        nodir: false,
        dot: false,
        absolute: false,
      })) {
        matches.push(match)
        if (matches.length >= needed) break
      }
      const results = matches.slice(offset, offset + limit)
      const hasMore = matches.length > offset + limit
      if (results.length === 0) {
        return { success: true, output: `No files matched pattern "${pattern}"` }
      }
      return {
        success: true,
        output: `Found ${results.length} file(s)${hasMore ? ` (more available; use offset=${offset + limit} to continue)` : ''}:\n${results.join('\n')}`,
        metadata: { count: results.length, offset, limit, hasMore, nextOffset: hasMore ? offset + limit : undefined },
      }
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : 'Unknown error' }
    }
  },
}

/**
 * Glob 工具 — 文件模式匹配搜索
 * 在工作区中用 glob 模式匹配文件路径
 */
import { globIterate } from 'glob'
import { performance } from 'node:perf_hooks'
import path from 'node:path'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { workspaceManager } from '../../workspace/index.js'
import { getToolOutputLimit } from '../../core/agent-loop/tool-output-limit.js'
import { throwIfAborted } from '../../core/utils/abort.js'

const SCAN_TIMEOUT_MS = 2000
const COUNT_SCAN_LIMIT = 100_000

export const globTool: Tool = {
  name: 'glob',
  displayName: 'Glob 文件搜索',
  description: 'Glob 模式搜索文件路径，如 **/*.ts。只统计项目规模时用 countOnly=true，避免输出大量文件名；读取列表按输出预算分页，继续时必须使用返回的 nextOffset，而非自行按 limit 累加。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      cwd: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 2000, description: '每页最多条数，默认100；实际页可能因输出预算更小' },
      offset: { type: 'integer', minimum: 0, maximum: 100000, description: '使用上一页返回的 nextOffset；文件系统变化后应从0重新查询' },
      countOnly: { type: 'boolean', description: '仅返回匹配数量，不返回路径；扫描超时或达到100000项时明确返回数量下限，不能当精确总数。不可与非零offset合用。' },
    },
    required: ['pattern'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
      return { success: false, output: 'glob: 请提供 pattern 和可选分页参数。' }
    }
    const { pattern, cwd = '.', limit = 100, offset = 0, countOnly = false } = rawArgs as { pattern: string; cwd?: string; limit?: number; offset?: number; countOnly?: boolean }
    if (typeof pattern !== 'string' || !pattern.trim() || typeof cwd !== 'string' || typeof countOnly !== 'boolean'
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000
      || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || countOnly && offset !== 0) {
      return { success: false, output: 'glob: pattern 必须非空；limit 为1至2000的整数；offset 为0至100000的整数；countOnly 需为布尔值且不接受非零offset。' }
    }
    try {
      throwIfAborted(ctx.signal)
      const basePath = workspaceManager.resolveSafePath(ctx, cwd)
      const results: string[] = []
      const started = performance.now()
      const outputLimit = getToolOutputLimit(ctx.toolProfile, ctx)
      // Reserve the continuation receipt before adding paths so ReAct never
      // truncates away the only cursor that can read the remainder.
      const headerReserve = 180
      let scanned = 0, characters = 0, hasMore = false
      let incompleteReason: 'time' | 'scan-limit' | undefined
      for await (const match of globIterate(pattern, {
        cwd: basePath,
        nodir: false,
        dot: false,
        absolute: false,
      })) {
        throwIfAborted(ctx.signal)
        if (performance.now() - started > SCAN_TIMEOUT_MS) { incompleteReason = 'time'; hasMore = true; break }
        // cwd alone is insufficient: a glob can contain ../ or traverse a
        // directory link. Neither path output nor counts may escape the scope.
        workspaceManager.resolveSafePath(ctx, path.resolve(basePath, match))
        if (countOnly) {
          if (scanned >= COUNT_SCAN_LIMIT) { incompleteReason = 'scan-limit'; break }
          scanned++
          continue
        }
        if (scanned++ < offset) continue
        if (results.length >= limit) { hasMore = true; break }
        if (characters + match.length + 1 + headerReserve > outputLimit) {
          if (!results.length) return { success: false, output: 'glob: 当前输出预算无法容纳单条路径及分页回执，请缩小 cwd 或提高工具输出预算。', metadata: { code: 'GLOB_OUTPUT_BUDGET', offset } }
          hasMore = true; break
        }
        results.push(match)
        characters += match.length + 1
      }
      throwIfAborted(ctx.signal)
      if (countOnly) {
        const complete = incompleteReason === undefined
        return { success: true,
          output: `Glob count=${scanned} complete=${complete}${complete ? '' : ` (lower bound; reason=${incompleteReason}; narrow cwd or pattern for an exact count)`}`,
          metadata: { countOnly: true, count: scanned, complete, ...(complete ? { totalCount: scanned } : { lowerBound: scanned, incompleteReason }) } }
      }
      if (incompleteReason && !results.length) {
        return { success: false, output: 'glob: 扫描超时，未取得可继续的页面；请缩小 cwd 或 pattern。', metadata: { code: 'GLOB_SCAN_TIMEOUT', offset } }
      }
      const nextOffset = hasMore ? offset + results.length : null
      const header = `Glob page offset=${offset} count=${results.length} limit=${limit} hasMore=${hasMore} nextOffset=${nextOffset}`
      return {
        success: true,
        output: `${header}\n${results.length ? results.join('\n') : offset ? 'Search page exhausted' : 'No files matched'}${incompleteReason ? '\n[Scan deadline reached; continue with nextOffset.]' : ''}`,
        metadata: { count: results.length, offset, limit, hasMore, nextOffset, ...(incompleteReason ? { incompleteReason } : {}) },
      }
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : 'Unknown error' }
    }
  },
}

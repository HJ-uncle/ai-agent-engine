import fs from 'node:fs'
import path from 'node:path'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { workspaceManager } from '../../workspace/index.js'
import { createListingBudget, listDirectoryEntries } from './bounded-listing.js'
import { readOldSnapshot, commitDeleteChange, ChangeRecordingError } from './change-recorder.js'
import { moveToSystemTrash } from './trash.js'
import { withFileLocks } from '../../shared/file-version.js'
import { throwIfAborted } from '../../core/utils/abort.js'

// ── list_files ───────────────────────────────────────────────────────────

export const listFilesTool: Tool = {
  name: 'list_files',
  displayName: '列出文件',
  description: '列出目录文件，默认所有绑定工作区。异步遍历，默认最多500项；截断后请指定更具体的子目录，不跟随符号链接。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      recursive: { type: 'boolean' },
      maxResults: { type: 'integer', minimum: 1, maximum: 2000, description: '本次所有工作区合计的最大条目数，默认500' },
    },
    required: [],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { path: dirPath = '.', recursive = false, maxResults = 500 } = rawArgs as { path?: string; recursive?: boolean; maxResults?: number }
    try {
      const budget = createListingBudget(maxResults)
      const allPaths = workspaceManager.getPaths(ctx)
      const isListingRoot = dirPath === '.' || dirPath === ''
      const roots = isListingRoot && allPaths.length > 1 ? allPaths : [workspaceManager.resolveSafePath(ctx, dirPath)]
      const sections: string[] = []
      for (const root of roots) {
        throwIfAborted(ctx.signal)
        if (budget.truncated) break
        // Recheck the workspace boundary before starting each filesystem walk.
        const safePath = workspaceManager.resolveSafePath(ctx, root)
        const entries = await listDirectoryEntries(safePath, recursive, budget, ctx.signal)
        const output = entries.length ? entries.join('\n') : 'Directory is empty'
        sections.push(roots.length > 1 ? safePath + ':\n' + output : output)
      }
      if (budget.truncated) sections.push('[Listing truncated: ' + budget.reason + '; returned ' + budget.count + ' entries. Specify a narrower directory.]')
      return { success: true, output: sections.join('\n\n') || 'No workspace directories found',
        metadata: { count: budget.count, truncated: budget.truncated, truncationReason: budget.reason } }

    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : 'Unknown error' }
    }
  },
}

// ── delete_file ──────────────────────────────────────────────────────────

export const deleteFileTool: Tool = {
  name: 'delete_file',
  displayName: '删除文件',
  description:
    '删除文件（移入操作系统回收站，可恢复；不是永久删除）',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { path: filePath } = rawArgs as { path: string }
    try {
      const safePath = workspaceManager.resolveSafePath(ctx, filePath)
      return await withFileLocks([safePath], async ([canonicalPath]) => {
        throwIfAborted(ctx.signal)
        // Do not canonicalize a link then trash its target. Directories require
        // a different snapshot/lock protocol and are outside this file tool.
        const stat = fs.lstatSync(safePath)
        if (!stat.isFile() || stat.isSymbolicLink()) {
          return { success: false, output: 'delete_file 仅支持普通文件，不支持目录或符号链接' }
        }
        workspaceManager.resolveSafePath(ctx, canonicalPath)
        const snapshot = await readOldSnapshot(canonicalPath)
        await moveToSystemTrash(canonicalPath)
        const change = await commitDeleteChange(ctx, filePath, canonicalPath, snapshot)
        return { success: true, output: `Moved to trash: ${filePath}`, change }
      })
    } catch (err) {
      return {
        success: false, output: err instanceof Error ? err.message : 'Unknown error',
        ...(err instanceof ChangeRecordingError ? { metadata: { fileMutationApplied: true, rollbackAvailable: false } } : {}),
      }
    }
  },
}

// ── create_dir ────────────────────────────────────────────────────────────

export const createDirTool: Tool = {
  name: 'create_dir',
  displayName: '创建目录',
  description: '创建目录',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { path: dirPath } = rawArgs as { path: string }
    try {
      const safePath = workspaceManager.resolveSafePath(ctx, dirPath)
      return await withFileLocks([safePath], async ([canonicalPath]) => {
        throwIfAborted(ctx.signal)
        workspaceManager.resolveSafePath(ctx, canonicalPath)
        fs.mkdirSync(canonicalPath, { recursive: true })
        return { success: true, output: `Created directory: ${dirPath}` }
      })
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : 'Unknown error' }
    }
  },
}

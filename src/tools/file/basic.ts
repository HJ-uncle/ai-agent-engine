import fs from 'node:fs'
import path from 'node:path'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { workspaceManager } from '../../workspace/index.js'
import { listRecursive } from './utils.js'
import { readOldSnapshot, commitDeleteChange, ChangeRecordingError } from './change-recorder.js'
import { moveToSystemTrash } from './trash.js'
import { withFileLocks } from '../../shared/file-version.js'
import { throwIfAborted } from '../../core/utils/abort.js'

// ── list_files ───────────────────────────────────────────────────────────

export const listFilesTool: Tool = {
  name: 'list_files',
  displayName: '列出文件',
  description: '列出目录文件，默认列出所有绑定工作区',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      recursive: { type: 'boolean' },
    },
    required: [],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { path: dirPath = '.', recursive = false } = rawArgs as { path?: string; recursive?: boolean }
    try {
      const allPaths = workspaceManager.getPaths(ctx)
      const isListingRoot = dirPath === '.' || dirPath === ''

      if (isListingRoot && allPaths.length > 1) {
        const sections: string[] = []
        for (const basePath of allPaths) {
          if (!fs.existsSync(basePath)) continue
          const label = basePath === allPaths[0] ? '主工作区' : `自定义工作区 (${basePath})`
          const entries = recursive
            ? listRecursive(basePath, basePath)
            : fs.readdirSync(basePath).map((name) => {
                const fullPath = path.join(basePath, name)
                const stat = fs.statSync(fullPath)
                return stat.isDirectory() ? `${name}/` : name
              })
          sections.push(`${label}:\n${entries.length === 0 ? '  (空)' : entries.map(e => `  ${e}`).join('\n')}`)
        }
        return { success: true, output: sections.join('\n\n') || 'No workspace directories found' }
      }

      const safePath = workspaceManager.resolveSafePath(ctx, dirPath)
      if (!fs.existsSync(safePath)) {
        return { success: false, output: `Directory not found: ${dirPath}` }
      }

      const entries = recursive
        ? listRecursive(safePath, safePath)
        : fs.readdirSync(safePath).map((name) => {
            const fullPath = path.join(safePath, name)
            const stat = fs.statSync(fullPath)
            return stat.isDirectory() ? `${name}/` : name
          })

      if (entries.length === 0) {
        return { success: true, output: 'Directory is empty' }
      }
      return { success: true, output: entries.join('\n') }
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

import fs from 'node:fs'
import path from 'node:path'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { workspaceManager } from '../../workspace/index.js'

const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE_BYTES ?? '10485760', 10)

export const readFileTool: Tool = {
  name: 'read_file',
  displayName: '读取文件',
  description: '读取工作区中指定文件的内容',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件相对工作区根目录的路径' },
    },
    required: ['path'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { path: filePath } = rawArgs as { path: string }
    try {
      const safePath = workspaceManager.resolveSafePath(ctx, filePath)
      const stat = fs.statSync(safePath)
      if (stat.size > MAX_FILE_SIZE) {
        return { success: false, output: `File too large (${stat.size} bytes, max ${MAX_FILE_SIZE} bytes)` }
      }
      const content = fs.readFileSync(safePath, 'utf-8')
      return { success: true, output: content }
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : 'Unknown error' }
    }
  },
}

export const writeFileTool: Tool = {
  name: 'write_file',
  displayName: '写入文件',
  description: '向工作区中的文件写入内容（会创建新文件或覆盖已有文件）。注意：如果用户请求创建文件但未指定文件名，请根据上下文或内容自动生成一个合理的文件名和路径，不要再询问用户。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件相对工作区根目录的路径' },
      content: { type: 'string', description: '要写入的文本内容' },
    },
    required: ['path', 'content'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { path: filePath, content } = rawArgs as { path: string; content: string }
    try {
      const safePath = workspaceManager.resolveSafePath(ctx, filePath)
      fs.mkdirSync(path.dirname(safePath), { recursive: true })
      fs.writeFileSync(safePath, content, 'utf-8')
      return { success: true, output: `Written ${content.length} characters to ${filePath}` }
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : 'Unknown error' }
    }
  },
}

export const listFilesTool: Tool = {
  name: 'list_files',
  displayName: '列出文件',
  description: '列出工作区中指定目录下的文件和子目录',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作区根目录的路径 (默认: 根目录)', default: '.' },
      recursive: { type: 'boolean', description: '是否递归列出所有子目录下的文件', default: false },
    },
    required: [],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { path: dirPath = '.', recursive = false } = rawArgs as { path?: string; recursive?: boolean }
    try {
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

function listRecursive(baseDir: string, currentDir: string): string[] {
  const entries: string[] = []
  for (const name of fs.readdirSync(currentDir)) {
    const fullPath = path.join(currentDir, name)
    const rel = path.relative(baseDir, fullPath)
    const stat = fs.statSync(fullPath)
    if (stat.isDirectory()) {
      entries.push(`${rel}/`)
      entries.push(...listRecursive(baseDir, fullPath))
    } else {
      entries.push(rel)
    }
  }
  return entries
}

export const deleteFileTool: Tool = {
  name: 'delete_file',
  displayName: '删除文件',
  description: '从工作区中删除指定的文件',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件相对工作区根目录的路径' },
    },
    required: ['path'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { path: filePath } = rawArgs as { path: string }
    try {
      const safePath = workspaceManager.resolveSafePath(ctx, filePath)
      fs.unlinkSync(safePath)
      return { success: true, output: `Deleted: ${filePath}` }
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : 'Unknown error' }
    }
  },
}

export const createDirTool: Tool = {
  name: 'create_dir',
  displayName: '创建目录',
  description: '在工作区中创建一个新的目录',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作区根目录的目录路径' },
    },
    required: ['path'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { path: dirPath } = rawArgs as { path: string }
    try {
      const safePath = workspaceManager.resolveSafePath(ctx, dirPath)
      fs.mkdirSync(safePath, { recursive: true })
      return { success: true, output: `Created directory: ${dirPath}` }
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : 'Unknown error' }
    }
  },
}

// 图片文件扩展名映射到 MIME 类型
const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
}

export const readImageTool: Tool = {
  name: 'read_image',
  displayName: '读取图片',
  description: '读取工作区中的图片文件，将其转换为 base64 格式返回，便于 AI 进行图像识别',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '图片文件相对工作区根目录的路径' },
    },
    required: ['path'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { path: filePath } = rawArgs as { path: string }
    try {
      const safePath = workspaceManager.resolveSafePath(ctx, filePath)
      const stat = fs.statSync(safePath)
      
      if (stat.size > MAX_FILE_SIZE) {
        return { success: false, output: `Image file too large (${stat.size} bytes, max ${MAX_FILE_SIZE} bytes)` }
      }

      const ext = path.extname(safePath).toLowerCase()
      const mimeType = IMAGE_MIME_TYPES[ext] || 'application/octet-stream'

      const buffer = fs.readFileSync(safePath)
      const base64 = buffer.toString('base64')
      const dataUrl = `data:${mimeType};base64,${base64}`

      return { 
        success: true, 
        output: JSON.stringify({
          success: true,
          filename: path.basename(safePath),
          mimeType,
          size: stat.size,
          dataUrl
        })
      }
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : 'Unknown error' }
    }
  },
}

export const fileTools: Tool[] = [
  readFileTool,
  writeFileTool,
  listFilesTool,
  deleteFileTool,
  createDirTool,
  readImageTool,
]

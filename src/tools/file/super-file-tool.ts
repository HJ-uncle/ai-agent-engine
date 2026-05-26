import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { workspaceManager } from '../../workspace/index.js'
import { MAX_FILE_SIZE } from './constants.js'
import { handlerRegistry } from './handlers/registry.js'

export const readFileTool: Tool = {
  name: 'read_file',
  displayName: '读取文件',
  description: '读取任意支持格式的文件（JSON, CSV, XLSX, PDF, DOCX, 代码, 文本）。支持分页读取大文件以节省 Token。返回带行号的内容以便引用。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      start_line: { type: 'number', description: '起始行号（从 1 开始），默认 1' },
      end_line: { type: 'number', description: '结束行号，默认读取 300 行' },
      mode: { type: 'string', enum: ['auto', 'full', 'summary', 'vision', 'ocr'], description: '读取模式：auto(默认), full(全文), summary(摘要/签名), vision(图片预览), ocr(文本提取)' },
    },
    required: ['path'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { path: filePath, mode = 'auto', start_line, end_line } = rawArgs as { path: string; mode?: any; start_line?: number; end_line?: number }
    const startTime = performance.now()
    
    try {
      let targetPath: string
      try {
        targetPath = workspaceManager.resolveSafePath(ctx, filePath)
      } catch (e) {
        // 如果路径解析失败（可能是非法字符），尝试在工作区搜索
        targetPath = ''
      }

      // --- 智能路径纠错逻辑 ---
      if (!targetPath || !fs.existsSync(targetPath)) {
        const fileName = path.basename(filePath)
        const allWorkspacePaths = workspaceManager.getPaths(ctx)
        let bestMatchPath = ''
        let bestMatchTime = 0

        for (const basePath of allWorkspacePaths) {
          if (!fs.existsSync(basePath)) continue
          
          // 递归搜索匹配的文件
          const searchFiles = (dir: string) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true })
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name)
              if (entry.isDirectory()) {
                searchFiles(fullPath)
              } else {
                // 匹配逻辑：完全相等，或者不带后缀相等，或者包含文件名
                const isMatch = entry.name === fileName || 
                               entry.name.replace(/\.[^/.]+$/, "") === fileName ||
                               entry.name.includes(fileName)
                
                if (isMatch) {
                  const stat = fs.statSync(fullPath)
                  if (!bestMatchPath || stat.mtimeMs > bestMatchTime) {
                    bestMatchPath = fullPath
                    bestMatchTime = stat.mtimeMs
                  }
                }
              }
            }
          }
          searchFiles(basePath)
        }

        if (bestMatchPath) {
          ctx.logger.info(`[read_file] 自动纠错：将 "${filePath}" 映射到最新文件 "${bestMatchPath}"`)
          targetPath = bestMatchPath
        } else {
          return { success: false, output: `File not found: ${filePath}. 请确认文件名是否正确，或者尝试只输入关键词。` }
        }
      }
      
      const stat = fs.statSync(targetPath)
      if (stat.isDirectory()) {
        return { success: false, output: `Path is a directory, not a file: ${filePath}` }
      }
      if (stat.size > MAX_FILE_SIZE) {
        return { success: false, output: `File too large (${stat.size} bytes, max ${MAX_FILE_SIZE} bytes)` }
      }

      const handler = handlerRegistry.getHandler(targetPath)
      const result = await handler.read(targetPath, ctx, { 
        mode,
        startLine: start_line,
        endLine: end_line
      })
      
      const endTime = performance.now()
      const timeMs = endTime - startTime
      const originalBytes = stat.size
      const outputContent = result.content || ''
      const compressedBytes = Buffer.byteLength(outputContent, 'utf8')
      const compressionRatio = originalBytes > 0 ? ((1 - compressedBytes / originalBytes) * 100).toFixed(2) + '%' : '0%'
      
      const report = `[读取监控] 耗时: ${timeMs.toFixed(2)}ms | 原始大小: ${originalBytes}B | 压缩后: ${compressedBytes}B | 压缩率: ${compressionRatio}`
      ctx.logger.info(`[read_file] ${targetPath} - ${report}`)

      return { 
        success: true, 
        output: `${report}\n\n${outputContent}` 
      }
    } catch (err) {
      return { success: false, output: `Read error: ${err instanceof Error ? err.message : 'Unknown error'}` }
    }
  },
}

export const writeFileTool: Tool = {
  name: 'write_file',
  displayName: '写入文件',
  description: '将数据写入指定格式的文件。自动根据扩展名选择序列化方式。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要写入的文件路径，扩展名决定格式' },
      data: { 
        type: ['string', 'object', 'array', 'number', 'boolean', 'null'],
        description: '要写入的数据。对于文本，直接传字符串；对于 JSON，传对象或数组；对于表格，传 { sheetName: "Sheet1", rows: [[]] }'
      } as any,
    },
    required: ['path', 'data'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { path: filePath, data } = rawArgs as { path: string; data: any }
    try {
      const safePath = workspaceManager.resolveSafePath(ctx, filePath)
      fs.mkdirSync(path.dirname(safePath), { recursive: true })
      
      const handler = handlerRegistry.getHandler(safePath)
      await handler.write(safePath, data, ctx)
      
      return { success: true, output: `Successfully written to ${filePath}` }
    } catch (err) {
      return { success: false, output: `Write error: ${err instanceof Error ? err.message : 'Unknown error'}` }
    }
  },
}

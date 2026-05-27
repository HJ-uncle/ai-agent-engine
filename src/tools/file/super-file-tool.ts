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
  description: '将数据写入指定格式的文件。支持文本、JSON、Excel (xlsx) 和 Word (docx)。\n\n### 🎨 万能美化指南 (AI 必读)\n- **完全样式开放**: 你可以通过 `headerBg`, `primaryColor`, `font`, `rowAlternateBg` 等参数完全控制文档配色。如果用户说“我要亮紫色风格”，请大胆设置这些颜色。\n- **图片支持**: 支持在 Excel (`images`) 或 Word (`children` 中传 `type: "image"`) 插入图片。只需提供图片路径。\n- **默认专业度**: 如果用户没给指定颜色，默认使用 `theme: "business"` 即可获得深蓝商务风。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径。报告类任务强制使用 .docx，报表类任务强制使用 .xlsx。' },
      data: { 
        type: ['string', 'object', 'array', 'number', 'boolean', 'null'],
        description: `写入数据。
- **Excel (.xlsx) - 全控模板**: 
  \`{ theme: "business", autoWidth: true, headerBg: "6B21A8", headerColor: "FFFFFF", images: [{path: "path/to/logo.png", range: "A1:B2"}], sheets: [...] }\`
  - \`headerBg/headerColor/rowAlternateBg\`: 十六进制颜色码（不带#）。
  - \`autoWidth\`: 自动适配列宽。
  - \`images\`: 插入图片，指定路径和单元格范围。
- **Word (.docx) - 全控模板**: 
  \`{ theme: "business", primaryColor: "6B21A8", font: "楷体", sections: [{ children: [{ type: "paragraph", children: [{ type: "image", path: "img.png", width: 100, height: 100 }] }] }] }\`
  - \`primaryColor\`: 控制标题、表头背景色。
  - \`font\`: 字体名称。
  - \`margin\`: 页边距对象 {top, right, bottom, left}（单位：缇，1440=1英寸）。
  - \`image\`: 在段落中插入图片。`
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

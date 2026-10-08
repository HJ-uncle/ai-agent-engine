import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { workspaceManager } from '../../workspace/index.js'
import { MAX_FILE_SIZE } from './constants.js'
import { handlerRegistry } from './handlers/registry.js'
import { readOldSnapshot, commitWriteChange, ChangeRecordingError, decodeEditableText, restoreSnapshot } from './change-recorder.js'
import { readFileVersionSync, withFileLocks } from '../../shared/file-version.js'
import { normalizeWriteFileArgs } from '../../shared/write-file-args.js'
import { throwIfAborted } from '../../core/utils/abort.js'

export const readFileTool: Tool = {
  name: 'read_file',
  displayName: '读取文件',
  description: '读取支持格式的文件（JSON, CSV, XLSX, PDF, DOCX, 代码, 文本），支持分页。默认返回行号及完整字节 expectedHash；行号和格式化展示不是源文件原文。精确编辑前使用 mode="exact"：返回 JSON，其 content 为无行号的原始 UTF-8 文本（保留 CRLF/BOM），expectedHash 始终对应完整文件。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      start_line: { type: 'number', description: '起始行号（从 1 开始），默认 1' },
      end_line: { type: 'number', description: '结束行号，默认读取 300 行' },
      mode: { type: 'string', enum: ['auto', 'full', 'summary', 'vision', 'ocr', 'exact'], description: 'auto(默认), full(全文), summary(摘要/签名), vision(图片预览), ocr(文本提取), exact(原始UTF-8 JSON，含完整expectedHash，可按行分页)' },
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
        if (mode === 'exact') throw e
        // 如果路径解析失败（可能是非法字符），尝试在工作区搜索
        targetPath = ''
      }

      // --- 智能路径纠错逻辑 ---
      if (!targetPath || !fs.existsSync(targetPath)) {
        if (mode === 'exact') return { success: false, output: `File not found: ${filePath}. Exact mode requires the specified file and does not guess another path.` }
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
      
      return await withFileLocks([targetPath], async ([canonicalPath]) => {
        throwIfAborted(ctx.signal)
        workspaceManager.resolveSafePath(ctx, canonicalPath)
        const stat = fs.statSync(canonicalPath)
        if (!stat.isFile()) return { success: false, output: `Path is not a regular file: ${filePath}` }
        if (stat.size > MAX_FILE_SIZE) return { success: false, output: `File too large (${stat.size} bytes, max ${MAX_FILE_SIZE} bytes)` }
        const before = readFileVersionSync(canonicalPath)
        if (!before.content) return { success: false, output: `File not found: ${filePath}` }
        if (before.content.byteLength > MAX_FILE_SIZE) return { success: false, output: `File too large (${before.content.byteLength} bytes, max ${MAX_FILE_SIZE} bytes)` }
        const text = decodeEditableText(canonicalPath, before.content)
        const endings = text?.match(/\r\n|\r|\n/g) ?? []
        const endingKinds = [...new Set(endings)]
        const version = { path: canonicalPath, expectedHash: before.hash, encoding: text === null ? 'binary-or-non-utf8' : 'utf-8',
          lineEnding: endingKinds.length > 1 ? 'mixed' : endingKinds[0] === '\r\n' ? 'CRLF' : endingKinds[0] === '\n' ? 'LF' : endingKinds[0] === '\r' ? 'CR' : 'none',
          utf8Bom: text?.startsWith('\uFEFF') ?? false }
        if (mode === 'exact') {
          if (text === null) return { success: false, output: 'Exact reading requires a valid UTF-8 text file; use its format-specific read mode for binary files.' }
          if ([start_line, end_line].some(value => value !== undefined && (!Number.isInteger(value) || value < 1))) return { success: false, output: 'start_line and end_line must be positive integers.' }
          const lineStarts = [0, ...Array.from(text.matchAll(/\r\n|\r|\n/g), match => match.index! + match[0].length)]
          const totalLines = lineStarts.length
          const startLine = Math.min(start_line ?? 1, totalLines)
          const endLine = Math.min(end_line ?? totalLines, totalLines)
          if (endLine < startLine) return { success: false, output: 'end_line must not be before start_line.' }
          const content = text.slice(lineStarts[startLine - 1], lineStarts[endLine] ?? text.length)
          return { success: true, output: JSON.stringify({ ...version, startLine, endLine, totalLines, content }), metadata: version }
        }
        const handler = handlerRegistry.getHandler(canonicalPath)
        const result = await handler.read(canonicalPath, ctx, { mode, startLine: start_line, endLine: end_line })
        if (readFileVersionSync(canonicalPath).hash !== before.hash) return { success: false, output: 'File changed while being read; read it again to obtain a matching content and expectedHash.' }
        const timeMs = performance.now() - startTime
        const originalBytes = before.content.byteLength
        const outputContent = result.content || ''
        const compressedBytes = Buffer.byteLength(outputContent, 'utf8')
        const compressionRatio = originalBytes > 0 ? ((1 - compressedBytes / originalBytes) * 100).toFixed(2) + '%' : '0%'
        const report = `[读取监控] 耗时: ${timeMs.toFixed(2)}ms | 原始大小: ${originalBytes}B | 压缩后: ${compressedBytes}B | 压缩率: ${compressionRatio}`
        ctx.logger.info(`[read_file] ${canonicalPath} - ${report}`)
        return { success: true, output: `${report}\n[文件版本] ${JSON.stringify(version)}\n[精确编辑] 展示行号和格式化内容不是原文；edit_file 前可用 mode="exact" 获取无行号 content。\n\n${outputContent}`, metadata: version }
      })
    } catch (err) {
      return { success: false, output: `Read error: ${err instanceof Error ? err.message : 'Unknown error'}` }
    }
  },
}

export const writeFileTool: Tool = {
  name: 'write_file',
  displayName: '写入文件',
  description: '将数据写入指定格式的文件。支持文本、JSON、Excel (xlsx) 和 Word (docx)。成功返回实际落盘文件的 expectedHash；后续 edit_file 可直接使用这个版本及已知原文，不要自行计算或猜测 hash。格式化后的 UTF-8 文本原文不确定时先 read_file mode="exact"。\n\n### 🎨 万能美化指南 (AI 必读)\n- **完全样式开放**: 你可以通过 `headerBg`, `primaryColor`, `font`, `rowAlternateBg` 等参数完全控制文档配色。如果用户说“我要亮紫色风格”，请大胆设置这些颜色。\n- **图片支持**: 支持在 Excel (`images`) 或 Word (`children` 中传 `type: "image"`) 插入图片。只需提供图片路径。\n- **默认专业度**: 如果用户没给指定颜色，默认使用 `theme: "business"` 即可获得深蓝商务风。',
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
    const normalized = normalizeWriteFileArgs(rawArgs)
    if (!normalized.ok) {
      return { success: false, output: normalized.error.message, error: normalized.error.code,
        metadata: { code: normalized.error.code, fileMutationApplied: false } }
    }
    const { path: filePath, data, usedContentAlias } = normalized.args
    try {
      const safePath = workspaceManager.resolveSafePath(ctx, filePath)
      return await withFileLocks([safePath], async ([canonicalPath]) => {
        throwIfAborted(ctx.signal)
        workspaceManager.resolveSafePath(ctx, canonicalPath)
        const snapshot = await readOldSnapshot(canonicalPath)
        fs.mkdirSync(path.dirname(canonicalPath), { recursive: true })
        const handler = handlerRegistry.getHandler(canonicalPath)
        try {
          await handler.write(canonicalPath, data, ctx)
        } catch (error) {
          // Some format writers can fail after touching the destination. Keep
          // evidence of those bytes too, while preserving the failed outcome.
          try {
            if (fs.statSync(canonicalPath).size > MAX_FILE_SIZE) {
              restoreSnapshot(canonicalPath, snapshot)
              return { success: false, output: `Write failed and produced an oversized file; the original was restored: ${error instanceof Error ? error.message : String(error)}`,
                error: 'WRITE_FILE_TOO_LARGE', metadata: { code: 'WRITE_FILE_TOO_LARGE', fileMutationApplied: false } }
            }
          } catch (sizeError) {
            if ((sizeError as NodeJS.ErrnoException).code !== 'ENOENT') {
              return { success: false, output: `Write failed and its result could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
                error: 'WRITE_FAILED', metadata: { code: 'WRITE_FAILED', fileMutationApplied: true, rollbackAvailable: false } }
            }
          }
          const after = await readOldSnapshot(canonicalPath)
          if (after.oldHash !== snapshot.oldHash) {
            const change = await commitWriteChange(ctx, filePath, canonicalPath, snapshot)
            return {
              success: false,
              output: `Write failed after changing ${filePath}; the actual change was recorded: ${error instanceof Error ? error.message : String(error)}`,
              change,
              metadata: { fileMutationApplied: true, rollbackAvailable: !change.truncated },
            }
          }
          throw error
        }
        const written = fs.statSync(canonicalPath)
        if (written.size > MAX_FILE_SIZE) {
          // Format writers may expand structured input substantially. Restore
          // the pre-write state before returning so a rejected oversized
          // artifact cannot leave an untracked mutation on disk.
          try {
            restoreSnapshot(canonicalPath, snapshot)
            return { success: false, output: `File too large: write_file supports files up to ${MAX_FILE_SIZE} bytes.`,
              error: 'WRITE_FILE_TOO_LARGE', metadata: { code: 'WRITE_FILE_TOO_LARGE', fileMutationApplied: false } }
          } catch (restoreError) {
            return { success: false, output: `File too large and could not be restored: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
              error: 'WRITE_FILE_TOO_LARGE', metadata: { code: 'WRITE_FILE_TOO_LARGE', fileMutationApplied: true, rollbackAvailable: false } }
          }
        }
        const change = await commitWriteChange(ctx, filePath, canonicalPath, snapshot)
        // Return the recorded on-disk version: format handlers may change the input bytes.
        // Metadata alone is not sent to the model in the next tool-result message.
        return { success: true, output: `Successfully written to ${filePath}\npath: ${canonicalPath}\nexpectedHash: ${change.newHash}`, change,
          metadata: { path: canonicalPath, expectedHash: change.newHash, fileMutationApplied: true, rollbackAvailable: !change.truncated,
            ...(usedContentAlias ? { compatibilityAlias: 'content' } : {}) } }
      })
    } catch (err) {
      return {
        success: false,
        output: `Write error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        ...(err instanceof ChangeRecordingError ? { metadata: { fileMutationApplied: true, rollbackAvailable: false } } : {}),
      }
    }
  },
}

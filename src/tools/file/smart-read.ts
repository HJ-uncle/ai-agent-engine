import fs from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { performance } from 'node:perf_hooks'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { workspaceManager } from '../../workspace/index.js'

const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE_BYTES ?? '10485760', 10)

// 缓存策略：内存缓存，以文件路径和最后修改时间为键
interface CacheEntry {
  mtimeMs: number
  content: string
  metrics: ReadMetrics
}
const fileCache = new Map<string, CacheEntry>()

interface ReadMetrics {
  timeMs: number
  originalBytes: number
  compressedBytes: number
  compressionRatio: string
}

function getCacheKey(filePath: string): string {
  return filePath
}

// 单元格值 → 可读字符串
function cellValueToString(val: unknown): string {
  if (val === null || val === undefined) return ''
  if (typeof val === 'string') return val
  if (typeof val === 'number') return String(val)
  if (typeof val === 'boolean') return String(val)
  if (val instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${val.getFullYear()}-${pad(val.getMonth() + 1)}-${pad(val.getDate())}`
  }
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>
    if ('formula' in obj || 'result' in obj || 'sharedFormula' in obj) {
      return cellValueToString(obj.result)
    }
    if ('richText' in obj && Array.isArray(obj.richText)) {
      return (obj.richText as Array<{ text?: string }>).map(r => r.text ?? '').join('')
    }
    if ('error' in obj) return `#${obj.error}`
    if ('text' in obj && 'hyperlink' in obj) return String(obj.text)
    return JSON.stringify(val)
  }
  return String(val)
}

function extractCodeSummary(content: string, ext: string): string {
  const lines = content.split('\n')
  const summary: string[] = []
  let inClassOrFunc = false
  
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    
    // 简单的正则表达式匹配类和函数定义
    if (ext === '.ts' || ext === '.js' || ext === '.tsx' || ext === '.jsx') {
      if (/^(export\s+)?(class|interface|type|function|const\s+\w+\s*=\s*(async\s*)?\([^)]*\)\s*=>)/.test(trimmed)) {
        summary.push(line)
        inClassOrFunc = true
      } else if (inClassOrFunc && /^}/.test(trimmed)) {
        summary.push(line)
        inClassOrFunc = false
      } else if (trimmed.startsWith('//') || trimmed.startsWith('/*')) {
        summary.push(line) // 保留注释
      }
    } else if (ext === '.py') {
      if (/^(def|class)\s+\w+/.test(trimmed)) {
        summary.push(line)
      } else if (trimmed.startsWith('#')) {
        summary.push(line)
      }
    } else if (ext === '.go') {
      if (/^(func|type)\s+\w+/.test(trimmed)) {
        summary.push(line)
      } else if (trimmed.startsWith('//')) {
        summary.push(line)
      }
    }
  }
  
  // 如果摘要太短，可能没匹配到什么，直接返回原内容的前 N 行
  if (summary.length < 5 && lines.length > 20) {
    return lines.slice(0, 100).join('\n') + '\n... (内容过长，仅显示前100行)'
  }
  
  return summary.join('\n') + '\n... (仅显示代码签名和注释，完整内容需具体分析)'
}

export const smartReadFileTool: Tool = {
  name: 'smart_read',
  displayName: '智能文件读取',
  description: '自动识别文件类型并进行结构化压缩读取，支持代码签名提取、JSON/Excel压缩预览，大幅节省Token消耗。当需要了解文件大意或结构时优先使用此工具。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      mode: { type: 'string', enum: ['auto', 'full', 'summary'], description: '读取模式：auto(默认自动优化), full(全文), summary(仅摘要)' }
    },
    required: ['path'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const args = rawArgs as { path: string; mode?: 'auto' | 'full' | 'summary' }
    const mode = args.mode || 'auto'
    
    const startTime = performance.now()
    
    try {
      const safePath = workspaceManager.resolveSafePath(ctx, args.path)
      if (!fs.existsSync(safePath)) {
        return { success: false, output: `File not found: ${args.path}` }
      }
      
      const stat = fs.statSync(safePath)
      if (stat.size > MAX_FILE_SIZE) {
        return { success: false, output: `File too large (${stat.size} bytes, max ${MAX_FILE_SIZE} bytes)` }
      }

      // 检查缓存
      const cacheKey = getCacheKey(safePath)
      const cached = fileCache.get(cacheKey)
      if (cached && cached.mtimeMs === stat.mtimeMs && mode !== 'full') {
        ctx.logger.info(`[smart_read] Cache hit for ${args.path}`)
        return { 
          success: true, 
          output: `[命中缓存] 性能指标: 耗时 ${cached.metrics.timeMs.toFixed(2)}ms, 压缩率 ${cached.metrics.compressionRatio}\n\n${cached.content}`
        }
      }

      const ext = path.extname(safePath).toLowerCase()
      let outputContent = ''
      const originalBytes = stat.size

      // 自动类型识别和优化读取
      if (ext === '.json' && mode !== 'full') {
        const raw = fs.readFileSync(safePath, 'utf-8')
        try {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed) && parsed.length > 5) {
            outputContent = JSON.stringify(parsed.slice(0, 5), null, 2) + `\n... (Array with ${parsed.length} items, truncated)`
          } else {
            outputContent = JSON.stringify(parsed)
            if (outputContent.length > 2000) {
               outputContent = outputContent.substring(0, 2000) + '\n... (JSON content truncated)'
            }
          }
        } catch (e) {
          outputContent = raw.substring(0, 2000) + ' (Invalid JSON)'
        }
      } else if ((ext === '.xls' || ext === '.xlsx' || ext === '.csv') && mode !== 'full') {
        try {
          const workbook = new ExcelJS.Workbook()
          if (ext === '.csv') {
            await workbook.csv.readFile(safePath)
          } else {
            await workbook.xlsx.readFile(safePath)
          }
          const worksheet = workbook.worksheets[0]
          if (!worksheet) {
            throw new Error('No worksheets found')
          }
          const firstSheet = worksheet.name
          const data: string[] = []
          worksheet.eachRow((row, rowNumber) => {
            if (rowNumber <= 10) {
              const vals = Array.isArray(row.values) ? row.values.slice(1) : []
              const strs = vals.map(v => cellValueToString(v))
              if (rowNumber <= 3) {
                const unique = [...new Set(strs.filter(s => s !== ''))]
                if (unique.length === 1 && strs.filter(s => s !== '').length >= 3) {
                  data.push(`${unique[0]} (合并单元格)`)
                  return
                }
              }
              data.push(strs.join(' | '))
            }
          })
          const preview = data.join('\n')
          outputContent = `[Excel/CSV Preview - Sheet: ${firstSheet} - Rows: ${worksheet.rowCount}]\n${preview}\n... (Only showing first 10 rows)`
        } catch (e: any) {
          if (e.message?.includes('Corrupted zip') || e.message?.includes('central dir')) {
            outputContent = `表格文件 ZIP 结构已损坏（通常是因为文件上传时未使用二进制模式，导致字节被 UTF-8 编码污染）。\n请通过 multipart 文件上传接口 (POST /workspace/upload) 重新上传此文件，或使用 base64 编码上传。\n原始错误: ${e.message}`
          } else {
            outputContent = `Failed to parse spreadsheet: ${e.message}`
          }
        }
      } else if (['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.java'].includes(ext) && (mode === 'summary' || (mode === 'auto' && originalBytes > 2000))) {
        const raw = fs.readFileSync(safePath, 'utf-8')
        outputContent = extractCodeSummary(raw, ext)
      } else {
        const raw = fs.readFileSync(safePath, 'utf-8')
        if (raw.length > 10000 && mode !== 'full') {
           outputContent = raw.substring(0, 10000) + '\n... (Content truncated to 10000 chars. Use mode="full" to read entirely.)'
        } else {
           outputContent = raw
        }
      }

      const endTime = performance.now()
      const timeMs = endTime - startTime
      const compressedBytes = Buffer.byteLength(outputContent, 'utf8')
      const compressionRatio = originalBytes > 0 ? ((1 - compressedBytes / originalBytes) * 100).toFixed(2) + '%' : '0%'
      
      const metrics: ReadMetrics = { timeMs, originalBytes, compressedBytes, compressionRatio }
      
      if (mode !== 'full') {
        fileCache.set(cacheKey, { mtimeMs: stat.mtimeMs, content: outputContent, metrics })
      }

      const report = `[读取监控] 耗时: ${timeMs.toFixed(2)}ms | 原始大小: ${originalBytes}B | 压缩后: ${compressedBytes}B | 压缩率: ${compressionRatio}`
      ctx.logger.info(`[smart_read] ${args.path} - ${report}`)

      return { 
        success: true, 
        output: `${report}\n\n${outputContent}` 
      }
    } catch (err) {
      return { success: false, output: `Smart read error: ${err instanceof Error ? err.message : 'Unknown error'}` }
    }
  },
}

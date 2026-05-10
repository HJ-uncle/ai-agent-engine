import fs from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'
import Tesseract from 'tesseract.js'
import { performance } from 'node:perf_hooks'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { workspaceManager } from '../../workspace/index.js'

const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE_BYTES ?? '10485760', 10)

// ── 缓存策略 ────────────────────────────────────────────────────────────
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

// ── 通用工具函数 ──────────────────────────────────────────────────────────

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
    
    if (ext === '.ts' || ext === '.js' || ext === '.tsx' || ext === '.jsx') {
      if (/^(export\s+)?(class|interface|type|function|const\s+\w+\s*=\s*(async\s*)?\([^)]*\)\s*=>)/.test(trimmed)) {
        summary.push(line)
        inClassOrFunc = true
      } else if (inClassOrFunc && /^}/.test(trimmed)) {
        summary.push(line)
        inClassOrFunc = false
      } else if (trimmed.startsWith('//') || trimmed.startsWith('/*')) {
        summary.push(line)
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
  
  if (summary.length < 5 && lines.length > 20) {
    return lines.slice(0, 100).join('\n') + '\n... (内容过长，仅显示前100行)'
  }
  
  return summary.join('\n') + '\n... (仅显示代码签名和注释，完整内容需具体分析)'
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

// ── read_file ────────────────────────────────────────────────────────────

export const readFileTool: Tool = {
  name: 'read_file',
  displayName: '读取文件',
  description: '读取工作区文件内容',
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

// ── write_file ───────────────────────────────────────────────────────────

export const writeFileTool: Tool = {
  name: 'write_file',
  displayName: '写入文件',
  description: '写入文件（创建或覆盖），自动生成文件名',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
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
  description: '删除文件',
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
      fs.unlinkSync(safePath)
      return { success: true, output: `Deleted: ${filePath}` }
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : 'Unknown error' }
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
      fs.mkdirSync(safePath, { recursive: true })
      return { success: true, output: `Created directory: ${dirPath}` }
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : 'Unknown error' }
    }
  },
}

// ── read_image ────────────────────────────────────────────────────────────

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

const IMAGE_MAGIC_BYTES: { ext: string; signature: number[] }[] = [
  { ext: 'png',  signature: [0x89, 0x50, 0x4E, 0x47] },
  { ext: 'jpg',  signature: [0xFF, 0xD8, 0xFF] },
  { ext: 'gif',  signature: [0x47, 0x49, 0x46] },
  { ext: 'bmp',  signature: [0x42, 0x4D] },
  { ext: 'webp', signature: [0x52, 0x49, 0x46, 0x46] },
  { ext: 'tiff', signature: [0x49, 0x49, 0x2A, 0x00] },
  { ext: 'tiff', signature: [0x4D, 0x4D, 0x00, 0x2A] },
]

function isVisionModelAvailable(ctx: AgentContext): boolean {
  const modelName = (ctx as any).modelName || process.env.MODEL_NAME || ''
  const visionModels = [
    'gpt-4v', 'gpt-4-vision', 'gpt-4-turbo', 'gpt-4o',
    'claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku',
    'gemini-pro-vision', 'gemini-1.5-pro', 'gemini-1.5-flash',
    'llava', 'bakllava', 'qwen-vl', 'qwen2-vl'
  ]
  
  const lowerModel = modelName.toLowerCase()
  return visionModels.some(vm => lowerModel.includes(vm.toLowerCase()))
}

function isValidImageFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(12)
    fs.readSync(fd, buf, 0, 12, 0)
    fs.closeSync(fd)

    return IMAGE_MAGIC_BYTES.some(({ signature }) =>
      signature.every((byte, i) => buf[i] === byte)
    )
  } catch {
    return false
  }
}

async function extractTextWithOCR(imagePath: string, language: string, ctx: AgentContext): Promise<ToolResult> {
  try {
    if (!Tesseract) {
      return {
        success: false,
        output: `❌ OCR 功能不可用：未安装 tesseract.js\n\n请先安装依赖：\nnpm install tesseract.js`
      }
    }

    if (typeof Tesseract.recognize !== 'function') {
      ctx.logger.error(`[read_image] Tesseract.recognize is not a function, Tesseract keys: ${Object.keys(Tesseract)}`)
      return {
        success: false,
        output: `❌ OCR 功能异常：Tesseract.recognize 不可用\n\n可能是 tesseract.js 版本问题，请尝试重新安装：\nnpm install tesseract.js@5`
      }
    }

    if (!isValidImageFile(imagePath)) {
      ctx.logger.error(`[read_image] File is not a valid image (magic bytes check failed): ${imagePath}`)
      return {
        success: false,
        output: `❌ 文件内容不是有效的图片格式：${path.basename(imagePath)}\n\n文件扩展名可能与实际内容不匹配。请确保文件是真正的图片文件。\n如需读取文本文件，请使用 read_file 工具。`
      }
    }

    ctx.logger.info(`[read_image] Running OCR on ${imagePath} with language: ${language}`)

    let ocrResult: Tesseract.RecognizeResult
    const uncaughtHandler = (err: Error) => {
      if (err.message?.includes('Error attempting to read image') || err.message?.includes('Unknown format')) {
        ctx.logger.error(`[read_image] Caught uncaught Tesseract error (suppressed): ${err.message}`)
      } else {
        throw err
      }
    }
    process.on('uncaughtException', uncaughtHandler)

    try {
      ocrResult = await Tesseract.recognize(
        imagePath,
        language,
        {
          logger: (m: any) => ctx.logger.debug(`[Tesseract] ${m.status}: ${m.progress}`)
        }
      )
    } finally {
      process.removeListener('uncaughtException', uncaughtHandler)
    }

    const { data: { text, confidence } } = ocrResult

    if (!text || text.trim().length === 0) {
      return {
        success: true,
        output: `📷 **图片 OCR 结果**\n\n**文件名**: ${path.basename(imagePath)}\n**语言**: ${language}\n**置信度**: ${(confidence * 100).toFixed(1)}%\n\n**提取的文本**: \n*未检测到可识别的文本内容*`
      }
    }

    const result = [
      `📷 **图片 OCR 结果**`,
      ``,
      `**文件名**: ${path.basename(imagePath)}`,
      `**语言**: ${language}`,
      `**置信度**: ${(confidence * 100).toFixed(1)}%`,
      ``,
      `**提取的文本**:`,
      `\`\`\``,
      text,
      `\`\`\``,
    ].join('\n')

    ctx.logger.info(`[read_image] OCR completed, extracted ${text.length} characters`)

    return { success: true, output: result }
  } catch (err: any) {
    ctx.logger.error(`[read_image] OCR failed: ${err.message}`)
    return {
      success: false,
      output: `❌ OCR 识别失败: ${err.message}\n\n如果是语言包问题，请确保安装了对应的语言数据。\n建议的语言代码：\n- 英文: eng\n- 简体中文: chi_sim\n- 繁体中文: chi_tra\n- 日语: jpn\n- 韩语: kor\n- 多语言: eng+chi_sim`
    }
  }
}

export const readImageTool: Tool = {
  name: 'read_image',
  displayName: '读取图片',
  description: '读取图片文件，多模态模型返回 base64，否则 OCR 提取文本',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      mode: { type: 'string', description: 'auto=自动检测, vision=返回图片, ocr=提取文本', enum: ['auto', 'vision', 'ocr'] },
      language: { type: 'string', description: 'OCR语言，默认eng+chi_sim' }
    },
    required: ['path'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { path: filePath, mode = 'auto', language = 'eng+chi_sim' } = rawArgs as { path: string; mode?: string; language?: string }
    
    try {
      const safePath = workspaceManager.resolveSafePath(ctx, filePath)
      const stat = fs.statSync(safePath)
      
      if (stat.size > MAX_FILE_SIZE) {
        return { success: false, output: `Image file too large (${stat.size} bytes, max ${MAX_FILE_SIZE} bytes)` }
      }

      const ext = path.extname(safePath).toLowerCase()
      const mimeType = IMAGE_MIME_TYPES[ext]

      if (!mimeType) {
        const supportedExts = Object.keys(IMAGE_MIME_TYPES).join(', ')
        return {
          success: false,
          output: `❌ 不支持的文件格式："${ext || '(无扩展名)'}"\n\n支持的图片格式：${supportedExts}\n\n如需读取文本文件，请使用 read_file 工具。`
        }
      }

      const visionAvailable = isVisionModelAvailable(ctx)
      let useOcr = false

      if (mode === 'auto') {
        useOcr = !visionAvailable
      } else if (mode === 'ocr') {
        useOcr = true
      } else if (mode === 'vision') {
        useOcr = false
      }

      if (useOcr) {
        return await extractTextWithOCR(safePath, language, ctx)
      } else {
        const buffer = fs.readFileSync(safePath)
        const base64 = buffer.toString('base64')
        const dataUrl = `data:${mimeType};base64,${base64}`

        const result = JSON.stringify({
          success: true,
          filename: path.basename(safePath),
          mimeType,
          size: stat.size,
          dataUrl,
          hasDataUrl: true
        })

        ctx.logger.info(`[read_image] ✅ file="${path.basename(safePath)}" mimeType=${mimeType} fileSize=${stat.size} dataUrlLen=${dataUrl.length}`)

        return { success: true, output: result }
      }
    } catch (err) {
      ctx.logger.error(`[read_image] ❌ error:`, err instanceof Error ? err.message : err)
      return { success: false, output: err instanceof Error ? err.message : 'Unknown error' }
    }
  },
}

// ── smart_read ────────────────────────────────────────────────────────────

export const smartReadFileTool: Tool = {
  name: 'smart_read',
  displayName: '智能文件读取',
  description: '万能文件读取工具，自动识别文件类型并智能处理：图片→OCR/base64、代码→签名提取、JSON/Excel→压缩预览、文本→截断压缩。一次调用覆盖所有文件读取场景，无需AI判断选择子工具。',
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

      const ext = path.extname(safePath).toLowerCase()

      // ── 图片自动识别 → OCR / Vision base64 ──────────────────────────────
      if (IMAGE_MIME_TYPES[ext] && mode !== 'full') {
        const mimeType = IMAGE_MIME_TYPES[ext]
        const visionAvailable = isVisionModelAvailable(ctx)

        if (!visionAvailable) {
          // 非多模态模型 → OCR 提取文本
          const ocrResult = await extractTextWithOCR(safePath, 'eng+chi_sim', ctx)
          if (!ocrResult.success) return ocrResult
          const endTime = performance.now()
          const timeMs = endTime - startTime
          ctx.logger.info(`[smart_read] ${args.path} OCR - ${timeMs.toFixed(2)}ms`)
          return ocrResult
        }

        // 多模态模型 → base64
        const buffer = fs.readFileSync(safePath)
        const base64 = buffer.toString('base64')
        const dataUrl = `data:${mimeType};base64,${base64}`
        const endTime = performance.now()
        const timeMs = endTime - startTime

        const imageResult = JSON.stringify({
          success: true,
          filename: path.basename(safePath),
          mimeType,
          size: stat.size,
          dataUrl,
          hasDataUrl: true
        })

        ctx.logger.info(`[smart_read] ${args.path} vision - ${timeMs.toFixed(2)}ms mimeType=${mimeType} fileSize=${stat.size} dataUrlLen=${dataUrl.length}`)
        return { success: true, output: imageResult }
      }

      // ── 图片 mode=full → 直接返回 base64（等同于 vision 模式）─────────
      if (IMAGE_MIME_TYPES[ext] && mode === 'full') {
        const mimeType = IMAGE_MIME_TYPES[ext]
        const buffer = fs.readFileSync(safePath)
        const base64 = buffer.toString('base64')
        const dataUrl = `data:${mimeType};base64,${base64}`
        const imageResult = JSON.stringify({
          success: true,
          filename: path.basename(safePath),
          mimeType,
          size: stat.size,
          dataUrl,
          hasDataUrl: true
        })
        ctx.logger.info(`[smart_read] ${args.path} full/vision - mimeType=${mimeType} fileSize=${stat.size}`)
        return { success: true, output: imageResult }
      }

      const cacheKey = getCacheKey(safePath)
      const cached = fileCache.get(cacheKey)
      if (cached && cached.mtimeMs === stat.mtimeMs && mode !== 'full') {
        ctx.logger.info(`[smart_read] Cache hit for ${args.path}`)
        return { 
          success: true, 
          output: `[命中缓存] 性能指标: 耗时 ${cached.metrics.timeMs.toFixed(2)}ms, 压缩率 ${cached.metrics.compressionRatio}\n\n${cached.content}`
        }
      }

      let outputContent = ''
      const originalBytes = stat.size

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
      } else if (ext === '.xls' || ext === '.xlsx' || ext === '.csv') {
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
          const maxRows = mode === 'full' ? worksheet.rowCount : 10
          const data: string[] = []
          worksheet.eachRow((row, rowNumber) => {
            if (rowNumber <= maxRows) {
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
          const note = mode === 'full' ? '' : '\n... (Only showing first 10 rows, use mode="full" for all)'
          outputContent = `[Excel/CSV Preview - Sheet: ${firstSheet} - Rows: ${worksheet.rowCount}]\n${preview}${note}`
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

// ── 统一工具数组 ──────────────────────────────────────────────────────────

export const fileTools: Tool[] = [
  readFileTool,
  writeFileTool,
  listFilesTool,
  deleteFileTool,
  createDirTool,
  readImageTool,
  smartReadFileTool,
]

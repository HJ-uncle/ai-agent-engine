import fs from 'node:fs'
import path from 'node:path'
import Tesseract from 'tesseract.js'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { workspaceManager } from '../../workspace/index.js'

const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE_BYTES ?? '10485760', 10)

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
      // 如果是默认根目录，且有多个工作区路径，则列出所有工作区的内容
      const allPaths = workspaceManager.getPaths(ctx)
      const isListingRoot = dirPath === '.' || dirPath === ''

      if (isListingRoot && allPaths.length > 1) {
        // 多工作区：分别列出每个工作区，标注来源
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

      // 单路径或指定具体路径：使用 resolveSafePath 解析
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

      // 检查是否为支持的图片格式
      if (!mimeType) {
        const supportedExts = Object.keys(IMAGE_MIME_TYPES).join(', ')
        return {
          success: false,
          output: `❌ 不支持的文件格式："${ext || '(无扩展名)'}"\n\n支持的图片格式：${supportedExts}\n\n如需读取文本文件，请使用 read_file 工具。`
        }
      }

      // 判断是否为多模态模型
      const isVisionModel = isVisionModelAvailable(ctx)
      let useOcr = false

      if (mode === 'auto') {
        useOcr = !isVisionModel
      } else if (mode === 'ocr') {
        useOcr = true
      } else if (mode === 'vision') {
        useOcr = false
      }

      if (useOcr) {
        // 使用 OCR 提取文本
        return await extractTextWithOCR(safePath, language, ctx)
      } else {
        // 返回 base64 格式图片
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

// 常见图片格式的 magic bytes 签名
const IMAGE_MAGIC_BYTES: { ext: string; signature: number[] }[] = [
  { ext: 'png',  signature: [0x89, 0x50, 0x4E, 0x47] },          // \x89PNG
  { ext: 'jpg',  signature: [0xFF, 0xD8, 0xFF] },                 // JPEG SOI
  { ext: 'gif',  signature: [0x47, 0x49, 0x46] },                 // GIF
  { ext: 'bmp',  signature: [0x42, 0x4D] },                       // BM
  { ext: 'webp', signature: [0x52, 0x49, 0x46, 0x46] },           // RIFF (WebP)
  { ext: 'tiff', signature: [0x49, 0x49, 0x2A, 0x00] },           // TIFF LE
  { ext: 'tiff', signature: [0x4D, 0x4D, 0x00, 0x2A] },           // TIFF BE
]

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

    // 在调用 Tesseract 之前，通过 magic bytes 检查文件是否为有效图片
    if (!isValidImageFile(imagePath)) {
      ctx.logger.error(`[read_image] File is not a valid image (magic bytes check failed): ${imagePath}`)
      return {
        success: false,
        output: `❌ 文件内容不是有效的图片格式：${path.basename(imagePath)}\n\n文件扩展名可能与实际内容不匹配。请确保文件是真正的图片文件。\n如需读取文本文件，请使用 read_file 工具。`
      }
    }

    ctx.logger.info(`[read_image] Running OCR on ${imagePath} with language: ${language}`)

    // 使用 Promise 包装 Tesseract.recognize，捕获 worker 内部异步错误
    let ocrResult: Tesseract.RecognizeResult
    const uncaughtHandler = (err: Error) => {
      if (err.message?.includes('Error attempting to read image') || err.message?.includes('Unknown format')) {
        ctx.logger.error(`[read_image] Caught uncaught Tesseract error (suppressed): ${err.message}`)
        // 吞掉这个错误，防止进程崩溃；Promise 的 reject 会处理
      } else {
        throw err  // 不是我们的错误，重新抛出
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

export const fileTools: Tool[] = [
  readFileTool,
  writeFileTool,
  listFilesTool,
  deleteFileTool,
  createDirTool,
  readImageTool,
]

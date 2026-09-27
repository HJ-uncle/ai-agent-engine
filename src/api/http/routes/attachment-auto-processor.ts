import fs from 'node:fs'
import path from 'node:path'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { workspaceManager } from '../../../workspace/index.js'
import { readFileTool } from '../../../tools/file/index.js'

interface ImageUrlPart {
  type: 'image_url'
  image_url: { url: string }
}

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.tiff': 'image/tiff', '.svg': 'image/svg+xml',
}

/**
 * File handler — pluggable unit for processing a category of attachments.
 *
 * To add support for a new file format, simply add a new handler to the
 * `FILE_HANDLERS` array with a `match()` predicate and a `process()` function.
 */
interface FileHandler {
  /** Return true if this handler should process the file */
  match: (fileName: string) => boolean
  /** Process the file in the workspace; return processed content (or null to skip) */
  process: (ctx: AgentContext, fileName: string, opts: AutoProcessOptions) => Promise<{
    text?: string
    imageParts?: ImageUrlPart[]
  } | null>
}

export interface AutoProcessOptions {
  /** Raw message text extracted from user input */
  messageText: string
  /** Whether the current LLM supports vision natively */
  isVisionModel: boolean
}

export interface AutoProcessResult {
  /** Final prompt to send to the LLM */
  prompt: string | any[]
  /** Paths of files that were successfully processed */
  processedFiles: string[]
}

// ── Built-in handlers ──────────────────────────────────────────────────

const imageHandler: FileHandler = {
  match: (fileName) => {
    const ext = path.extname(fileName).toLowerCase()
    return ext in MIME_MAP
  },
  process: async (ctx, fileName, opts) => {
    const safePath = workspaceManager.resolveSafePath(ctx, fileName)
    if (!fs.existsSync(safePath)) return null

    const ext = path.extname(safePath).toLowerCase()
    const mime = MIME_MAP[ext] || 'image/png'

    if (opts.isVisionModel) {
      const buffer = fs.readFileSync(safePath)
      const base64 = buffer.toString('base64')
      return {
        imageParts: [{
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${base64}` }
        }]
      }
    }

    const ocrResult = await readFileTool.execute(
      { path: fileName, mode: 'ocr', language: 'eng+chi_sim' },
      ctx
    )
    if (!ocrResult.success) return null
    return { text: ocrResult.output }
  }
}

const smartReadHandler: FileHandler = {
  match: () => true,
  process: async (ctx, fileName) => {
    const result = await readFileTool.execute({ path: fileName, mode: 'auto' }, ctx)
    if (!result.success) return null
    const cleanOutput = result.output.replace(/^\[读取监控\][^\n]*\n\n?/gm, '')
    return { text: cleanOutput }
  }
}

/** Handlers are tried in order; first match wins. Add new handlers here. */
const FILE_HANDLERS: FileHandler[] = [
  imageHandler,
  smartReadHandler,
]

// ── Orchestrator ────────────────────────────────────────────────────────

/**
 * Auto-process all attachments before the prompt reaches the LLM.
 *
 * Collects files from both the `attachments` array and the `message` multimodal
 * parts, deduplicates, runs them through matching handlers, and returns a
 * unified prompt with all content injected.
 */
export async function autoProcessAttachments(
  ctx: AgentContext,
  message: string | any[] | undefined,
  messageText: string,
  attachments: { name: string; type?: string }[] | undefined,
  opts: AutoProcessOptions,
): Promise<AutoProcessResult> {
  const fileNames: string[] = []

  if (attachments) {
    for (const a of attachments) fileNames.push(a.name)
  }

  if (Array.isArray(message)) {
    for (const part of message) {
      if (part.name && (part.type === 'workspace_image' || part.type === 'workspace_file')) {
        fileNames.push(part.name)
      }
    }
  }

  const uniqueNames = [...new Set(fileNames)]
  if (uniqueNames.length === 0) {
    return { prompt: messageText || null as any, processedFiles: [] }
  }

  const imageParts: ImageUrlPart[] = []
  const textBlocks: string[] = []
  const processed: string[] = []

  for (const name of uniqueNames) {
    for (const handler of FILE_HANDLERS) {
      if (!handler.match(name)) continue
      const result = await handler.process(ctx, name, opts)
      if (!result) break

      if (result.imageParts) imageParts.push(...result.imageParts)
      if (result.text) textBlocks.push(`\n\n【文件 ${name} 内容】\n${result.text}`)
      processed.push(name)
      break
    }
  }

  if (imageParts.length > 0) {
    const inlineNote = `\n\n[系统提示：以上图片内容已通过视觉能力直接内嵌到本消息中，你已经可以看到图片内容。无需再调用 smart_read / read_image 工具重复读取。]`
    const multimodal: any[] = [
      { type: 'text', text: (messageText || '') + inlineNote },
      ...imageParts,
    ]
    if (textBlocks.length > 0) {
      multimodal.push({ type: 'text', text: textBlocks.join('') })
    }
    return { prompt: multimodal, processedFiles: processed }
  }

  return {
    prompt: (messageText || '') + textBlocks.join(''),
    processedFiles: processed,
  }
}

import fs from 'node:fs'
import path from 'node:path'
import type { AgentContext } from '../../../core/agent-context/index.js'
import type { FileHandler, ReadOptions, ReadResult } from './interface.js'
import { IMAGE_MIME_TYPES } from '../constants.js'
import { isVisionModelAvailable } from '../utils.js'
import { extractTextWithOCR } from '../ocr.js'

export class ImageHandler implements FileHandler {
  extensions = Object.keys(IMAGE_MIME_TYPES)

  async read(filePath: string, ctx: AgentContext, options?: ReadOptions): Promise<ReadResult> {
    const mode = options?.mode || 'auto'
    const ext = path.extname(filePath).toLowerCase()
    const mimeType = IMAGE_MIME_TYPES[ext]
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
      const ocrResult = await extractTextWithOCR(filePath, options?.language || 'eng+chi_sim', ctx)
      if (!ocrResult.success) {
        throw new Error(ocrResult.output)
      }
      return {
        type: 'image_ocr',
        data: { text: ocrResult.output },
        content: ocrResult.output
      }
    } else {
      const buffer = fs.readFileSync(filePath)
      const base64 = buffer.toString('base64')
      const dataUrl = `data:${mimeType};base64,${base64}`

      const resultData = {
        filename: path.basename(filePath),
        mimeType,
        size: buffer.length,
        dataUrl,
        hasDataUrl: true
      }

      return {
        type: 'image_vision',
        data: resultData,
        content: JSON.stringify(resultData)
      }
    }
  }

  async write(_filePath: string, _data: any, _ctx: AgentContext): Promise<void> {
    throw new Error('Writing images is not supported yet.')
  }
}

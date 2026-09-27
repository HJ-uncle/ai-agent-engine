import fs from 'node:fs'
import path from 'node:path'
import type { AgentContext } from '../../../core/agent-context/index.js'
import type { FileHandler, ReadOptions, ReadResult } from './interface.js'
import { IMAGE_MIME_TYPES } from '../constants.js'
import { isVisionModelAvailable } from '../utils.js'
import { extractTextWithOCR } from '../ocr.js'
import { describeImageWithVisionProxy, isVisionProxyConfigured } from '../vision-proxy.js'

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

    // ── 断链止损：无视觉能力时明确拒绝 vision 模式 ──────────────────────────
    // 转录实证：当模型没有视觉能力、图片也从未真正进入多模态上下文时，
    // 若这里「静默降级」返回 base64，下游适配器又把它替换成 "[Image]"，
    // 模型会陷入「我到底能不能看到图片」的无限自我怀疑，进而去做像素取证
    // （手写 PNG 解码器等）。因此这里必须抛出一个**明确、可读、不可绕过的**错误，
    // 让模型一次撞墙就换路径，而不是反复试探。
    if (mode === 'vision' && !visionAvailable) {
      const model = ctx.modelName || process.env.MODEL_NAME || '当前模型'
      throw new Error(
        `视觉读取不可用：模型 "${model}" 不具备视觉能力（vision=false），无法查看图片像素。\n` +
        `请改用 mode: "ocr" 提取图片中的文字，或直接基于 OCR 结果作答。\n` +
        `不要再次尝试 vision 模式，也不要尝试自行解码图片二进制。`
      )
    }

    // ── 视觉代理：主模型无视觉能力时，请视觉子模型代看 ──────────────────────
    // 这是「断链止损」之上更进一步的处理：与其让模型撞墙后只能拿到 OCR 文本，
    // 不如用具备视觉能力的子模型生成结构化描述，让主模型「间接看到」布局。
    // 仅在 auto 模式下生效（用户显式指定 ocr 时尊重其选择）。
    if (useOcr && mode === 'auto' && isVisionProxyConfigured()) {
      const proxyResult = await describeImageWithVisionProxy(filePath, ctx)
      if (proxyResult.success) {
        return {
          type: 'image_vision_proxy',
          data: { text: proxyResult.output, viaProxy: true },
          content: proxyResult.output,
        }
      }
      // 代理不可用/失败时不中断，继续走 OCR 兜底
      ctx.logger.warn(`[vision-proxy] 回退到 OCR：${proxyResult.output}`)
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

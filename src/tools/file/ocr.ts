import path from 'node:path'
import Tesseract from 'tesseract.js'
import type { AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { isValidImageFile } from './utils.js'

export async function extractTextWithOCR(imagePath: string, language: string, ctx: AgentContext): Promise<ToolResult> {
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

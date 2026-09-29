import fs from 'node:fs'
import path from 'node:path'
import type { AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { IMAGE_MIME_TYPES } from './constants.js'
import { resolveCapabilities } from '../../core/model-capabilities/index.js'

/**
 * 视觉代理（Vision Proxy）
 * ============================================================================
 * 问题背景（转录实证）：
 *   当主模型不具备视觉能力时（如 deepseek-flash），图片**根本进不了**多模态
 *   上下文（adapter 会把 image_url 替换成 "[Image]"）。但模型看到消息里附带了
 *   `image-1.png`，会反复怀疑「我到底能不能看到」，最终陷入手写 PNG 解码器
 *   做像素取证的兔子洞。
 *
 * 解决方案：
 *   用一个**具备视觉能力的子模型**（vision sub-model）去「替主模型看图」，
 *   把图片转成结构化文字描述（布局块 / 缩进 / 间距 / 对齐 / 配色 / 文案），
 *   再作为普通文本注入主模型上下文。主模型虽然自己看不到，但能「间接看到」。
 *
 * 配置：
 *   环境变量 `VISION_PROXY_MODEL`（如 `qwen-vl-max`）启用。
 *   未配置时视觉代理不可用，调用方应回退到 OCR。
 */

/** 视觉代理的默认提示词：面向「界面截图 → 结构化描述」场景 */
const VISION_PROXY_PROMPT = [
  '你是一个界面截图分析助手。请仔细观察这张截图，输出结构化描述，供无法直接查看图片的编程助手使用。',
  '',
  '请按以下结构输出（只描述你**确实看到**的内容，不要推测）：',
  '1. **整体**：这是什么界面/页面，大致分几个区域。',
  '2. **布局结构**：自上而下、自左而右列出各区域，标注它们的相对位置与包含关系。',
  '3. **视觉细节**：各区域的水平缩进/对齐方式（如「左对齐 12px」）、区块间距是否一致、有无明显参差或错位。',
  '4. **配色与边框**：背景色/边框/圆角等可观察到的样式特征。',
  '5. **文案**：逐条列出可见的文字/按钮/标签（保留原文）。',
  '6. **可疑点**：任何看起来「怪怪的」、不一致、错位的地方。',
  '',
  '要求：忠实描述，宁可说「看不出」也不要编造。',
].join('\n')

/**
 * 解析视觉代理使用的模型名。
 * 支持后缀语法 `model:provider`，例如 `qwen-vl-max:qwen`。
 *
 * 优先级：ctx.utilityModel（客户端设置「轻任务模型」，请求级下发）
 *       > env.VISION_PROXY_MODEL（运维侧全局配置）。
 * 两者皆空时视觉代理不启用，调用方回退 OCR。
 */
export function resolveVisionProxyConfig(ctx?: AgentContext): { model: string; provider?: string } | null {
  const raw = ctx?.utilityModel?.trim() || process.env.VISION_PROXY_MODEL?.trim()
  if (!raw) return null
  const [model, provider] = raw.split(':').map((s) => s.trim())
  if (!model) return null
  return { model, provider: provider || undefined }
}

/** 视觉代理是否已配置可用 */
export function isVisionProxyConfigured(ctx?: AgentContext): boolean {
  return resolveVisionProxyConfig(ctx) !== null
}

/**
 * 调用视觉子模型描述图片。
 *
 * @returns 成功时返回 `success: true` 且 output 为结构化描述文本；
 *          未配置 / 调用失败时返回 `success: false` 且 output 为可读原因。
 */
export async function describeImageWithVisionProxy(
  imagePath: string,
  ctx: AgentContext,
): Promise<ToolResult> {
  const config = resolveVisionProxyConfig(ctx)
  if (!config) {
    return {
      success: false,
      output:
        '视觉代理未启用（未配置轻任务模型 / VISION_PROXY_MODEL）。无法通过视觉子模型查看图片，请改用 mode: "ocr"。',
    }
  }

  const ext = path.extname(imagePath).toLowerCase()
  const mime = IMAGE_MIME_TYPES[ext]
  if (!mime) {
    return { success: false, output: `视觉代理不支持的文件格式：${ext || '(无扩展名)'}` }
  }

  // 二次确认：子模型本身必须真的具备视觉能力，否则代理形同虚设
  const subCaps = resolveCapabilities({
    model: config.model,
    provider: config.provider,
  })
  if (subCaps.vision !== true) {
    return {
      success: false,
      output:
        `视觉代理配置的模型 "${config.model}" 经能力注册表判定为**不具备视觉能力**（vision !== true）。\n` +
        `请改用真正支持视觉的模型（如 qwen-vl-max / qwen-vl-plus / gpt-4o），或改用 mode: "ocr"。`,
    }
  }

  try {
    const buffer = fs.readFileSync(imagePath)
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`

    // 延迟导入，避免与 adapter 工厂形成模块循环依赖
    const { createLLMAdapterWithDbConfig } = await import('../../core/llm-adapter/index.js')
    const adapter = await createLLMAdapterWithDbConfig({
      model: config.model,
      provider: config.provider,
      capabilities: { vision: true },
    })

    ctx.logger.info(`[vision-proxy] 使用 "${config.model}" 代理识别图片: ${path.basename(imagePath)}`)

    const response = await adapter.complete(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROXY_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        } as any,
      ],
      { model: config.model, temperature: 0.2 },
    )

    const description = (response.content || '').trim()
    if (!description) {
      return { success: false, output: `视觉代理返回空描述（模型 "${config.model}"）。请改用 mode: "ocr"。` }
    }

    ctx.logger.info(`[vision-proxy] 识别完成，输出 ${description.length} 字符`)

    return {
      success: true,
      output: [
        `📷 **图片视觉描述**（由视觉代理模型 \`${config.model}\` 生成，主模型本身无视觉能力）`,
        '',
        `**文件名**: ${path.basename(imagePath)}`,
        '',
        description,
      ].join('\n'),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.error(`[vision-proxy] 调用失败: ${message}`)
    return {
      success: false,
      output: `视觉代理调用失败：${message}\n请改用 mode: "ocr" 提取图片文字。`,
    }
  }
}

import { z } from 'zod'
import type { Tool } from '../../core/agent-context/types.js'
import { MAX_RESULT_ITEMS } from '../../core/final-result.js'
import { finalResults } from '../../storage/results/index.js'

const schema = z.object({ items: z.array(z.union([
  z.object({ path: z.string().min(1).max(4096), name: z.string().min(1).max(255).optional() }).strict(),
  z.object({ toolCallId: z.string().min(1).max(512), imageIndex: z.number().int().min(0).max(MAX_RESULT_ITEMS - 1).optional(), name: z.string().min(1).max(255).optional() }).strict(),
])).max(MAX_RESULT_ITEMS) }).strict()

export const deliverFilesTool: Tool = {
  name: 'deliver_files', displayName: '登记最终交付文件', executionMode: 'serial',
  description: '显式选择本轮最终交付物/成品图片。仅主代理调用：每项提供已完成真实文件path，或本轮成功工具的toolCallId+imageIndex（图片下标从0起，默认0）；二选一。浏览器截图或生成图片可按工具回执明确选取，不必重写图片字节。保存不可变副本，原文件后续修改/删除不影响交付。最多16项，每项32MiB、合计128MiB。每次调用替换本轮完整清单，items:[]清空。工具成功只是登记，根任务正常完成后才展示。不要登记过程截图、测试日志或中间文件；不会自动选择最后图或改动文件。',
  parameters: { type: 'object', additionalProperties: false, required: ['items'], properties: {
    items: { type: 'array', maxItems: MAX_RESULT_ITEMS, items: { type: 'object', additionalProperties: false,
      oneOf: [{ required: ['path'], not: { required: ['toolCallId'] } }, { required: ['toolCallId'], not: { required: ['path'] } }],
      properties: { path: { type: 'string', minLength: 1, maxLength: 4096 }, toolCallId: { type: 'string', minLength: 1, maxLength: 512 }, imageIndex: { type: 'integer', minimum: 0, maximum: MAX_RESULT_ITEMS - 1 }, name: { type: 'string', minLength: 1, maxLength: 255 } } } },
  } },
  async execute(args, ctx) {
    try {
      const { items } = schema.parse(args)
      const staged = await finalResults.stage(ctx, items)
      return { success: true, output: JSON.stringify({ status: 'staged', items: staged, note: '本轮最终交付清单已替换；正常完成后才对用户展示。' }) }
    } catch (error) {
      return { success: false, output: error instanceof Error ? error.message : '无法登记最终交付文件', metadata: { code: 'FINAL_DELIVERY_FAILED' } }
    }
  },
}

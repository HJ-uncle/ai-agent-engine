import { z } from 'zod'
import type { Tool } from '../../core/agent-context/types.js'
import { MAX_RESULT_ITEMS } from '../../core/final-result.js'
import { finalResults } from '../../storage/results/index.js'

const schema = z.object({ items: z.array(z.union([
  z.object({ path: z.string().min(1).max(4096), name: z.string().min(1).max(255).optional() }).strict(),
  z.object({ toolCallId: z.string().min(1).max(512), imageIndex: z.number().int().min(0).max(MAX_RESULT_ITEMS - 1).optional(), name: z.string().min(1).max(255).optional() }).strict(),
  z.object({ childSessionId: z.string().min(1).max(512), runId: z.string().min(1).max(512), artifactId: z.string().min(1).max(512), name: z.string().min(1).max(255).optional() }).strict(),
])).max(MAX_RESULT_ITEMS) }).strict()

export const deliverFilesTool: Tool = {
  name: 'deliver_files', displayName: '登记最终交付文件', executionMode: 'serial',
  description: '显式选择本轮最终交付物/成品图片。仅主代理调用：每项三选一：已完成真实文件path；本轮成功工具toolCallId+imageIndex；子代理report_artifacts返回的childSessionId+runId+artifactId。采纳子成果使用报告时的不可变字节并保留真实来源，文件后来修改不会冒充原产物。图片下标从0起默认0。最多16项，每项32MiB、合计128MiB。每次调用替换本轮完整清单，items:[]清空。成功只是登记，根任务正常完成后才展示；主代理仍须验收。不要登记过程截图、测试日志或中间文件。',
  parameters: { type: 'object', additionalProperties: false, required: ['items'], properties: {
    items: { type: 'array', maxItems: MAX_RESULT_ITEMS, items: { type: 'object', additionalProperties: false,
      oneOf: [{ required: ['path'], not: { anyOf: [{ required: ['toolCallId'] }, { required: ['artifactId'] }] } },
        { required: ['toolCallId'], not: { anyOf: [{ required: ['path'] }, { required: ['artifactId'] }] } },
        { required: ['childSessionId', 'runId', 'artifactId'], not: { anyOf: [{ required: ['path'] }, { required: ['toolCallId'] }] } }],
      properties: { path: { type: 'string', minLength: 1, maxLength: 4096 }, toolCallId: { type: 'string', minLength: 1, maxLength: 512 },
        childSessionId: { type: 'string', minLength: 1, maxLength: 512 }, runId: { type: 'string', minLength: 1, maxLength: 512 }, artifactId: { type: 'string', minLength: 1, maxLength: 512 },
        imageIndex: { type: 'integer', minimum: 0, maximum: MAX_RESULT_ITEMS - 1 }, name: { type: 'string', minLength: 1, maxLength: 255 } } } },
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

const reportSchema = z.object({ items: z.array(z.object({ path: z.string().min(1).max(4096),
  name: z.string().min(1).max(255).optional(), expectedHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
}).strict()).min(1).max(MAX_RESULT_ITEMS) }).strict()

export const reportArtifactsTool: Tool = {
  name: 'report_artifacts', displayName: '提交子代理成果', executionMode: 'serial',
  description: '执行或通用子代理提交已完成文件供主代理验收。只接受当前授权工作区内真实文件，保存报告时的不可变字节与真实child/run来源；可传expectedHash校验已验证版本。每次报告1至16项，每项32MiB、合计128MiB。返回的items[].assetId即artifactId；将childSessionId、runId、artifactId、用途和验证结果返回主代理，由其deliver_files显式采纳。此操作不是最终发布，不代表父任务已完成；调研角色不可调用。',
  parameters: { type: 'object', additionalProperties: false, required: ['items'], properties: {
    items: { type: 'array', minItems: 1, maxItems: MAX_RESULT_ITEMS, items: { type: 'object', additionalProperties: false,
      required: ['path'], properties: { path: { type: 'string', minLength: 1, maxLength: 4096 },
        name: { type: 'string', minLength: 1, maxLength: 255 }, expectedHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' } } } },
  } },
  async execute(args, ctx) {
    try {
      const { items } = reportSchema.parse(args)
      const report = await finalResults.report(ctx, items)
      return { success: true, output: JSON.stringify({ status: 'reported', ...report,
        note: '候选成果已保存，等待主代理验收与显式采纳；尚未发布。' }) }
    } catch (error) {
      return { success: false, output: error instanceof Error ? error.message : '无法提交子代理成果', metadata: { code: 'CHILD_ARTIFACT_REPORT_FAILED' } }
    }
  },
}

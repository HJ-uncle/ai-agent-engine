import { z } from 'zod'
import type { Tool } from '../../core/agent-context/types.js'
import { MAX_RESULT_ITEMS } from '../../core/final-result.js'
import { finalResults } from '../../storage/results/index.js'
import { TodoStore } from '../../storage/todo/index.js'

const schema = z.object({ items: z.array(z.union([
  z.object({ path: z.string().min(1).max(4096), name: z.string().min(1).max(255).optional() }).strict(),
  z.object({ toolCallId: z.string().min(1).max(512), imageIndex: z.number().int().min(0).max(MAX_RESULT_ITEMS - 1).optional(), name: z.string().min(1).max(255).optional() }).strict(),
  z.object({ childSessionId: z.string().min(1).max(512), runId: z.string().min(1).max(512), artifactId: z.string().min(1).max(512), name: z.string().min(1).max(255).optional() }).strict(),
])).max(MAX_RESULT_ITEMS) }).strict()

export const deliverFilesTool: Tool = {
  name: 'deliver_files', displayName: '登记最终交付文件', executionMode: 'serial',
  description: '仅主代理在完成验收后登记本轮完整成品清单。每项三选一：真实文件path；本轮成功工具toolCallId+imageIndex；子代理report_artifacts返回的childSessionId+runId+artifactId。子成果与工具图片保留不可变字节及真实来源。图片下标从0起默认0。最多16项，每项32MiB、合计128MiB。每次替换完整清单，items:[]清空。成功后只依据证据收尾计划并答复，根任务正常完成才展示；发现具体新缺陷先items:[]撤销，再修复/验收/重登记。直接path源变动使暂存清单过期；后续用户指令可继续修订。不要登记过程截图、测试日志或中间文件。',
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
      let pendingPlan: unknown
      try {
        const saved = await new TodoStore().getPlan(ctx.tenantId, ctx.sessionId)
        const pending = saved.plan.filter(step => step.status === 'pending' || step.status === 'in_progress')
        pendingPlan = { revision: saved.revision, steps: pending.slice(0, 12), omittedSteps: Math.max(0, pending.length - 12) }
      } catch { pendingPlan = { status: 'unavailable' } }
      return { success: true, output: JSON.stringify({ status: 'staged',
        note: staged.length
          ? '完整成品清单已登记，根任务正常完成后展示。现在依据真实证据收尾计划（登记步骤已有本回执证据），然后给最终答复；未完成步骤不得标完成。不要重复编辑或检验。发现具体新缺陷时先用items:[]撤销，修复并验收后重新登记完整清单；源文件变更会使本次登记过期。后续用户的新指令可继续修订。'
          : '本轮交付清单已清空；可继续必要修订，完成验收后重新登记完整成品清单。', pendingPlan, items: staged }) }
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
  description: '执行或通用子代理提交已完成文件供主代理验收。items每项只接受path/name/expectedHash；用途和验证结果写在最终文字回报，不加工具字段。只接受当前授权工作区内真实文件，保存不可变字节与真实child/run来源；expectedHash校验已验证版本。每次1至16项，每项32MiB、合计128MiB。items[].assetId即artifactId；将childSessionId、runId、artifactId返回主代理，由其deliver_files显式采纳。不是最终发布；调研角色不可调用。',
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

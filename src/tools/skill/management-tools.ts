import { z } from 'zod'
import type { Tool, AgentContext, ToolResult, JSONSchema } from '../../core/agent-context/index.js'
import { workspaceManager } from '../../workspace/index.js'
import { createApprovedMutationTool } from '../management/approved-mutation.js'
import { SkillManagementService, skillManagementFailure, skillScopeSchema, type SkillManagementContext } from '../../skills/management-service.js'

const scope: JSONSchema = { type: 'string', enum: ['project', 'global'], description: '项目层或本机全局层；省略时按完整 ID 查找，创建默认 project。' }
const id: JSONSchema = { type: 'string', pattern: '^skill-[a-f0-9]{32}$', description: 'skill_list 返回的完整 ID。' }
const idSchema = z.string().regex(/^skill-[a-f0-9]{32}$/)
function context(ctx: AgentContext): SkillManagementContext {
  if (ctx.parentSessionId) throw new Error('技能管理仅供主代理使用')
  return { tenantId: ctx.tenantId, principal: ctx.managementPrincipal, signal: ctx.signal,
    projectRoot: workspaceManager.getWorkingDirectory(ctx) }
}
function failure(error: unknown): ToolResult {
  const { code, message } = skillManagementFailure(error)
  return { success: false, status: 'failed', output: message, error: message, metadata: { code } }
}

/** Persistent skill configuration; executing a skill remains a separate capability. */
export function createSkillManagementTools(service = new SkillManagementService()): Tool[] {
  const specs: Array<{ action: 'create' | 'update' | 'set_enabled' | 'delete'; name: string; displayName: string; required: string[]; description: string; properties: Record<string, JSONSchema> }> = [
    { action: 'create' as const, name: 'skill_create', displayName: '创建技能', required: ['name', 'description', 'content'],
      description: '创建持久技能。content 为 Markdown 正文；项目路径由当前会话决定。先展示完整配置，等待用户批准。',
      properties: { name: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,119}$' }, description: { type: 'string', maxLength: 500 }, content: { type: 'string', maxLength: 100000 }, scope } },
    { action: 'update' as const, name: 'skill_update', displayName: '编辑技能', required: ['id', 'content', 'expectedHash'],
      description: '仅更新所选技能主文档，保留脚本和附件。先 skill_get，content 提交包含原 name 的完整 SKILL.md，expectedHash 使用读取回执。',
      properties: { id, content: { type: 'string', maxLength: 100000 }, expectedHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, scope } },
    { action: 'set_enabled' as const, name: 'skill_set_enabled', displayName: '启停技能', required: ['id', 'enabled'],
      description: '启用或停用所选层的持久技能，不执行技能脚本。展示目标后等待用户批准。',
      properties: { id, enabled: { type: 'boolean' }, scope } },
    { action: 'delete' as const, name: 'skill_delete', displayName: '删除技能', required: ['id'],
      description: '删除完整 ID 对应的技能目录及当前脚本附件；冻结文件清单后等待批准，目录变化时拒绝继续。', properties: { id, scope } },
  ]
  const mutations = specs.map(spec => createApprovedMutationTool({
    name: spec.name, displayName: spec.displayName, description: spec.description,
    parameters: { type: 'object', additionalProperties: false, required: spec.required, properties: spec.properties },
    prepare: async (raw, ctx) => {
      if (spec.action !== 'create') idSchema.parse((raw as { id?: unknown })?.id)
      return spec.action === 'create' ? service.prepareCreate(context(ctx), raw) : service.prepareChange(context(ctx), spec.action, raw)
    },
    apply: async (operation, ctx) => {
      const result = await service.apply(context(ctx), operation)
      return { success: true, status: 'succeeded', output: JSON.stringify(result), metadata: { resourceChange: result.resourceChange } }
    },
    preview: operation => ({ action: operation.action, id: operation.id, scope: operation.scope, name: operation.name,
      directory: operation.dir, before: operation.before, ...(operation.content === undefined ? {} : { content: operation.content }),
      ...(operation.enabled === undefined ? {} : { enabled: operation.enabled }) }),
  }))
  return [
    { name: 'skill_list', displayName: '技能管理目录', description: '列出可管理的项目与全局技能，包含停用项和完整 ID；不执行技能。',
      parameters: { type: 'object', additionalProperties: false, properties: { scope, search: { type: 'string', maxLength: 200 } } },
      async execute(raw, ctx) {
        try { const input = z.object({ scope: skillScopeSchema.optional(), search: z.string().max(200).optional() }).strict().parse(raw)
          return { success: true, output: JSON.stringify({ skills: service.list(context(ctx), input.scope, input.search) }) }
        } catch (error) { return failure(error) }
      } },
    { name: 'skill_get', displayName: '技能管理详情', description: '读取管理目录中技能的完整主文档、hash 和附件清单，供编辑前核对。',
      parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id, scope } },
      async execute(raw, ctx) {
        try { const input = z.object({ id: idSchema, scope: skillScopeSchema.optional() }).strict().parse(raw)
          return { success: true, output: JSON.stringify(service.get(context(ctx), input.id, input.scope)) }
        } catch (error) { return failure(error) }
      } },
    ...mutations,
  ]
}

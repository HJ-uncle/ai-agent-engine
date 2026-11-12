import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import type { AgentContext, Tool, ToolResult, JSONSchema } from '../core/agent-context/types.js'
import { createApprovedMutationTool } from '../tools/management/approved-mutation.js'
import { PluginService, validatePluginId } from './service.js'
import { PluginImporter, type PluginImportInput } from './importer.js'
import { runPlugin } from './runtime.js'
import { assertPluginManagementAccess } from './access.js'
import { pluginSummary } from './catalogue.js'
import { extensionPolicy } from '../security/tool-policy.js'
import type { CreatePluginInput, PluginRecord } from './types.js'
import { listPluginTemplates } from './templates.js'
import { PLUGIN_CONTRIBUTION_JSON_SCHEMA } from './contributions.js'
import { validatePluginArguments } from './schema.js'
import { resolvePluginCreateInput } from './create-input.js'
import { resolvePluginUpdateInput } from './update-input.js'
import { pluginReadProperties, pluginReadFailure, readManagedPlugin, readPluginTemplate } from './read-tools.js'
import { hasCompactPluginMutationResult, pluginMutationPreview, pluginMutationResult } from './mutation-receipts.js'

const id: JSONSchema = { type: 'string', minLength: 1, maxLength: 48, pattern: '^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$',
  description: '插件 ID；已有插件沿用 plugin_list 返回值。仅小写字母、数字、单连字符，最多48位；例如 currency-converter，不能用 currency_converter。' }
const manifest: JSONSchema = { type: 'object', additionalProperties: false,
  description: '清单。id 使用小写字母/数字/单连字符；本地 tools.name 使用字母/数字/下划线。返回 globalToolNames 和 toolNameMap 是准确调用名：ID 连字符转换为下划线，例如 currency-converter + convert → plugin_currency_converter_convert，总长不超过64。',
  required: ['apiVersion', 'id', 'name', 'version', 'description', 'runtime', 'tools'], properties: {
    apiVersion: { type: 'integer', enum: [1] }, id,
    name: { type: 'string', minLength: 1, maxLength: 120 }, version: { type: 'string', minLength: 1, maxLength: 64 },
    description: { type: 'string', minLength: 1, maxLength: 2000 }, runtime: { type: 'string', enum: ['node'] },
    contributes: PLUGIN_CONTRIBUTION_JSON_SCHEMA,
    tools: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false,
      required: ['name', 'description', 'inputSchema', 'entry'], properties: {
        name: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[a-z][a-z0-9_]{0,31}$', description: '本地工具名，例如 convert_currency；不填全局plugin_前缀。' },
        description: { type: 'string', minLength: 1, maxLength: 4000 },
        inputSchema: { type: 'object', additionalProperties: true, description: '参数JSON Schema，根type必须为object；支持字段类型/required/enum/minimum等，不支持pattern/format/$ref。' },
        entry: { type: 'string', minLength: 1, maxLength: 300, description: 'files中已有的包内相对.mjs入口，例如 main.mjs。' },
      } } },
  } }
const files: JSONSchema = { type: 'object', additionalProperties: { type: 'string' }, description: '相对路径→完整 UTF-8 源码。Node .mjs 从 stdin 读 JSON {tool,args}，stdout 输出一行 JSON {result,artifacts?:[{path,content}]}。只能使用 Node 内置库和包内文件，不自动安装依赖。若已有完整本地工程（根目录有aether-plugin.json），优先 plugin_import_preview({type:"local",path:工程绝对路径}) → plugin_import_install，无需重新读取和复录全部源码。' }
const expectedRevision: JSONSchema = { type: 'integer', minimum: 1, description: 'plugin_get 返回的当前 revision，防止覆盖并发编辑。' }
const testCaseSchema = z.object({ name: z.string().min(1).max(200).optional(), tool: z.string().min(1), args: z.record(z.unknown()), expected: z.unknown().optional() }).strict()
function testCases(input: Record<string, unknown>): { batched: boolean; cases: Array<z.infer<typeof testCaseSchema>> } {
  if (Object.hasOwn(input, 'cases')) {
    if (Object.hasOwn(input, 'tool') || Object.hasOwn(input, 'args')) throw new Error('cases 与 tool/args 互斥，请选择一种测试方式')
    return { batched: true, cases: z.array(testCaseSchema).min(1).max(20).parse(input.cases) }
  }
  return { batched: false, cases: [testCaseSchema.parse({ tool: input.tool, args: input.args })] }
}
function authorize(ctx: AgentContext) {
  if (ctx.parentSessionId) throw new Error('插件管理仅供主代理使用')
  assertPluginManagementAccess(ctx.tenantId, ctx.managementPrincipal)
}
function failure(error: unknown): ToolResult { const message = error instanceof Error ? error.message : String(error); return { success: false, output: message, error: message } }
function ok(value: unknown): ToolResult { return { success: true, output: JSON.stringify(value) } }

export function createPluginManagementTools(service = new PluginService()): Tool[] {
  const importer = new PluginImporter(service)
  const specs: Array<{ name: string; title: string; description: string; required: string[]; properties: Record<string, JSONSchema> }> = [
    { name: 'plugin_create', title: '创建插件', description: '创建可编辑插件草稿。匹配内置模板的需求优先使用 {templateId,id,name?,description?}，例如 {templateId:"currency-converter",id:"my-currency",name:"货币换算器"}；宿主直接复制已验证的完整工程，保留算法和测试，不要复录或重写源码。templateId 是已知模板ID，id 是新插件ID，两者独立；不允许同时提交 manifest/files，不会对未知模板静默回退。先用 plugin_get_template 发现模板和理解协议；只有模板不适用、需要自定义实现时才提交完整 {manifest,files}。随后 plugin_test 验收再 plugin_publish。已有完整本地工程时优先 plugin_import_preview({type:"local",path}) → plugin_import_install。返回精确 globalToolNames/toolNameMap；草稿 selectionId=null，发布后才可选。manifest.contributes 可声明导航、工作区标签、自定义HTML页面及宿主服务；完整能力目录与bridge协议由 plugin_get_template 返回。服务可在页面关闭后继续显示状态，仅在桌面仍打开时调度完成，不支持跨重启后台提醒。', required: [], properties: {
      templateId: { type: 'string', enum: listPluginTemplates().map(template => template.id), description: '从 plugin_get_template 发现的内置模板ID。填写后宿主复制完整实现，无需且禁止传manifest/files；与新插件id不同。' },
      id: { ...id, description: '模板创建时必填的新插件ID，与templateId独立，例如 my-currency；仅小写字母、数字、单连字符。' },
      name: { type: 'string', minLength: 1, maxLength: 120, description: '模板创建时可选的新插件显示名称；省略则沿用模板名称。' },
      description: { type: 'string', minLength: 1, maxLength: 2000, description: '模板创建时可选的插件说明，不改变模板功能或实现。' },
      manifest, files,
    } },
    { name: 'plugin_update', title: '编辑插件', description: '编辑插件并产生新版本，已有发布版继续运行。先读取 plugin_get 获取当前 expectedRevision。默认 fileMode:"replace" 必须提交完整 manifest/files，未提交的文件会移除。推荐局部修改显式使用 fileMode:"merge"：files 仅提供新增/修改文件的完整源码，未列文件保留；manifest 可省略沿用当前完整清单，deleteFiles 可列出要删除的已有路径。id、expectedRevision、files 始终必填。merge 拒绝空操作、删除/写入同路径和版本冲突。审批前将增量解析并校验为完整源码快照，批准后只执行该快照；审批期间插件变化会拒绝，不会重新合并。', required: ['id', 'files', 'expectedRevision'], properties: {
      id, expectedRevision,
      fileMode: { type: 'string', enum: ['replace', 'merge'], description: '省略为 replace（完整替换，必须提供manifest）；merge 仅编辑显式列出的文件，可省略manifest。' },
      manifest: { ...manifest, description: manifest.description + ' replace 模式必填；merge 模式省略时沿用读取修订的完整清单，提供时仍必须是完整清单。' },
      files: { ...files, description: files.description + ' replace 为完整工程；merge 为新增/修改文件，每个值仍是该文件完整内容，不能传补丁片段。' },
      deleteFiles: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 300 }, description: '仅merge可用。要删除的已有包内相对路径，使用准确大小写；不得与files中的写入路径重复。删除后完整工程仍须有效。' },
    } },
    { name: 'plugin_publish', title: '发布插件', description: '发布当前草稿并启用，返回精确 selectionId、globalToolNames 与 toolNameMap。发布后用户可从插件列表打开操作页，按参数字段直接使用。发布前用 plugin_test 验收；发布不会把工具自动加入当前聊天请求范围，也不能靠 load_tools 扩权。用户通过 @ 选择返回的 selectionId 后，后续请求才可调用这些工具；当前管理会话继续用 plugin_test 测试。', required: ['id', 'expectedRevision'], properties: { id, expectedRevision } },
    { name: 'plugin_set_enabled', title: '启停插件', description: '启停已发布插件。停用立即阻止后续调用。', required: ['id', 'enabled'], properties: { id, enabled: { type: 'boolean' } } },
    { name: 'plugin_delete', title: '删除插件', description: '移除插件目录与版本；不删除用户工作区产物。', required: ['id'], properties: { id } },
    { name: 'plugin_test', title: '测试插件', description: '在独立 Node 进程测试草稿，返回结果与产物预览，不写工作区。多用例优先 cases:[{name?,tool,args,expected?}] 一次批准后顺序运行；expected 精确比较业务result，任一失败整体失败。cases 与旧式 tool/args 互斥。不要并行触发多个确认，必须检查业务result，不得发布诊断版。进程不是操作系统沙箱。', required: ['id'], properties: { id, revision: { type: 'integer', minimum: 1 }, tool: { type: 'string' }, args: { type: 'object' },
      cases: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { name: { type: 'string' }, tool: { type: 'string' }, args: { type: 'object' }, expected: {} }, required: ['tool', 'args'], additionalProperties: false } } } },
    { name: 'plugin_import_install', title: '安装插件', description: '安装已预览的不可变导入作业，返回草稿。Remark 适配依赖安装禁用生命周期脚本。随后测试和发布。', required: ['jobId'], properties: { jobId: { type: 'string' } } },
  ]
  const mutations = specs.map(spec => createApprovedMutationTool({
    name: spec.name, displayName: spec.title, description: spec.description,
    parameters: { type: 'object', properties: spec.properties, required: spec.required, additionalProperties: false,
      ...(spec.name === 'plugin_create' ? { oneOf: [
        { required: ['templateId', 'id'], not: { anyOf: [{ required: ['manifest'] }, { required: ['files'] }] } },
        { required: ['manifest', 'files'], not: { anyOf: ['templateId', 'id', 'name', 'description'].map(key => ({ required: [key] })) } },
      ] } : {}),
    },
    async prepare(raw, ctx) {
      authorize(ctx)
      let input = z.record(z.unknown()).parse(raw)
      if (spec.name === 'plugin_create') input = resolvePluginCreateInput(input) as unknown as Record<string, unknown>
      if (spec.name === 'plugin_test' || spec.name === 'plugin_import_install') { const denied = extensionPolicy(ctx); if (denied) throw new Error(denied.output) }
      const record = spec.name === 'plugin_create' || spec.name === 'plugin_import_install' ? undefined : await service.get(ctx.tenantId, validatePluginId(input.id))
      if ((spec.name === 'plugin_update' || spec.name === 'plugin_publish') && record?.revision !== input.expectedRevision) throw new Error('插件版本已变化，请重新读取')
      if (spec.name === 'plugin_update') input = resolvePluginUpdateInput(input, record!) as unknown as Record<string, unknown>
      if (spec.name === 'plugin_set_enabled') z.boolean().parse(input.enabled)
      if (spec.name === 'plugin_test') {
        input.revision = z.number().int().positive().parse(input.revision ?? record?.revision)
        const snapshot = await service.snapshot(ctx.tenantId, String(input.id), Number(input.revision), { allowDraft: true })
        for (const example of testCases(input).cases) {
          const tool = snapshot.manifest.tools.find(tool => tool.name === example.tool)
          if (!tool) throw new Error('插件工具不存在：' + example.tool)
          validatePluginArguments(tool.inputSchema, example.args)
        }
      }
      const job = spec.name === 'plugin_import_install' ? await importer.getImport(ctx.tenantId, z.string().parse(input.jobId)) : undefined
      const preview = pluginMutationPreview(spec.name, spec.title, input, record,
        spec.name === 'plugin_create' || spec.name === 'plugin_update' ? input as unknown as CreatePluginInput : undefined, ctx)
      return { version: 1 as const, tenantId: ctx.tenantId, action: spec.name, input: JSON.parse(JSON.stringify(input)) as Record<string, unknown>,
        ...(record ? { expectedRevision: record.revision, expectedUpdatedAt: record.updatedAt } : {}),
        ...(preview === undefined ? {} : { preview }),
        ...(job ? { source: job.source, requirements: job.requirements } : {}) }
    },
    preview: operation => operation.preview ?? operation,
    async apply(operation, ctx) {
      authorize(ctx)
      if (operation.action !== spec.name) throw new Error('插件批准操作不匹配')
      const input = operation.input
      if (operation.expectedRevision !== undefined) {
        const current = await service.get(ctx.tenantId, String(input.id))
        if (current.revision !== operation.expectedRevision || current.updatedAt !== operation.expectedUpdatedAt) throw new Error('批准期间插件已变化，请重新发起操作')
      }
      let result: unknown
      switch (spec.name) {
        case 'plugin_create': result = await service.create(ctx.tenantId, { manifest: input.manifest, files: input.files } as CreatePluginInput); break
        case 'plugin_update': result = await service.update(ctx.tenantId, String(input.id), { manifest: input.manifest, files: input.files, expectedRevision: input.expectedRevision } as Parameters<PluginService['update']>[2]); break
        case 'plugin_publish': result = await service.publish(ctx.tenantId, String(input.id), Number(input.expectedRevision)); break
        case 'plugin_set_enabled': result = await service.setEnabled(ctx.tenantId, String(input.id), Boolean(input.enabled), operation.expectedRevision); break
        case 'plugin_delete': await service.remove(ctx.tenantId, String(input.id), operation.expectedRevision); result = { deleted: true, id: input.id }; break
        case 'plugin_test': {
          const denied = extensionPolicy(ctx); if (denied) return denied
          const snapshot = await service.snapshot(ctx.tenantId, String(input.id), Number(input.revision), { allowDraft: true })
          const examples = testCases(input)
          if (!examples.batched) { result = await runPlugin(snapshot, examples.cases[0].tool, examples.cases[0].args, { signal: ctx.signal, tenantId: ctx.tenantId }); break }
          const cases: Array<Record<string, unknown>> = []
          for (const [index, example] of examples.cases.entries()) {
            const name = example.name ?? `case-${index + 1}`
            try {
              const output = await runPlugin(snapshot, example.tool, example.args, { signal: ctx.signal, tenantId: ctx.tenantId })
              const passed = !Object.hasOwn(example, 'expected') || isDeepStrictEqual(output.result, example.expected)
              cases.push({ name, tool: example.tool, ...output, passed, ...(passed ? {} : { error: '业务 result 与 expected 不匹配', expected: example.expected }) })
            } catch (error) { cases.push({ name, tool: example.tool, passed: false, error: error instanceof Error ? error.message : String(error) }) }
          }
          const failed = cases.filter(example => !example.passed).length
          const summary = { revision: snapshot.revision, total: cases.length, passed: cases.length - failed, failed, cases }
          return { success: failed === 0, output: JSON.stringify(summary), ...(failed ? { error: `${failed} 个插件测试用例失败，请检查业务结果后修复再发布` } : {}) }
        }
        case 'plugin_import_install': {
          const denied = extensionPolicy(ctx); if (denied) return denied
          result = await importer.installImport(ctx.tenantId, String(input.jobId), ctx.signal); break
        }
      }
      const resourceChange = spec.name === 'plugin_test' ? undefined : { kind: 'plugin', action: spec.name.slice(7), id: (result as { id?: string })?.id ?? input.id }
      const response = hasCompactPluginMutationResult(spec.name) ? pluginMutationResult(spec.name, result as PluginRecord, ctx) : ok(result)
      return { ...response, ...(resourceChange ? { metadata: { ...response.metadata, resourceChange } } : {}) }
    },
  }))
  return [
    { name: 'plugin_get_template', displayName: '插件工程模板', description: '只读发现标准模板和真实工程协议；大结果返回紧凑目录，不截断源码。无id发现模板，传id读模板；用section:manifest读精确清单JSON，section:file+file读原始源码，section:protocol+protocol读uiBridge/uiTheme/download等单字段，section:contributions读完整能力目录。分页返回content/offset/nextOffset/totalChars/revision，连续拼接content至nextOffset=null，续读携带同一revision；不要猜未读取的协议或源码。匹配模板时用plugin_create({templateId:模板id,id:新插件id})由宿主复用完整工程，不必复录。desktop-timer不支持跨重启提醒。',
      parameters: { type: 'object', properties: { id: { type: 'string', description: '模板 ID：json-tool、markdown-report、time-calculator、currency-converter、desktop-timer；省略则发现模板及读取公共协议。' }, ...pluginReadProperties }, additionalProperties: false },
      async execute(raw, ctx) { try { authorize(ctx); return readPluginTemplate(raw, ctx) } catch (error) { return pluginReadFailure(error, ctx) } } },
    { name: 'plugin_list', displayName: '插件目录', description: '列出本租户插件，包括草稿、停用插件和发布版本；返回准确 globalToolNames/toolNameMap、selectionId 与 publishedSelectionId。selectionId 只对应当前已发布修订，草稿为null。发布不会自动扩大当前请求的工具范围。', parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_raw, ctx) { try { authorize(ctx); return ok({ plugins: (await service.list(ctx.tenantId)).map(pluginSummary) }) } catch (error) { return failure(error) } } },
    { name: 'plugin_get', displayName: '插件详情', description: '只读本租户插件；大结果返回文件目录与读取提示。编辑前用section:manifest读精确清单JSON、section:file+file读所需原始源码、section:metadata读准确globalToolNames/toolNameMap和发布选择ID。每页返回content/offset/nextOffset/totalChars/revision；连续拼接content至nextOffset=null，续读固定revision，版本变化明确报错。不能把目录当完整源码重写。section:protocol+protocol可读uiBridge/uiTheme/download等协议。小结果保持完整详情。', parameters: { type: 'object', properties: { id, ...pluginReadProperties }, required: ['id'], additionalProperties: false },
      async execute(raw, ctx) { try { authorize(ctx); return await readManagedPlugin(service, raw, ctx) } catch (error) { return pluginReadFailure(error, ctx) } } },
    { name: 'plugin_import_preview', displayName: '预览插件导入', description: '检查原生插件或GitHub Remark插件，不执行插件。支持 {type:"local",path}、{type:"zip",path或base64}、{type:"github",repository:"https://github.com/owner/repo",ref?,subdirectory?,format:"native"或"remark"}；原生包需要 aether-plugin.json。已生成本地工程时，传工程绝对路径预览后用 plugin_import_install(jobId) 安装，避免逐个读回并复录源码；随后 plugin_test、plugin_publish。返回jobId用于安装。',
      parameters: { type: 'object', required: ['type'], properties: { type: { type: 'string', enum: ['local', 'zip', 'github'] }, path: { type: 'string' }, base64: { type: 'string' }, repository: { type: 'string' }, ref: { type: 'string' }, subdirectory: { type: 'string' }, format: { type: 'string', enum: ['native', 'remark'] } } },
      async execute(raw, ctx) { try { authorize(ctx); const job = await importer.previewImport(ctx.tenantId, raw as PluginImportInput, ctx.signal); const { files: _files, ...summary } = job; return ok(summary) } catch (error) { return failure(error) } } },
    ...mutations,
  ]
}

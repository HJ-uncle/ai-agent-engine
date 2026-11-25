import { z } from 'zod'
import type { JSONSchema } from '../core/agent-context/types.js'

const text = z.string().min(1).max(4096)
const MAX_PLUGIN_IMAGE_URL_CHARS = 12 * 1024 * 1024 + 256
const MAX_PLUGIN_IMAGE_TOTAL_CHARS = 16 * 1024 * 1024

const pluginImageUrlSchema = z.string().max(MAX_PLUGIN_IMAGE_URL_CHARS).regex(
  /^(?:https:\/\/[^\s]{1,4096}|data:image\/(?:png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/]+={0,2})$/,
  '只支持 HTTPS 图片地址或受大小限制的 image/* Base64 data URL',
)

const pluginAIContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(1_000_000) }).strict(),
  z.object({ type: z.literal('image_url'), image_url: z.object({
    url: pluginImageUrlSchema,
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }).strict() }).strict(),
])
export type PluginAIContentPart = z.infer<typeof pluginAIContentPartSchema>

const pluginAIMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(pluginAIContentPartSchema).min(1).max(32)]),
}).strict()
export type PluginAIMessage = z.infer<typeof pluginAIMessageSchema>

const pluginAIMessagesSchema = z.array(pluginAIMessageSchema).max(100).superRefine((messages, ctx) => {
  let imageChars = 0
  for (const [index, message] of messages.entries()) {
    if (!Array.isArray(message.content)) continue
    for (const [partIndex, part] of message.content.entries()) {
      if (part.type !== 'image_url') continue
      imageChars += part.image_url.url.length
      if (imageChars > MAX_PLUGIN_IMAGE_TOTAL_CHARS) {
        ctx.addIssue({ code: z.ZodIssueCode.too_big, type: 'array', maximum: MAX_PLUGIN_IMAGE_TOTAL_CHARS,
          inclusive: true, exact: false, path: [index, 'content', partIndex, 'image_url', 'url'],
          message: '单次 AI 请求的图片内容总量过大' })
        return
      }
    }
  }
})

export const noCapabilityArgs = z.object({}).strict()

export const pluginAgentConfigurationSchema = z.object({
  identity: z.object({ name: z.string().trim().min(1).optional(), description: z.string().trim().min(1).optional() }).strict().optional(),
  systemPrompt: z.string().optional(),
  skillIds: z.array(text).optional(),
  mcpServerIds: z.array(text).optional(),
  disabledTools: z.array(z.string().min(1)).optional(),
  customTools: z.array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/), tool: z.string().min(1) }).strict()).optional(),
}).strict()
export type PluginAgentConfiguration = z.infer<typeof pluginAgentConfigurationSchema>
export const pluginAgentToolsArgsSchema = pluginAgentConfigurationSchema
export const pluginAgentRunArgsSchema = pluginAgentConfigurationSchema.extend({
  modelId: z.string().min(1).max(256), task: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(), resumeRunId: z.string().uuid().optional(),
  thinking: z.boolean().optional().describe('仅控制本次 Agent 调用是否启用模型思考；续跑省略时继承原调用。'),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional().describe('本次 Agent 调用的推理力度；模型不支持时按适配器兼容策略处理。'),
  temperature: z.number().finite().min(0).max(2).optional().describe('本次 Agent 调用的采样温度，范围 0–2。'),
  maxTokens: z.number().int().positive().max(1_000_000).optional().describe('本次 Agent 调用的最大输出 token 数；实际值仍受模型上下文与任务预算限制。'),
}).strict()

/** One argument contract for SDK dispatch and the tools shown to plugin Agents. */
export const PLUGIN_AGENT_CAPABILITY_METHODS = {
  'models.read': {
    list: noCapabilityArgs.describe('列出已启用模型；将返回的 id 作为 modelId 使用。'),
  },
  'ai.run': {
    run: z.object({
      modelId: text.describe('平台已配置模型的 id 或 modelId。'),
      prompt: z.string().optional().describe('本次用户输入；prompt 与 messages 至少提供一个非空输入。'),
      messages: pluginAIMessagesSchema.optional().describe('支持纯文本消息，或 text/image_url 内容块；图片仅支持 HTTPS 或受限 Base64 data URL。'),
      systemPrompt: z.string().optional(),
      maxTokens: z.number().int().positive().optional(),
      thinking: z.boolean().optional().describe('仅控制本次调用是否启用模型思考；省略时继承模型配置。'),
      reasoningEffort: z.enum(['low', 'medium', 'high']).optional().describe('本次调用的推理力度；模型不支持时由适配器按兼容策略处理。'),
      temperature: z.number().finite().min(0).max(2).optional().describe('采样温度，范围 0–2；模型不支持时由适配器按兼容策略处理。'),
      responseFormat: z.enum(['text', 'json']).optional().describe('请求模型返回普通文本或 JSON 对象；返回值仍是 text 字符串。'),
    }).strict().describe('单次 AI 分析，不执行工具；返回 text、model、usage。thinking、推理力度和采样参数只对本次调用生效。'),
  },
  'session.read': {
    messages: z.object({
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().positive().default(50),
      ids: z.array(text).optional().describe('按消息 ID 选择；提供时使用 ids，不使用 offset 和 limit 分页。'),
    }).strict().describe('读取绑定会话，返回 messages、total、nextOffset；nextOffset 非空时可继续分页。'),
  },
  'skills.read': {
    list: noCapabilityArgs.describe('列出可用技能，返回 skills。'),
    get: z.object({ id: text }).strict().describe('读取技能说明，返回 id、name、content；不执行技能脚本。'),
  },
  'workspace.read': {
    list: z.object({ path: text.default('.') }).strict().describe('列出绑定工作区的目录，返回 entries；路径相对工作区。'),
    read: z.object({ path: text.default('.') }).strict().describe('读取文本文件，返回 path、content、size；路径相对工作区。'),
  },
  'workspace.write': {
    write: z.object({ path: text, content: z.string() }).strict()
      .describe('在绑定工作区写入文本，自动创建父目录；覆盖已有文件。返回 path、written。'),
  },
  'knowledge.read': {
    list: noCapabilityArgs.describe('列出知识库，返回 bases。'),
    search: z.object({ query: z.string().min(1), limit: z.number().int().positive().default(5), knowledgeBaseIds: z.array(text).optional() }).strict()
      .describe('检索知识库，返回 results；可用 knowledgeBaseIds 限定范围。'),
    get: z.object({ id: text }).strict().describe('按文档 id 读取知识库文档。'),
  },
  'knowledge.write': {
    create: z.object({ filename: text, content: z.string().min(1), knowledgeBaseId: text.optional() }).strict()
      .describe('创建文本知识库文档；可指定 knowledgeBaseId。'),
    update: z.object({ id: text, content: z.string().min(1), expectedRevision: z.number().int().min(1).optional() }).strict()
      .describe('更新已有知识库文档；expectedRevision 可防止覆盖并发修改。'),
  },
  'mcp.read': {
    list: noCapabilityArgs.describe('列出已启用 MCP 服务器，返回 servers；不包含凭据。'),
    tools: z.object({ serverId: text }).strict().describe('读取指定已启用 MCP 服务器的可用工具，返回 tools，包含 name、description、inputSchema；不包含停用工具。'),
  },
  'mcp.invoke': {
    call: z.object({ serverId: text, tool: text, arguments: z.record(z.unknown()).default({}) }).strict()
      .describe('调用已启用服务器中的已知工具；arguments 必须符合该 MCP 工具的参数定义。返回 output。'),
  },
  'settings.read': {
    get: noCapabilityArgs.describe('读取当前插件设置，返回设置对象。'),
  },
  'settings.write': {
    set: z.object({ value: z.record(z.unknown()) }).strict().describe('用 value 替换当前插件设置，返回保存的设置对象。'),
  },
} as const

export type PluginAgentCapability = keyof typeof PLUGIN_AGENT_CAPABILITY_METHODS

export function agentCapabilityMethods(capability: string): Readonly<Record<string, z.AnyZodObject>> | undefined {
  return Object.hasOwn(PLUGIN_AGENT_CAPABILITY_METHODS, capability)
    ? PLUGIN_AGENT_CAPABILITY_METHODS[capability as PluginAgentCapability] : undefined
}

/** This intentionally supports only contract types above; new types must add a checked projection. */
function argumentJsonSchema(schema: z.ZodTypeAny): JSONSchema {
  let result: JSONSchema
  if (schema instanceof z.ZodOptional) result = argumentJsonSchema(schema.unwrap())
  else if (schema instanceof z.ZodDefault) result = { ...argumentJsonSchema(schema.removeDefault()), default: schema._def.defaultValue() }
  else if (schema instanceof z.ZodEffects) result = argumentJsonSchema(schema.innerType())
  else if (schema instanceof z.ZodLiteral) result = { const: schema.value }
  else if (schema instanceof z.ZodUnion) result = { anyOf: schema.options.map((option: z.ZodTypeAny) => argumentJsonSchema(option)) }
  else if (schema instanceof z.ZodDiscriminatedUnion) result = { oneOf: [...schema.options.values()].map(option => argumentJsonSchema(option)) }
  else if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>
    result = { type: 'object', properties: Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, argumentJsonSchema(field)])),
      required: Object.entries(shape).filter(([, field]) => !field.isOptional()).map(([key]) => key), additionalProperties: false }
  } else if (schema instanceof z.ZodString) {
    result = { type: 'string', ...(schema.minLength !== null ? { minLength: schema.minLength } : {}), ...(schema.maxLength !== null ? { maxLength: schema.maxLength } : {}) }
    for (const check of schema._def.checks) {
      if (check.kind === 'regex') Object.assign(result, { pattern: check.regex.source })
    }
  } else if (schema instanceof z.ZodNumber) {
    result = { type: schema.isInt ? 'integer' : 'number' }
    for (const check of schema._def.checks) {
      if (check.kind === 'min') Object.assign(result, check.inclusive ? { minimum: check.value } : { exclusiveMinimum: check.value })
      if (check.kind === 'max') Object.assign(result, check.inclusive ? { maximum: check.value } : { exclusiveMaximum: check.value })
    }
  } else if (schema instanceof z.ZodBoolean) result = { type: 'boolean' }
  else if (schema instanceof z.ZodArray) {
    result = { type: 'array', items: argumentJsonSchema(schema.element),
      ...(schema._def.minLength ? { minItems: schema._def.minLength.value } : {}), ...(schema._def.maxLength ? { maxItems: schema._def.maxLength.value } : {}) }
  } else if (schema instanceof z.ZodEnum) result = { type: 'string', enum: schema.options }
  else if (schema instanceof z.ZodRecord) result = { type: 'object', additionalProperties: argumentJsonSchema(schema.valueSchema) }
  else if (schema instanceof z.ZodUnknown) result = {}
  else throw new Error('Unsupported plugin capability argument contract type')
  return schema.description ? { ...result, description: schema.description } : result
}

/** Keep provider-compatible object roots and describe each method's arguments under args. */
export function agentCapabilityToolParameters(methods: Readonly<Record<string, z.AnyZodObject>>): JSONSchema {
  const variants = Object.entries(methods).map(([method, args]) => ({
    type: 'object', properties: { method: { type: 'string', enum: [method] }, args: argumentJsonSchema(args) },
    required: ['method', 'args'], additionalProperties: false,
  }))
  if (variants.length === 1) return variants[0]
  // Some providers reject root-level unions. Runtime dispatch selects and validates
  // the exact method contract; each nested branch tells the model which method uses it.
  return { type: 'object', properties: { method: { type: 'string', enum: Object.keys(methods) },
    args: { anyOf: Object.entries(methods).map(([method, args]) => ({ ...argumentJsonSchema(args), description: `method=${method}：${args.description ?? ''}` })) } },
    required: ['method', 'args'], additionalProperties: false }
}

/** Validation feedback may contain expectations, never rejected values or unrecognized keys. */
export function pluginAgentArgumentError(error: z.ZodError): string {
  const details = error.issues.slice(0, 5).map(issue => {
    const location = issue.path.map(part => typeof part === 'number' ? `[${part}]` : /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(part) ? part : '[字段]').join('.') || '参数'
    switch (issue.code) {
      case 'invalid_type': return `${location}：需要 ${issue.expected} 类型`
      case 'too_small': return `${location}：${issue.type === 'number' ? '值' : '长度/数量'}至少为 ${issue.minimum}`
      case 'too_big': return `${location}：${issue.type === 'number' ? '值' : '长度/数量'}最多为 ${issue.maximum}`
      case 'unrecognized_keys': return `${location}：不支持额外字段`
      case 'invalid_enum_value': return `${location}：必须使用参数定义中的枚举值`
      default: return `${location}：不符合工具参数定义`
    }
  })
  return `工具参数无效：${details.join('；')}。请按当前 method 的参数定义修正后重试。`
}

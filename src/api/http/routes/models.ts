import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ModelsStore } from '../../../storage/sqlite/models.js'
import { success, fail } from '../response.js'
import { createLLMAdapter } from '../../../core/llm-adapter/factory.js'
import { resolveCapabilities, type ModelCapabilities } from '../../../core/model-capabilities/index.js'

// ── Helpers ──────────────────────────────────────────────────────────────────
const getTenantId = (req: FastifyRequest) => (req as any).authContext?.tenantId ?? 'default'

// Simple check for internal IP to prevent SSRF
function isPrivateIP(ip: string): boolean {
  return /^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.|127\.|localhost)/.test(ip) || ip.startsWith('::1') || ip.startsWith('fd00:') || ip.startsWith('fe80:')
}

function isValidEndpoint(url: string): boolean {
  try {
    const parsedUrl = new URL(url)
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') return false
    if (isPrivateIP(parsedUrl.hostname)) return false
    return true
  } catch {
    return false
  }
}

// Ensure the endpoint matches https://.../v1/chat/completions or valid custom endpoint format
function isValidChatCompletionsEndpoint(url: string): boolean {
  return isValidEndpoint(url)
}

// Helper to check admin role
function requireAdmin(authContext: any): boolean {
  if (process.env.AUTH_ENABLED === 'false' || authContext?.method === 'none') return true
  // For demo/simplicity, if roles includes 'admin' or if it's not set but AUTH_ENABLED is false
  return authContext?.roles?.includes('admin') || false
}

export async function modelsRoutes(fastify: FastifyInstance) {
  const store = new ModelsStore()

  // 1. GET /api/v1/models/whitelist
  fastify.get('/api/v1/models/whitelist', async (request, reply) => {
    const whitelists = await store.getWhitelists()
    return reply.code(200).send(success(whitelists))
  })

  // 2. GET /api/v1/models
  fastify.get('/api/v1/models', async (request, reply) => {
    const tenantId = getTenantId(request)
    const models = await store.getModels(tenantId)
    // Mask API keys；capabilities 与内置规则合并后再返回——DB 里存的是创建时的
    // 快照（可能缺 contextWindow 等后加字段），纯直出会让读取方永远拿不到新字段。
    const safeModels = models.map(m => ({
      ...m,
      capabilities: resolveCapabilities({
        model: m.modelId,
        baseUrl: m.baseUrl,
        provider: m.provider,
        dbOverrides: (m.capabilities ?? null) as Partial<ModelCapabilities> | null
      }),
      apiKey: m.apiKey ? `...${m.apiKey.slice(-4)}` : ''
    }))
    return reply.code(200).send(success(safeModels))
  })

  // 3. POST /api/v1/models
  fastify.post<{ Body: { provider: string; modelId: string; apiKey: string; baseUrl: string; displayName?: string; version?: string; capabilities?: ModelCapabilities } }>(
    '/api/v1/models',
    async (request, reply) => {
      const authContext = (request as any).authContext
      if (!requireAdmin(authContext)) {
        return reply.code(403).send(fail(40300, 'Forbidden: Admin role required'))
      }
      const tenantId = getTenantId(request)
      const { provider, modelId, apiKey, baseUrl, displayName, version, capabilities } = request.body

      // Validation
      if (!isValidChatCompletionsEndpoint(baseUrl)) {
        return reply.code(400).send(fail(40001, 'Invalid base URL. Private IP or invalid format.'))
      }
      if (!apiKey || apiKey.length < 16) {
        return reply.code(400).send(fail(40001, 'API key must be at least 16 characters long.'))
      }


      try {
        const newModel = await store.createModel({
          tenantId,
          provider,
          modelId,
          apiKey,
          baseUrl,
          displayName,
          isEnabled: false,
          version,
          capabilities: capabilities ?? null,
        })
        return reply.code(200).send(success({
          ...newModel,
          apiKey: `...${newModel.apiKey.slice(-4)}`
        }))
      } catch (err: any) {
        return reply.code(500).send(fail(50000, err.message))
      }
    }
  )

  // 4. PUT /api/v1/models/:id
  fastify.put<{ Params: { id: string }, Body: { isEnabled?: boolean; apiKey?: string; baseUrl?: string; displayName?: string; version?: string; capabilities?: ModelCapabilities | null } }>(
    '/api/v1/models/:id',
    async (request, reply) => {
      const authContext = (request as any).authContext
      if (!requireAdmin(authContext)) {
        return reply.code(403).send(fail(40300, 'Forbidden: Admin role required'))
      }
      const tenantId = getTenantId(request)
      const { id } = request.params
      const data = request.body

      if (data.baseUrl && !isValidChatCompletionsEndpoint(data.baseUrl)) {
        return reply.code(400).send(fail(40001, 'Invalid base URL.'))
      }
      if (data.apiKey && data.apiKey.length < 16 && !data.apiKey.startsWith('...')) {
        return reply.code(400).send(fail(40001, 'API key must be at least 16 characters long.'))
      }

      // If masked key is sent, ignore it
      const updateData = { ...data }
      if (updateData.apiKey?.startsWith('...')) {
        delete updateData.apiKey
      }

      const updated = await store.updateModel(id, tenantId, updateData)
      if (!updated) {
        return reply.code(404).send(fail(40400, 'Model not found.'))
      }
      return reply.code(200).send(success({
        ...updated,
        apiKey: `...${updated.apiKey.slice(-4)}`
      }))
    }
  )

  // 5. DELETE /api/v1/models/:id
  fastify.delete<{ Params: { id: string } }>(
    '/api/v1/models/:id',
    async (request, reply) => {
      const authContext = (request as any).authContext
      if (!requireAdmin(authContext)) {
        return reply.code(403).send(fail(40300, 'Forbidden: Admin role required'))
      }
      const tenantId = getTenantId(request)
    const { id } = request.params
    await store.deleteModel(id, tenantId)
    return reply.code(200).send(success({ id }))
  })

  // 6. POST /api/v1/models/{id}/test
  fastify.post<{ Params: { id: string }, Body?: { provider?: string, modelId?: string, apiKey?: string, baseUrl?: string } }>('/api/v1/models/:id/test', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const { id } = request.params
    
    // Allows testing before saving by passing temporary key/url
    let model = await store.getModelById(id, tenantId)
    if (!model && id !== 'new') {
      return reply.code(404).send(fail(40400, 'Model not found.'))
    }

    let apiKey = request.body?.apiKey || model?.apiKey || ''
    let baseUrl = request.body?.baseUrl || model?.baseUrl || ''
    let provider = request.body?.provider || model?.provider || 'openai' // default to openai adapter for custom testing
    let modelId = request.body?.modelId || model?.modelId || 'test'

    // Use a short timeout for test
    try {
      const start = Date.now()
      const adapter = createLLMAdapter({
        provider,
        model: modelId,
        apiKey,
        baseUrl
      })
      
      const response = await adapter.complete([
        { role: 'user', content: 'Say "hello" and nothing else.' }
      ])
      
      const latency = Date.now() - start
      
      return reply.code(200).send(success({
        latency,
        thinkingSupported: !!response.reasoningContent,
        success: true
      }))
    } catch (err: any) {
      return reply.code(200).send(success({
        success: false,
        error: err.message
      }))
    }
  })

  // 7. POST /api/v1/models/detect-capabilities
  // 基于内置规则推断模型能力（用于"添加模型"对话框预填）
  fastify.post<{ Body: { provider?: string; modelId: string; baseUrl?: string } }>(
    '/api/v1/models/detect-capabilities',
    async (request, reply) => {
      const { provider, modelId, baseUrl } = request.body
      if (!modelId) return reply.code(400).send(fail(40001, 'modelId is required'))
      const caps = resolveCapabilities({ model: modelId, baseUrl, provider })
      return reply.code(200).send(success(caps))
    }
  )

  // 8. GET /api/v1/models/capability-defs
  // 能力元数据（key/label/desc/icon）—— 供前端渲染开关 UI
  fastify.get('/api/v1/models/capability-defs', async (_req, reply) => {
    return reply.code(200).send(success(CAPABILITY_DEFS))
  })
}

/** 能力元数据：前端渲染开关时使用 */
const CAPABILITY_DEFS: Array<{
  key: keyof ModelCapabilities
  label: string
  description: string
  icon: string
  group: 'multimodal' | 'reasoning' | 'protocol' | 'optimization'
}> = [
  { key: 'vision',        label: '图像理解',     description: '支持 image_url 多模态输入（图片）', icon: '🖼️', group: 'multimodal' },
  { key: 'video',         label: '视频理解',     description: '支持视频帧序列输入',                icon: '🎬', group: 'multimodal' },
  { key: 'audio',         label: '音频理解',     description: '支持音频文件输入',                  icon: '🎙️', group: 'multimodal' },
  { key: 'thinking',      label: '推理模式',     description: '支持 reasoning_content 推理内容输出', icon: '🧠', group: 'reasoning' },
  { key: 'toolCalling',   label: '工具调用',     description: '支持 Function Calling / Tool Use', icon: '🔧', group: 'protocol' },
  { key: 'parallelTools', label: '并行工具',     description: '单次响应内并行调用多个工具',        icon: '⚡', group: 'protocol' },
  { key: 'jsonMode',      label: 'JSON 输出',    description: '支持 response_format=json_object', icon: '📦', group: 'protocol' },
  { key: 'search',        label: '联网搜索',     description: '内置 enable_search 网络搜索能力',  icon: '🌐', group: 'protocol' },
  { key: 'caching',       label: 'KV Cache',     description: '支持 prompt 缓存命中（计费折扣）', icon: '💾', group: 'optimization' },
  { key: 'streamUsage',   label: '流式 Usage',   description: 'stream 时附带 usage 字段',         icon: '📊', group: 'optimization' },
  { key: 'prefix',        label: '前缀续写',     description: '支持 assistant prefix 续写补全',   icon: '✍️', group: 'protocol' },
]

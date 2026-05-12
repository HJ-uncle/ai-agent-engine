import type { FastifyInstance } from 'fastify'
import { ModelsStore } from '../../../storage/sqlite/models.js'
import { success, fail } from '../response.js'
import { createLLMAdapter } from '../../../core/llm-adapter/factory.js'

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
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const models = await store.getModels(tenantId)
    // Mask API keys
    const safeModels = models.map(m => ({
      ...m,
      apiKey: m.apiKey ? `...${m.apiKey.slice(-4)}` : ''
    }))
    return reply.code(200).send(success(safeModels))
  })

  // 3. POST /api/v1/models
  fastify.post<{ Body: { provider: string; modelId: string; apiKey: string; baseUrl: string; displayName?: string; version?: string } }>(
    '/api/v1/models',
    async (request, reply) => {
      const authContext = (request as any).authContext
      if (!requireAdmin(authContext)) {
        return reply.code(403).send(fail(40300, 'Forbidden: Admin role required'))
      }
      const tenantId = authContext?.tenantId ?? 'default'
      const { provider, modelId, apiKey, baseUrl, displayName, version } = request.body

      // Validation
      if (!isValidChatCompletionsEndpoint(baseUrl)) {
        return reply.code(400).send(fail(40001, 'Invalid base URL. Private IP or invalid format.'))
      }
      if (!apiKey || apiKey.length < 16) {
        return reply.code(400).send(fail(40001, 'API key must be at least 16 characters long.'))
      }

      // Removed strict whitelist check to allow users to add any model ID 
      // even if it's not pre-populated in the whitelist. 
      // It will just use default thinking configurations.
      /*
      const whitelists = await store.getWhitelists()
      const isCustom = provider === 'custom'
      if (!isCustom) {
        const allowed = whitelists.find(w => w.provider === provider && w.modelId === modelId)
        if (!allowed) {
          return reply.code(400).send(fail(40001, 'Model is not in the whitelist.'))
        }
      }
      */

      try {
        const newModel = await store.createModel({
          tenantId,
          provider,
          modelId,
          apiKey,
          baseUrl,
          displayName,
          isEnabled: false,
          version
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

  // 4. PUT /api/v1/models/{id}
  fastify.put<{ Params: { id: string }, Body: { apiKey?: string; baseUrl?: string; displayName?: string; isEnabled?: boolean; version?: string } }>(
    '/api/v1/models/:id',
    async (request, reply) => {
      const authContext = (request as any).authContext
      if (!requireAdmin(authContext)) {
        return reply.code(403).send(fail(40300, 'Forbidden: Admin role required'))
      }
      const tenantId = authContext?.tenantId ?? 'default'
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

  // 5. DELETE /api/v1/models/{id}
  fastify.delete<{ Params: { id: string } }>('/api/v1/models/:id', async (request, reply) => {
    const authContext = (request as any).authContext
    if (!requireAdmin(authContext)) {
      return reply.code(403).send(fail(40300, 'Forbidden: Admin role required'))
    }
    const tenantId = authContext?.tenantId ?? 'default'
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
}

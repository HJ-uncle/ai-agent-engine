import Fastify from 'fastify'
import { v4 as uuidv4 } from 'uuid'
import { logger } from '../../observability/index.js'
import { createAuthMiddleware } from '../../auth/index.js'
import { chatRoutes } from './routes/chat.js'
import { memoryRoutes } from './routes/memory.js'
import { conversationRoutes } from './routes/conversation.js'
import { taskRoutes } from './routes/tasks.js'
import { toolRoutes } from './routes/tools.js'
import { metricsRoutes } from './routes/metrics.js'
import { mcpRoutes } from './routes/mcp.js'
import { knowledgeRoutes } from './routes/knowledge.js'
import { messagesRoutes } from './routes/messages.js'
import { agentRoutes } from './routes/agents.js'
import { workspaceRoutes } from './routes/workspace.js'
import { settingsRoutes } from './routes/settings.js'
import { modelsRoutes } from './routes/models.js'
import { globalRequestMiddleware, WHITELIST_PATHS } from './middleware.js'
import { fail } from './response.js'

export async function buildServer() {
  const fastify = Fastify({
    logger: false, // Use pino directly
    genReqId: () => uuidv4(),
    bodyLimit: 100 * 1024 * 1024, // 100MB，支持大文件上传
  })

  const authMiddleware = createAuthMiddleware()

  // Apply unified request header validation and whitelist
  fastify.addHook('onRequest', globalRequestMiddleware)

  // Request logging and auth hook
  fastify.addHook('onRequest', async (request, reply) => {
    // skip auth if in whitelist
    if (WHITELIST_PATHS.includes(request.url)) return

    const reqLogger = logger.child({ requestId: request.id })
    reqLogger.info({ method: request.method, url: request.url }, 'Incoming request')

    // Authenticate
    try {
      const authContext = await authMiddleware.authenticate({
        headers: request.headers as Record<string, string | string[] | undefined>,
      })
      ;(request as unknown as { authContext: typeof authContext }).authContext = authContext
    } catch (err) {
      // Only reject if auth is enabled
      if (process.env.AUTH_ENABLED !== 'false') {
        await reply.code(200).send(fail(40100, err instanceof Error ? err.message : 'Unauthorized'))
      }
    }
  })

  // Global error handler
  fastify.setErrorHandler((error, request, reply) => {
    logger.error({ err: error, requestId: request.id }, 'Unhandled error')
    // All errors should return 200 with standard fail JSON
    void reply.code(200).send(fail(error.statusCode ?? 50000, error.message ?? 'Internal server error'))
  })

  // Register routes under /api/v1
  await fastify.register(async (api) => {
    await api.register(chatRoutes)
    await api.register(memoryRoutes)
    await api.register(conversationRoutes)
    await api.register(taskRoutes)
    await api.register(toolRoutes)
    await api.register(mcpRoutes)
    await api.register(knowledgeRoutes)
    await api.register(messagesRoutes)
    await api.register(agentRoutes)
    await api.register(workspaceRoutes)
    await api.register(settingsRoutes)
  }, { prefix: '/api/v1' })

  // Health and metrics at root level
  await fastify.register(metricsRoutes)
  await fastify.register(modelsRoutes)

  return fastify
}

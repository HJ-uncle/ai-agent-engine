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

export async function buildServer() {
  const fastify = Fastify({
    logger: false, // Use pino directly
    genReqId: () => uuidv4(),
  })

  const authMiddleware = createAuthMiddleware()

  // Request logging and auth hook
  fastify.addHook('onRequest', async (request, reply) => {
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
        await reply.code(401).send({ error: err instanceof Error ? err.message : 'Unauthorized' })
      }
    }
  })

  // Global error handler
  fastify.setErrorHandler((error, request, reply) => {
    logger.error({ err: error, requestId: request.id }, 'Unhandled error')
    void reply.code(error.statusCode ?? 500).send({
      error: error.message ?? 'Internal server error',
      code: error.code,
    })
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
  }, { prefix: '/api/v1' })

  // Health and metrics at root level
  await fastify.register(metricsRoutes)

  return fastify
}

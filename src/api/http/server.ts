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
import { terminalRoutes } from './routes/terminal.js'
import { settingsRoutes } from './routes/settings.js'
import { modelsRoutes } from './routes/models.js'
import { todoRoutes } from './routes/todos.js'
import { cronRoutes } from './routes/cron.js'
import { sessionRoutes } from './routes/sessions.js'
import { securityRoutes } from './routes/security.js'
import { lspRoutes } from './routes/lsp.js'
import { performanceRoutes } from './routes/performance.js'
import { deepseekRoutes } from './routes/deepseek.js'
import { cronScheduler } from '../../scheduler/cron-scheduler.js'
import { globalRequestMiddleware, WHITELIST_PATHS } from './middleware.js'
import fastifyWebsocket from '@fastify/websocket'
import fastifyMultipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
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
  fastify.setErrorHandler(async (error, request, reply) => {
    const err = error as Error & { statusCode?: number }
    logger.error({ err, requestId: request.id }, 'Unhandled error')
    
    // In production, mask internal error details
    const isProd = process.env.NODE_ENV === 'production'
    const message = isProd && (err.statusCode === undefined || err.statusCode >= 500)
      ? 'Internal server error'
      : err.message || 'Unknown error'

    // All errors should return 200 with standard fail JSON
    return reply.code(200).send(fail(err.statusCode ?? 50000, message))
  })

  // WebSocket 插件（终端路由依赖，必须在路由注册前完成）
  await fastify.register(fastifyWebsocket)
  await fastify.register(fastifyMultipart, { limits: { fileSize: 100 * 1024 * 1024 } })

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
    // 终端路由：POST /api/v1/terminal/create, WS /api/v1/terminal/ws/:id
    await api.register(terminalRoutes)
    await api.register(settingsRoutes)
    await api.register(todoRoutes)
    await api.register(cronRoutes)
    await api.register(sessionRoutes)
    await api.register(securityRoutes)
    await api.register(lspRoutes)
    await api.register(performanceRoutes)
    await api.register(deepseekRoutes)
  }, { prefix: '/api/v1' })

  // Health and metrics at root level
  await fastify.register(metricsRoutes)
  await fastify.register(modelsRoutes)

  // 启动定时任务调度器
  cronScheduler.start()

  // 静态文件：托管前端构建产物（SPA 单页应用）
  const publicDir = process.env.PUBLIC_DIR || join(process.cwd(), 'public')
  if (existsSync(publicDir)) {
    await fastify.register(fastifyStatic, {
      root: publicDir,
      wildcard: false,
      prefix: '/',
    })
    // SPA 回退：所有非 /api/ 路径根据 UA 或路径前缀返回对应的 HTML
    fastify.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/ws')) {
        return reply.code(404).send({ code: 40400, message: 'Not found' })
      }
      
      // 1. 如果路径以 /m 开头，返回移动端入口
      if (request.url === '/m' || request.url.startsWith('/m/')) {
        return reply.sendFile('m.html')
      }

      // 2. 如果 User-Agent 是移动端且访问根路径，也返回移动端入口
      const ua = request.headers['user-agent'] || ''
      const isMobile = /android|iphone|ipod|blackberry|webos|windows phone|iemobile|opera mini|mobile/i.test(ua)
      if (request.url === '/' && isMobile) {
        return reply.sendFile('m.html')
      }

      // 3. 其他情况返回桌面端入口
      return reply.sendFile('index.html')
    })
  }

  return fastify
}

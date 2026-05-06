// TODO: LLM response caching is not implemented for streaming (SSE) endpoints.
// For non-streaming complete() calls, a cache layer could be added here keyed on
// (message, sessionId, systemPrompt) to avoid redundant LLM roundtrips.
import type { FastifyInstance } from 'fastify'
import { v4 as uuidv4 } from 'uuid'
import { ReActStrategy } from '../../../core/agent-loop/index.js'
import { createPipeline, sseStream } from '../../../core/stream-pipeline/index.js'
import { createAgentContext, Message } from '../../../core/agent-context/index.js'
import { SQLiteConversationHistory } from '../../../storage/conversation/index.js'
import { createLLMAdapterWithDbConfig } from '../../../core/llm-adapter/index.js'
import { createRequestLogger, QALogger, type QALogEntry } from '../../../observability/index.js'
import { buildSkillsSystemPrompt } from '../../../skills/index.js'
import { createToolRegistry } from '../../../tools/registry-factory.js'
import { SQLiteAgentStore } from '../../../storage/agent/index.js'
import { SessionStore } from '../../../storage/session/index.js'
import { estimateTokens } from '../../../core/utils/tokens.js'
import { searchChunks } from '../../../storage/knowledge/kb-repo.js'
import { ModelsStore } from '../../../storage/sqlite/models.js'

interface ChatBody {
  message: string
  sessionId?: string
  agentId?: string
  systemPrompt?: string
  maxAskUserCount?: number
  thinkingMode?: boolean
  inheritContext?: boolean
  workspacePaths?: string[]
  toolResponse?: { toolCallId: string, name: string, output: string }
  attachments?: Array<{ name: string; content: string; type: string; encoding?: 'utf-8' | 'base64' }>
  ragTopK?: number
}

// ── 全局会话级 AbortController 注册表 ──────────────────────────────────────────
// 用于支持前端通过 POST /chat/cancel 主动终止某个会话的流式生成。
// key = `${tenantId}:${sessionId}`，value = 当前正在运行的 AbortController。
// 同一会话同时只允许有一个流（新流开始前会先 abort 旧流）。
const activeChatAborters = new Map<string, AbortController>()

function makeAbortKey(tenantId: string, sessionId: string): string {
  return `${tenantId}:${sessionId}`
}

export function registerActiveChat(tenantId: string, sessionId: string, controller: AbortController) {
  const key = makeAbortKey(tenantId, sessionId)
  // 如果已有同会话的旧流，先终止它
  const prev = activeChatAborters.get(key)
  if (prev && !prev.signal.aborted) {
    try { prev.abort(new Error('Superseded by a new chat request')) } catch { /* noop */ }
  }
  activeChatAborters.set(key, controller)
}

export function unregisterActiveChat(tenantId: string, sessionId: string, controller: AbortController) {
  const key = makeAbortKey(tenantId, sessionId)
  // 仅当注册的还是同一个 controller 时才删除（避免误删后续新流）
  if (activeChatAborters.get(key) === controller) {
    activeChatAborters.delete(key)
  }
}

export function abortActiveChat(tenantId: string, sessionId: string, reason = 'User cancelled'): boolean {
  const key = makeAbortKey(tenantId, sessionId)
  const controller = activeChatAborters.get(key)
  if (!controller || controller.signal.aborted) return false
  try { controller.abort(new Error(reason)) } catch { /* noop */ }
  activeChatAborters.delete(key)
  return true
}

export async function chatRoutes(fastify: FastifyInstance) {
  // Initialize agent store
  const agentStore = new SQLiteAgentStore()

  // ── 取消正在运行的会话 ────────────────────────────────────────────────────
  // POST /chat/cancel  body: { sessionId }
  // 即使前端 SSE 连接异常未触发 close，前端也可主动调用此接口终止后端运行。
  fastify.post<{ Body: { sessionId?: string } }>('/chat/cancel', async (request, reply) => {
    const { sessionId } = request.body ?? {}
    if (!sessionId) {
      return reply.code(400).send({ code: 40001, message: 'sessionId is required', data: null, timestamp: Date.now() })
    }
    const tenantId = (request as unknown as { authContext?: { tenantId: string } }).authContext?.tenantId ?? 'default'
    const cancelled = abortActiveChat(tenantId, sessionId, 'Cancelled by user via /chat/cancel')
    return reply.code(200).send({
      code: 200,
      message: cancelled ? 'OK' : 'No active chat for this session',
      data: { sessionId, cancelled },
      timestamp: Date.now(),
    })
  })

  fastify.post<{ Body: ChatBody }>('/chat', async (request, reply) => {
    const requestId = uuidv4()
    const { message, sessionId = uuidv4(), agentId, systemPrompt, maxAskUserCount, thinkingMode, inheritContext = true, workspacePaths, toolResponse, attachments, ragTopK = 3 } = request.body

    // Get tenant from auth context (set by auth middleware)
    const tenantId = (request as unknown as { authContext?: { tenantId: string } }).authContext?.tenantId ?? 'default'
    const reqLogger = createRequestLogger(requestId, tenantId, sessionId)

    // ── 会话 Agent 锁定校验 ────────────────────────────────────────────────────
    // 会话一旦发送过第一条消息，就锁定绑定的 agentId，后续不允许切换。
    const sessionStore = new SessionStore()
    const boundAgentId = await sessionStore.getBoundAgentId(sessionId, tenantId)

    let effectiveAgentId = agentId ?? null

    if (boundAgentId === undefined) {
      // 首次请求：绑定当前 agentId（可为 null）
      await sessionStore.bindAgent(sessionId, tenantId, effectiveAgentId)
      reqLogger.info({ sessionId, agentId: effectiveAgentId }, 'Session agent binding created')
    } else {
      // 已有绑定记录：强制使用绑定的 agentId，忽略请求中的 agentId
      if (boundAgentId !== effectiveAgentId) {
        reqLogger.warn(
          { sessionId, requestedAgentId: effectiveAgentId, boundAgentId },
          'Agent switch rejected: session already bound to an agent. Using bound agentId.'
        )
      }
      effectiveAgentId = boundAgentId
    }

    // Apply agent configuration if provided
    let effectiveSystemPrompt = systemPrompt
    let effectiveModel: string | undefined = undefined
    let effectiveTemperature: number | undefined = undefined
    let allowedSkills: string[] | null = null
    let allowedMcpServers: string[] | null = null
    let boundKnowledgeBases: string[] | null = null
    let allowedTools: string[] | null = null

    if (effectiveAgentId) {
      const agent = await agentStore.getById(effectiveAgentId, tenantId)
      if (agent) {
        effectiveSystemPrompt = systemPrompt ?? agent.systemPrompt
        effectiveModel = agent.model
        effectiveTemperature = agent.temperature
        allowedSkills = agent.skills
        allowedMcpServers = agent.mcpServers
        boundKnowledgeBases = agent.knowledgeBases
        // allowedTools 语义：
        //   undefined / null = 未配置 Agent，加载全部工具
        //   []              = Agent 明确未选择任何工具，禁用全部
        //   ['tool_a', ...] = 只允许指定工具
        allowedTools = agent.allowedTools
      } else {
        reqLogger.warn({ agentId }, 'Agent not found, falling back to defaults')
      }
    }

    // Build tool registry（统一工厂，含所有内置工具 + MCP + Skills）
    const { registry, memory, externalSkills, toolCategories } = await createToolRegistry({ allowedSkills, allowedTools })

    const abortController = new AbortController()
    // 注册到全局表，使 POST /chat/cancel 能找到并终止
    registerActiveChat(tenantId, sessionId, abortController)

    // ── 客户端断开检测：去掉 destroyed 守卫，close 事件触发即视为断开 ───────
    // 之前的 `if (request.raw.destroyed)` 守卫导致部分场景（如 fetch.abort()）
    // 不会触发 abort，后端继续跑导致用户 token 浪费。
    let aborted = false
    const onClientClose = () => {
      if (aborted) return
      aborted = true
      reqLogger.info({ sessionId }, 'Client connection closed, aborting agent execution')
      try { abortController.abort(new Error('Client disconnected')) } catch { /* noop */ }
      unregisterActiveChat(tenantId, sessionId, abortController)
    }
    request.raw.on('close', onClientClose)
    request.raw.on('aborted', onClientClose)

    // Build agent context
    const ctx = createAgentContext({
      sessionId,
      tenantId,
      workspacePaths,
      tools: registry,
      memory,
      history: new SQLiteConversationHistory(),
      logger: reqLogger,
      requestId,
      signal: abortController.signal,
      inheritContext,
    })

    const skillsPrompt = buildSkillsSystemPrompt(externalSkills)
    const baseSystemPrompt = [effectiveSystemPrompt, skillsPrompt].filter(Boolean).join('\n\n')

    // 从 message 中提取纯文本用于 RAG 搜索
    function extractPlainText(msg: any): string {
      if (typeof msg === 'string') return msg
      if (Array.isArray(msg)) {
        return msg
          .filter((part: any) => part.type === 'text' && typeof part.text === 'string')
          .map((part: any) => part.text)
          .join(' ')
      }
      return ''
    }

    // RAG
    let ragChunks: any[] = []
    const plainTextQuery = extractPlainText(message)
    if (boundKnowledgeBases && boundKnowledgeBases.length > 0) {
      // Search only in bound KBs
      ragChunks = await searchChunks(tenantId, plainTextQuery, ragTopK)
    } else {
      ragChunks = await searchChunks(tenantId, plainTextQuery, ragTopK)
    }
    
    let ragPrompt = ''
    if (ragChunks.length > 0) {
      const context = ragChunks
        .map((c, i) => `[${i + 1}] (from: ${c.filename})\n${c.content}`)
        .join('\n\n')
      ragPrompt = `\n\n---\n# Relevant Knowledge Base Context\n\nUse the following retrieved context to answer the user's question:\n\n${context}\n---`
    }
    const currentModelName = effectiveModel ?? process.env.LLM_PRIMARY_MODEL ?? process.env.LLM_MODEL ?? '当前配置 of AI'
    
    // Check thinking mode support
    let finalThinkingConfig: Record<string, unknown> | null = null
    let finalResponseThinkingField: string | null = null
    let modelApiKey: string | undefined = undefined
    let modelBaseUrl: string | undefined = undefined
    let modelProvider: string | undefined = undefined
    // 实际传给 LLM adapter 的 model 名（当 DB 配置不可用时，回退到 env 的 primaryModel）
    let resolvedModel: string | undefined = effectiveModel

    const modelsStore = new ModelsStore()
    const availableModels = await modelsStore.getModels(tenantId)
    const modelInfo = availableModels.find(m => m.modelId === currentModelName)
    const whitelists = await modelsStore.getWhitelists()
    const whitelistInfo = whitelists.find(m => m.modelId === currentModelName)

    if (modelInfo) {
      if (modelInfo.apiKey) {
        // apiKey 正常 → 使用 DB 完整配置（agent model 优先级最高）
        modelApiKey = modelInfo.apiKey
        if (modelInfo.baseUrl) modelBaseUrl = modelInfo.baseUrl
        if (modelInfo.provider) modelProvider = modelInfo.provider
        reqLogger.info({ model: currentModelName, provider: modelInfo.provider, hasApiKey: true, baseUrl: modelInfo.baseUrl }, 'Using model config from DB (agent model takes priority)')
      } else {
        // apiKey 解密失败 → DB 配置不可用，model 名也一起回退到 env primaryModel
        // 避免 agent model 名 + env endpoint 不匹配（如 qwen3.5-plus 发到 fp8 endpoint → 404）
        const envPrimaryModel = process.env.LLM_PRIMARY_MODEL ?? process.env.LLM_MODEL
        resolvedModel = envPrimaryModel  // 回退到 env 的 model 名
        reqLogger.warn(
          { agentModel: currentModelName, fallbackModel: envPrimaryModel, baseUrl: modelInfo.baseUrl },
          'Model found in DB but apiKey is empty (decryption failed or key not set). Falling back to env model+config. Please re-enter the API Key in Models management page.'
        )
      }
    } else {
      reqLogger.warn(
        { model: currentModelName, fallbackBaseUrl: process.env.OPENAI_BASE_URL ? 'env:OPENAI_BASE_URL' : 'none' },
        'Model not found in DB, falling back to env variables. If 401 errors occur, please add the model config in the Models management page.'
      )
    }

    // 判断是否是 Qwen 系列模型（通过模型名或 baseUrl 识别）
    const effectiveBaseUrl = modelBaseUrl || process.env.OPENAI_BASE_URL || ''
    const isQwenModel =
      /qwen|qwq/i.test(currentModelName) ||
      /qwen|qwq/i.test(effectiveBaseUrl)

    if (thinkingMode) {
      if (isQwenModel) {
        // Qwen 系列使用专用 thinking 参数
        finalThinkingConfig = { enable_thinking: true }
        finalResponseThinkingField = 'reasoning_content'
        reqLogger.info({ model: currentModelName, baseUrl: effectiveBaseUrl }, 'Qwen model detected, using enable_thinking API')
      } else if (whitelistInfo && whitelistInfo.thinkingMode) {
        finalThinkingConfig = whitelistInfo.thinkingConfig
        finalResponseThinkingField = whitelistInfo.responseThinkingField
        reqLogger.info({ model: currentModelName, thinkingConfig: finalThinkingConfig }, 'Thinking mode enabled via whitelist')
      } else {
        reqLogger.warn({ model: currentModelName }, 'Thinking mode requested but model not found in whitelist and not Qwen, thinking disabled')
      }
    }

    // 注入工作区路径信息，让 AI 知道所有绑定的工作区
    const { workspaceManager } = await import('../../../workspace/index.js')
    const allWorkspacePaths = workspaceManager.getPaths({ tenantId, sessionId, workspacePaths })
    const workspaceInfo = allWorkspacePaths.length > 1
      ? `\n\n当前会话绑定了以下工作区路径：\n${allWorkspacePaths.map((p, i) => `  ${i === 0 ? '主工作区' : '自定义工作区'}: ${p}`).join('\n')}\n调用 \`list_files\` 工具（不传参数）可查看所有工作区内容。`
      : `\n\n当前工作区路径：${allWorkspacePaths[0]}`

    const fullSystemPrompt = baseSystemPrompt + ragPrompt + `
---
# Rules
1. Use \`ask_user\` to clarify intent or confirm actions.
2. Use Chinese tool names in replies (e.g. 写入文件, not write_file).
3. You are ${currentModelName}.
4. Use \`read_image\` for image files (.png/.jpg/.gif/.webp).
${workspaceInfo}
`

    // ── Estimate token counts for each injected prompt section ──────────
    // systemPromptTokens: pure system prompt (excluding RAG context)
    const pureSystemPrompt = baseSystemPrompt + `
---
# Rules
1. Use \`ask_user\` to clarify intent or confirm actions.
2. Use Chinese tool names in replies (e.g. 写入文件, not write_file).
3. You are ${currentModelName}.
4. Use \`read_image\` for image files (.png/.jpg/.gif/.webp).
${workspaceInfo}
`
    const systemPromptTokens = estimateTokens(pureSystemPrompt)
    const ragTokens = estimateTokens(ragPrompt)
    const skillTokens = estimateTokens(skillsPrompt)

    // Tool definitions: estimate separately for builtin vs MCP
    const allToolsList = registry.list()
    const builtinToolNames = new Set(toolCategories.builtinTools)
    const mcpToolNames = new Set(toolCategories.mcpTools)
    const builtinToolDefsText = allToolsList.filter(t => builtinToolNames.has(t.name))
      .map(t => `${t.name}: ${t.description} ${JSON.stringify(t.parameters ?? {})}`)
      .join('\n')
    const mcpToolDefsText = allToolsList.filter(t => mcpToolNames.has(t.name))
      .map(t => `${t.name}: ${t.description} ${JSON.stringify(t.parameters ?? {})}`)
      .join('\n')
    const builtinToolsTokens = estimateTokens(builtinToolDefsText)
    const mcpToolsTokens = estimateTokens(mcpToolDefsText)
    const systemToolsTokens = builtinToolsTokens + mcpToolsTokens

    const conversationId = uuidv4()
    let assistantResponse = ''
    let reasoningContent = ''
    let finalUsage: any = null

    async function* runAgent(): AsyncIterable<string> {
      try {
        if (toolResponse) {
          const toolMsg: Message & { conversationId?: string } = {
            id: uuidv4(),
            role: 'tool',
            content: `用户选择了: ${toolResponse.output}`,
            toolCallId: toolResponse.toolCallId,
            toolName: toolResponse.name,
            createdAt: Date.now(),
            tokens: estimateTokens(toolResponse.output),
            conversationId,
          }
          await ctx.history.append(toolMsg, ctx)
        }

        // 提取消息中的纯文本部分（message 可能是数组格式）
        const messageText = extractPlainText(message)

        let prompt: string | any[] | null = messageText || null
        if (!toolResponse && attachments && attachments.length > 0) {
          const imageAttachments = attachments.filter(a => a.type.startsWith('image/'))
          const otherAttachments = attachments.filter(a => !a.type.startsWith('image/'))

          let promptText = messageText

          // 图片：已上传到 workspace，提示 AI 用 read_image 工具读取（不传 base64，避免消息体过大）
          if (imageAttachments.length > 0) {
            const imageList = imageAttachments.map(a => `- ${a.name}`).join('\n')
            promptText = `${messageText}\n\n[用户上传了以下图片到工作区，请使用 read_image 工具读取后回答：]\n${imageList}`
          }

          // 非图片文件：已上传到 workspace，提示 AI 用 read_file 工具读取（不内嵌内容，避免消息体过大）
          if (otherAttachments.length > 0) {
            const fileList = otherAttachments.map(a => `- ${a.name}`).join('\n')
            promptText = `${promptText}\n\n[用户上传了以下文件到工作区，请使用 read_file 工具读取后回答：]\n${fileList}`
          }

          prompt = promptText
        }

        const llm = await createLLMAdapterWithDbConfig({ 
          model: resolvedModel,   // agent model 优先；DB 配置不可用时回退 env primaryModel
          apiKey: modelApiKey, 
          baseUrl: modelBaseUrl, 
          provider: modelProvider 
        })
        const strategy = new ReActStrategy(llm, {
          systemPrompt: fullSystemPrompt || undefined,
          temperature: effectiveTemperature,
          maxAskUserCount,
          conversationId,
          promptBreakdown: { systemPromptTokens, systemToolsTokens, skillTokens, ragTokens, builtinToolsTokens, mcpToolsTokens },
          thinkingConfig: finalThinkingConfig,
          responseThinkingField: finalResponseThinkingField,
          // 原始前端消息格式（含 workspace_image），存入 DB 供刷新后正确渲染
          // LLM 用 prompt（文本化），DB/UI 用 displayContent（原始格式）
          displayContent: message || null,
        })
        const pipeline = createPipeline([])

        const generator = pipeline.pipe(strategy.run(prompt, ctx))
        for await (const chunk of generator) {
          if (chunk.startsWith('\x00__thinking__')) {
            reasoningContent += chunk.replace('\x00__thinking__', '')
          } else if (chunk.startsWith('\x00__usage__')) {
            try {
              const usageStr = chunk.replace('\x00__usage__', '')
              finalUsage = JSON.parse(usageStr)
            } catch (e) {
              reqLogger.error({ err: e, chunk }, 'Failed to parse usage chunk')
            }
          } else if (!chunk.startsWith('\x00')) {
            assistantResponse += chunk
          }
          yield chunk
        }

        // Fetch history and tool calls from history to include in the log
        const fullHistory = await (ctx.history as any).getByConversationId(conversationId, tenantId)
        const sessionHistory = await ctx.history.getHistory(ctx)
        
        // Exclude the current conversation's messages from the "historical" list to avoid duplication
        const historicalMessages = sessionHistory.filter(m => {
          const isCurrentInHistory = fullHistory.some((curr: any) => curr.id === m.id)
          return !isCurrentInHistory
        }).map(m => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          tokens: m.tokens
        }))

        const toolCalls: QALogEntry['toolCalls'] = []
        
        // Match assistant tool calls with their tool results
        for (const msg of fullHistory) {
          if (msg.role === 'assistant' && msg.toolCall) {
            const resultMsg = fullHistory.find((m: any) => m.role === 'tool' && m.toolCallId === msg.toolCall?.id)
            toolCalls.push({
              name: msg.toolCall.name,
              arguments: msg.toolCall.args,
              output: typeof resultMsg?.content === 'string' ? resultMsg.content : JSON.stringify(resultMsg?.content ?? ''),
              success: !(typeof resultMsg?.content === 'string' ? resultMsg.content : JSON.stringify(resultMsg?.content ?? '')).includes('[Error:')
            })
          }
        }

        // Log the completed Q&A
        QALogger.getInstance().log({
          sessionId,
          conversationId,
          requestId,
          tenantId,
          userMessage: message,
          assistantResponse,
          reasoningContent: reasoningContent || undefined,
          history: historicalMessages,
          toolCalls,
          usage: finalUsage,
          createdAt: Date.now()
        })
      } catch (err: any) {
        reqLogger.error({ err, agentId }, 'Agent execution error')
        yield `\n\n[System Error: ${err.message || String(err)}]`
      }
    }

    reqLogger.info({ message: typeof message === 'string' ? message.slice(0, 100) : 'Multimodal message', agentId }, 'Chat request received')

    try {
      await sseStream(runAgent(), reply)
    } finally {
      // 流结束（正常完成 / 出错 / abort）都要从注册表清理
      unregisterActiveChat(tenantId, sessionId, abortController)
    }
    return reply
  })
}

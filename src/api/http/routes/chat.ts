// TODO: LLM response caching is not implemented for streaming (SSE) endpoints.
// For non-streaming complete() calls, a cache layer could be added here keyed on
// (message, sessionId, systemPrompt) to avoid redundant LLM roundtrips.
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { v4 as uuidv4 } from 'uuid'
import { ReActStrategy } from '../../../core/agent-loop/index.js'
import { createPipeline, sseStream } from '../../../core/stream-pipeline/index.js'
import { createAgentContext, Message } from '../../../core/agent-context/index.js'
import { SQLiteConversationHistory } from '../../../storage/conversation/index.js'
import { createLLMAdapterWithDbConfig } from '../../../core/llm-adapter/index.js'
import { createRequestLogger, QALogger, type QALogEntry } from '../../../observability/index.js'
import { buildSkillsSystemPrompt } from '../../../skills/index.js'
import { createToolRegistry } from '../../../tools/registry-factory.js'
import { prependBootstrapToSystemPrompt } from '../../../core/superpower-bootstrap.js'
import { SQLiteAgentStore } from '../../../storage/agent/index.js'
import { SessionStore } from '../../../storage/session/index.js'
import { estimateTokens } from '../../../core/utils/tokens.js'
import { searchChunks } from '../../../storage/knowledge/kb-repo.js'
import { ModelsStore } from '../../../storage/sqlite/models.js'
import { resolveCapabilities, loadDbCapabilityOverrides } from '../../../core/model-capabilities/index.js'

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
  /**
   * 请求级模型覆盖（可选）
   * 优先级：body.model > agent.model > env.LLM_PRIMARY_MODEL
   * 用于桌面客户端等需要按会话即时切换模型的场景。
   */
  model?: string
  /**
   * 请求级 LLM 凭证覆盖（可选 —— 桌面客户端把自己的 model 配置直接下发，
   * agent-engine 以最高优先级使用这些凭证，避免去自身 DB / .env 取过期 key）
   *
   * 优先级：body.modelApiKey > DB.apiKey > env.OPENAI_API_KEY
   * 当三者均空时由对应 LLM 适配器自身报错。
   */
  modelApiKey?: string
  modelBaseUrl?: string
  /** provider 短名：'deepseek' | 'openai' | 'qwen' | 'anthropic' | 'openrouter' | ... */
  modelProvider?: string
  /**
   * 模型能力 override（可选；最高优先级，覆盖内置规则和 db override）
   * 用于陌生模型或 SDK/API 调用方明确告知模型能力。
   * 例：{ vision: true, toolCalling: true, thinking: false }
   */
  capabilities?: {
    vision?: boolean
    video?: boolean
    audio?: boolean
    thinking?: boolean
    toolCalling?: boolean
    jsonMode?: boolean
    search?: boolean
    caching?: boolean
    parallelTools?: boolean
    streamUsage?: boolean
    prefix?: boolean
  }

  // ────────────────────────────────────────────────────────────────────────
  // 项目资源透传（请求级；以最高优先级覆盖 agent-store / env 默认）
  // 所有字段均可选，未传时走原有 agent-store / env fallback —— 旧调用方零影响。
  // ────────────────────────────────────────────────────────────────────────
  /** Skill ID 白名单：覆盖 agent.skills */
  skills?: string[]
  /** MCP server ID 白名单：覆盖 agent.mcpServers */
  mcpServers?: string[]
  /** 知识库 ID 白名单：覆盖 agent.knowledgeBases */
  knowledgeBases?: string[]
  /** 工具白名单：覆盖 agent.allowedTools */
  allowedTools?: string[]
  /**
   * Skill 完整内联 payload（含 SKILL.md 内容）
   * 当本地 SKILLS_ROOT 没有同 ID 的 skill 时，这些 inlineSkills 会被拼接到
   * systemPrompt 的"外部技能能力"章节，让 LLM 即时知晓能力描述。
   * 注意：这些 inline skill 不会真正注册为可调用工具，仅做能力告知；
   * 若需调用真实工具实现，需配合 SKILLS_ROOT 同步（待 Phase 2）。
   */
  inlineSkills?: Array<{
    id: string
    name: string
    description?: string
    version?: string
    promptContent?: string
    skillPath?: string
  }>
  /**
   * MCP server 完整内联配置
   * Phase 1 仅记录到日志做诊断；Phase 2 计划支持运行时临时挂载。
   */
  inlineMcpServers?: Array<{
    id: string
    name: string
    description?: string
    transportType: 'stdio' | 'sse' | 'http' | 'streamableHttp'
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
    headers?: Record<string, string>
  }>
  /**
   * Agent 完整内联配置
   * 当 agentId 未在 agent-engine DB 中找到（或客户端不希望预注册）时，
   * 用 inlineAgent 提供 name / systemPrompt / variables / knowledgeBaseIds 即时生效。
   */
  inlineAgent?: {
    name: string
    description?: string
    systemPrompt?: string
    variables?: Array<{ name: string; value: string }>
    knowledgeBaseIds?: string[]
    agentId?: string
  }
  /**
   * 客户端透传的知识库文档元数据（id / title / sourceType / chunkCount / scope / tags）。
   * agent-engine 端会把这份列表渲染成 systemPrompt 中的"客户端可用知识库"章节，
   * 让 LLM 至少能感知客户端项目里有哪些 KB 文档存在；不携带正文，节省 prompt 容量。
   */
  inlineKnowledgeBases?: Array<{
    id: string
    title: string
    sourceType?: string
    chunkCount?: number
    scope?: string
    scopeId?: string
    tags?: string[]
  }>
  /**
   * 客户端透传的用户长期记忆 XML（已经是 <userMemories>...</userMemories> 形态）。
   * agent-engine 收到后整段拼接到 systemPrompt 末尾，
   * 让 LLM 在跨引擎模式下也能看见用户在 端积累的记忆。
   */
  inlineMemoriesXml?: string
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

// ── Helpers ──────────────────────────────────────────────────────────────────
const getTenantId = (req: FastifyRequest) => (req as any).authContext?.tenantId ?? 'default'

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
    const tenantId = getTenantId(request)
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
    const { message, sessionId = uuidv4(), agentId, systemPrompt, maxAskUserCount, thinkingMode, inheritContext = true, workspacePaths, toolResponse, attachments, ragTopK = 3, model: requestedModel, modelApiKey: requestedApiKey, modelBaseUrl: requestedBaseUrl, modelProvider: requestedProvider, capabilities: requestedCapabilities, skills: requestedSkills, mcpServers: requestedMcpServers, knowledgeBases: requestedKnowledgeBases, allowedTools: requestedAllowedTools, inlineSkills: requestedInlineSkills, inlineMcpServers: requestedInlineMcpServers, inlineAgent: requestedInlineAgent, inlineKnowledgeBases: requestedInlineKnowledgeBases, inlineMemoriesXml: requestedInlineMemoriesXml } = request.body

    // Get tenant from auth context (set by auth middleware)
    const tenantId = getTenantId(request)
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

    // ── inlineAgent 兜底：当客户端未在 DB 注册 agent 但本地有自定义 agent 配置时 ─
    // 用 inlineAgent 提供的字段补齐 effectiveSystemPrompt / boundKnowledgeBases。
    // 优先级：body.systemPrompt > agent.systemPrompt > inlineAgent.systemPrompt > 空
    // 关键约束：仅在对应"上层"字段为空时才生效，绝不覆盖 DB agent 已有配置。
    if (requestedInlineAgent) {
      if (!effectiveSystemPrompt && requestedInlineAgent.systemPrompt) {
        effectiveSystemPrompt = requestedInlineAgent.systemPrompt
      }
      if ((!boundKnowledgeBases || boundKnowledgeBases.length === 0) &&
          requestedInlineAgent.knowledgeBaseIds && requestedInlineAgent.knowledgeBaseIds.length > 0) {
        boundKnowledgeBases = requestedInlineAgent.knowledgeBaseIds
      }
      reqLogger.info(
        { agentName: requestedInlineAgent.name, hasSystemPrompt: !!requestedInlineAgent.systemPrompt },
        'Inline agent configuration applied (request-level)'
      )
    }

    // ── 项目资源白名单：请求级覆盖 agent 配置（最高优先级）─────────────
    // 仅当客户端显式传入数组（含空数组语义"明确禁用"）时才覆盖。
    if (Array.isArray(requestedSkills)) {
      allowedSkills = requestedSkills
      reqLogger.info({ count: requestedSkills.length }, 'Request-level skills whitelist applied')
    }
    if (Array.isArray(requestedMcpServers)) {
      allowedMcpServers = requestedMcpServers
      reqLogger.info({ count: requestedMcpServers.length }, 'Request-level mcpServers whitelist applied')
    }
    if (Array.isArray(requestedKnowledgeBases)) {
      boundKnowledgeBases = requestedKnowledgeBases
      reqLogger.info({ count: requestedKnowledgeBases.length }, 'Request-level knowledgeBases whitelist applied')
    }
    if (Array.isArray(requestedAllowedTools)) {
      allowedTools = requestedAllowedTools
      reqLogger.info({ count: requestedAllowedTools.length }, 'Request-level allowedTools whitelist applied')
    }

    // ── inlineMcpServers 诊断日志（Phase 1：仅记录，Phase 2 计划支持运行时挂载）─
    if (Array.isArray(requestedInlineMcpServers) && requestedInlineMcpServers.length > 0) {
      reqLogger.info(
        {
          count: requestedInlineMcpServers.length,
          ids: requestedInlineMcpServers.map(s => s.id)
        },
        'Inline MCP servers received (Phase 1: logged only; runtime mount pending)'
      )
    }

    // 请求级 model 覆盖（用于桌面客户端按会话即时切换模型）
    // 注意：仅在显式传入时才覆盖；保持 agent 配置作为默认值。
    if (typeof requestedModel === 'string' && requestedModel.trim()) {
      effectiveModel = requestedModel.trim()
      reqLogger.info({ requestedModel: effectiveModel }, 'Request-level model override applied')
    }

    // Build tool registry（统一工厂，含所有内置工具 + MCP + Skills）
    // 把客户端透传的 inline 资源（桌面端本地 skill / mcp）一并注入，
    // 让 list_skills / get_skill / MCP 工具都能即时看到 + 调用。
    const { registry, memory, externalSkills, toolCategories } = await createToolRegistry({
      allowedSkills,
      allowedTools,
      inlineSkills: requestedInlineSkills,
      inlineMcpServers: requestedInlineMcpServers
    })

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

    // 注：客户端透传的 inlineSkills 已经在 createToolRegistry 内被合并到
    // externalSkills 列表，因此 buildSkillsSystemPrompt 自然会把它们渲染进
    // "Available Skills Index"，同时 list_skills / get_skill 工具也能看到它们 ——
    // 无需在此再单独拼接 inlineSkillsBlock，避免上下文重复。

    // ── 客户端透传知识库目录（仅元数据，让 AI 感知有哪些 KB 可用）──────────────
    let inlineKbBlock = ''
    if (Array.isArray(requestedInlineKnowledgeBases) && requestedInlineKnowledgeBases.length > 0) {
      const lines = requestedInlineKnowledgeBases
        .filter(kb => kb && kb.id && kb.title)
        .slice(0, 100) // 双重保护：客户端已限 100 条，这里再兜底
        .map((kb, i) => {
          const tagPart = kb.tags?.length ? `, tags=${kb.tags.join('|')}` : ''
          const scopePart = kb.scope ? ` [${kb.scope}]` : ''
          const chunkPart = typeof kb.chunkCount === 'number' ? `, chunks=${kb.chunkCount}` : ''
          return `${i + 1}. ${kb.title}${scopePart} (id=${kb.id}, source=${kb.sourceType ?? 'unknown'}${chunkPart}${tagPart})`
        })
      if (lines.length > 0) {
        inlineKbBlock =
          '\n\n## 客户端可用知识库（Client Knowledge Bases）\n' +
          '以下是客户端项目中可访问的知识库文档列表（仅元数据；具体内容由客户端 RAG 检索后注入）：\n' +
          lines.join('\n')
        reqLogger.info({ count: lines.length }, 'Inline KB index injected into systemPrompt')
      }
    }

    // ── 客户端透传用户长期记忆（lobster-core buildAllMemoriesXml 直出）──────────
    let inlineMemoriesBlock = ''
    if (typeof requestedInlineMemoriesXml === 'string' && requestedInlineMemoriesXml.trim()) {
      inlineMemoriesBlock =
        '\n\n## 用户长期记忆（User Memories）\n' +
        '以下记忆由客户端持久化并随每次会话同步，可作为回答的上下文参考：\n' +
        requestedInlineMemoriesXml.trim()
      reqLogger.info(
        { byteLen: requestedInlineMemoriesXml.length },
        'Inline user memories XML injected into systemPrompt'
      )
    }

    const baseSystemPrompt = prependBootstrapToSystemPrompt(
      [effectiveSystemPrompt, skillsPrompt].filter(Boolean).join('\n\n')
        + inlineKbBlock
        + inlineMemoriesBlock,
      reqLogger,
    )

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

    // ── 请求级凭证覆盖（最高优先级）──────────────────────────────────────────
    // 客户端把自己 UI 上选中的 (apiKey/baseUrl/provider) 直接随
    // 请求下发，agent-engine 以请求级凭证完全覆盖 DB / env，避免后端配置漂移导致 401。
    // 仅当传入字段为非空字符串时覆盖；任何字段缺失则保留 DB / env 的回退。
    if (typeof requestedApiKey === 'string' && requestedApiKey.trim()) {
      modelApiKey = requestedApiKey.trim()
    }
    if (typeof requestedBaseUrl === 'string' && requestedBaseUrl.trim()) {
      modelBaseUrl = requestedBaseUrl.trim()
    }
    if (typeof requestedProvider === 'string' && requestedProvider.trim()) {
      modelProvider = requestedProvider.trim()
    }
    // 当客户端显式传 model 且与 DB resolved 不同时，确保我们用客户端版本调用 LLM
    if (typeof requestedModel === 'string' && requestedModel.trim()) {
      resolvedModel = requestedModel.trim()
    }
    if (
      (typeof requestedApiKey === 'string' && requestedApiKey.trim()) ||
      (typeof requestedBaseUrl === 'string' && requestedBaseUrl.trim()) ||
      (typeof requestedProvider === 'string' && requestedProvider.trim())
    ) {
      reqLogger.info(
        {
          model: resolvedModel,
          provider: modelProvider,
          hasApiKey: Boolean(modelApiKey),
          baseUrl: modelBaseUrl
        },
        'Request-level credential override applied (highest priority)'
      )
    }

    // ── 模型 provider 自动路由（仅决定走哪个 LLM Adapter） ──────────────────
    const effectiveBaseUrl = modelBaseUrl || process.env.OPENAI_BASE_URL || ''
    const isQwenModel =
      /qwen|qwq/i.test(currentModelName) ||
      /qwen|qwq|dashscope|aliyuncs/i.test(effectiveBaseUrl)
    const isDeepSeekModel =
      /deepseek/i.test(currentModelName) || /deepseek/i.test(effectiveBaseUrl)

    if (isDeepSeekModel && !modelProvider) {
      modelProvider = 'deepseek'
      reqLogger.info(
        { model: currentModelName, baseUrl: effectiveBaseUrl },
        'DeepSeek 模型检测到，自动切换到 DeepSeek 专有通道',
      )
    } else if (isQwenModel && !modelProvider) {
      modelProvider = 'qwen'
      reqLogger.info(
        { model: currentModelName, baseUrl: effectiveBaseUrl },
        'Qwen 模型检测到，自动切换到 Qwen 专有通道',
      )
    }

    // ── 统一能力检测（vision/thinking/toolCalling/...） ────────────────────
    // 优先级：request.capabilities > db (models 表 capabilities 列 + system_config) > 内置规则
    const dbCapOverrides = modelInfo?.capabilities ?? await loadDbCapabilityOverrides(currentModelName)
    const modelCaps = resolveCapabilities({
      model: currentModelName,
      baseUrl: effectiveBaseUrl,
      provider: modelProvider,
      overrides: requestedCapabilities ?? null,
      dbOverrides: dbCapOverrides,
    })
    reqLogger.info({ model: currentModelName, caps: modelCaps }, '解析模型能力')

    // 把模型名 + 能力注入 ctx，让下游工具（smart-read 等）按能力分支
    ctx.modelName = currentModelName
    ctx.modelCaps = modelCaps

    // ── Thinking Mode 注入：根据能力 + 模型族 决定具体 thinking 参数 ────────
    const wantThinking = thinkingMode === true || (thinkingMode !== false && modelCaps.thinking === true)
    if (wantThinking && modelCaps.thinking) {
      if (isQwenModel) {
        finalThinkingConfig = { enable_thinking: true }
        finalResponseThinkingField = 'reasoning_content'
        reqLogger.info({ model: currentModelName }, 'Qwen 思考模式启用 (enable_thinking=true)')
      } else if (isDeepSeekModel) {
        finalThinkingConfig = { reasoning_effort: thinkingMode === true ? 'high' : 'medium' }
        finalResponseThinkingField = 'reasoning_content'
        reqLogger.info({ model: currentModelName, effort: finalThinkingConfig.reasoning_effort }, 'DeepSeek 思考模式启用')
      } else if (whitelistInfo && whitelistInfo.thinkingMode) {
        finalThinkingConfig = whitelistInfo.thinkingConfig
        finalResponseThinkingField = whitelistInfo.responseThinkingField
        reqLogger.info({ model: currentModelName, thinkingConfig: finalThinkingConfig }, 'Thinking mode enabled via whitelist')
      } else {
        reqLogger.warn({ model: currentModelName }, 'Thinking mode requested 但当前模型族未实现具体注入逻辑，跳过')
      }
    } else if (thinkingMode === true && !modelCaps.thinking) {
      reqLogger.warn({ model: currentModelName }, 'Thinking mode 已请求但能力注册表声明该模型不支持 thinking')
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
1. **ALWAYS use the \`ask_user\` tool** to ask questions, clarify intent, or confirm actions — NEVER output questions as plain text. Plain-text questions do not pause the agent loop and cannot be interacted with by the user. This is a hard rule with no exceptions.
1a. When calling \`ask_user\`, you MUST provide **at least 2 meaningful, specific options**. NEVER call it with only one option (e.g. only "其他"). If you cannot think of at least 2 concrete choices, skip the tool call entirely and ask in your next plain-text reply.
2. Use Chinese tool names in replies (e.g. 写入文件, not write_file).
3. You are ${currentModelName}.
4. When providing a downloadable file to the user, ALWAYS present it as an HTTP download link using this exact Markdown format:
   [文件名](/api/v1/workspace/file/download?sessionId=${sessionId}&path=文件名)
   Use only the filename (not the full path) in the \`path\` parameter. Never use file:// URLs.
${workspaceInfo}${attachments && attachments.length > 0 ? `\n\n## 本次消息已附带以下文件（已上传到工作区，可直接用 smart_read 读取，无需先 list_files）：\n${attachments.map(a => `- ${a.name}`).join('\n')}` : ''}
`

    // ── Estimate token counts for each injected prompt section ──────────
    // systemPromptTokens: pure system prompt (excluding RAG context)
    const pureSystemPrompt = baseSystemPrompt + `
---
# Rules
1. **ALWAYS use the \`ask_user\` tool** to ask questions, clarify intent, or confirm actions — NEVER output questions as plain text. Plain-text questions do not pause the agent loop and cannot be interacted with by the user. This is a hard rule with no exceptions.
1a. When calling \`ask_user\`, you MUST provide **at least 2 meaningful, specific options**. NEVER call it with only one option (e.g. only "其他"). If you cannot think of at least 2 concrete choices, skip the tool call entirely and ask in your next plain-text reply.
2. Use Chinese tool names in replies (e.g. 写入文件, not write_file).
3. You are ${currentModelName}.
4. When providing a downloadable file to the user, ALWAYS present it as an HTTP download link using this exact Markdown format:
   [文件名](/api/v1/workspace/file/download?sessionId=${sessionId}&path=文件名)
   Use only the filename (not the full path) in the \`path\` parameter. Never use file:// URLs.
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

        // 视觉能力来自统一注册表（已在前面解析过）
        const isVisionModel = modelCaps.vision === true

        let prompt: string | any[] | null = messageText || null

        if (!toolResponse) {
          const { autoProcessAttachments } = await import('./attachment-auto-processor.js')
          const result = await autoProcessAttachments(ctx, message, messageText, attachments, {
            messageText,
            isVisionModel,
          })
          prompt = result.prompt
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
          displayContent: message || null,
        })
        const pipeline = createPipeline([])

        const generator = pipeline.pipe(strategy.run(prompt, ctx))
        for await (const chunk of generator) {
          if (chunk.includes('\x00__thinking__')) {
            reasoningContent += chunk.split('\x00__thinking__')[1]
          } else if (chunk.includes('\x00__usage__')) {
            try {
              const usageStr = chunk.split('\x00__usage__')[1]
              finalUsage = JSON.parse(usageStr)
            } catch (e) {
              reqLogger.error({ err: e, chunk }, 'Failed to parse usage chunk')
            }
          } else if (chunk.includes('\x00')) {
            // 所有包含 \x00 的帧（控制帧）均视为元数据，不计入消息正文
          } else {
            // 只有纯净的文本块才累加到正文
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
          systemPromptContent: pureSystemPrompt || undefined,
          ragContent: ragPrompt || undefined,
          skillPromptContent: skillsPrompt || undefined,
          builtinToolsContent: builtinToolDefsText || undefined,
          mcpToolsContent: mcpToolDefsText || undefined,
          history: historicalMessages,
          toolCalls,
          usage: finalUsage,
          createdAt: Date.now()
        })
      } catch (err: any) {
        reqLogger.error({ err, agentId }, 'Agent execution error')
        // DeepSeek 特有错误：附加 errorType 以便前端分级处理
        const dsErrorType: string | null =
          err?.constructor?.name?.startsWith('DeepSeek') ? err.constructor.name : null
        const errPayload = dsErrorType
          ? JSON.stringify({ errorType: dsErrorType, message: err.message, rechargeUrl: err.rechargeUrl })
          : null
        yield `\n\n[System Error: ${err.message || String(err)}]${errPayload ? `\n__DS_ERR__${errPayload}` : ''}`
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

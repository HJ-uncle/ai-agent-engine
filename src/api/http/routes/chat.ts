// TODO: LLM response caching is not implemented for streaming (SSE) endpoints.
// For non-streaming complete() calls, a cache layer could be added here keyed on
// (message, sessionId, systemPrompt) to avoid redundant LLM roundtrips.
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { v4 as uuidv4 } from 'uuid'
import { ReActStrategy } from '../../../core/agent-loop/index.js'
import { createPipeline, sseStream } from '../../../core/stream-pipeline/index.js'
import { createAgentContext, Message } from '../../../core/agent-context/index.js'
import { SQLiteConversationHistory } from '../../../storage/conversation/index.js'
import { createConversationHistory } from '../../../storage/conversation/factory.js'
import { createLLMAdapterWithDbConfig } from '../../../core/llm-adapter/index.js'
import { resolveModelConfig, createAdapterFromResolved } from '../../../core/llm-adapter/resolve-model.js'
import { RequestBudget, parseRequestTokenLimit } from '../../../core/subagent/budget.js'
import { createRequestLogger, QALogger, type QALogEntry } from '../../../observability/index.js'
import { buildSkillsSystemPrompt } from '../../../skills/index.js'
import { getRequestToolProfile } from '../tool-profile.js'
import { createToolRegistry } from '../../../tools/registry-factory.js'
import { resolveOSMMode } from '../../../core/osm.js'
import { success, fail } from '../response.js'
import { withHistoryLock, isSessionHistoryMutating } from '../../../storage/conversation/serialization.js'
import { rootRunStore, type RootRun, type RootPending } from '../../../storage/root-runs/index.js'
import { persistedTurnProjection } from '../chat-snapshot.js'
import { continuedTurnUsage, sessionUsageAtWatermark, sessionSubagentUsage, sessionSubagentRunsAtWatermark } from '../chat-usage.js'
import { SubagentStore } from '../../../core/subagent/store.js'
import { TodoStore } from '../../../storage/todo/index.js'
import { ChangeStore } from '../../../storage/changes/index.js'
import { commandJobs } from '../../../core/command-jobs/index.js'
import { CODE_AGENT_EXECUTION_PROMPT } from '../../../core/code-agent-prompt.js'
import { publicHistoryMessages } from '../history-projection.js'

/**
 * 主 Agent 的子代理委派纪律（对齐 wuzu-client codeAgent.ts 的「探索预算」章节）。
 *
 * 解决的实际症状：主 Agent 遇到调研/审计类任务时倾向闷头自己读，不派子代理；
 * 派了也只有一个模糊 task，子代理没有范围/输出格式/已知线索，效果差。
 * 这段注入把「何时该派、怎么写好一个委派 prompt、怎么回收结果」讲清。
 */
const SUBAGENT_DISPATCH_PROMPT = [
  '## 子代理委派（subagent 工具）',
  '',
  '主对话的上下文很宝贵。遇到下述情形，把探索整体委派给 subagent，不要在主会话里自己趟：',
  '- 广度：要跨多个文件/多个目录的调研、审计、批量定位；',
  '- 噪音：会产生大量一次性中间输出的动作（全仓扫描、长日志、递归统计）；',
  '- 并行：仅在任务确实需要多个独立产出时拆分，避免重复范围。',
  '先遵守用户要求的深度。简单、快速、概览类调研默认只派一个只读子代理；只看目录、入口和少量关键文件，输出简短概览。不要自行升级为深挖或全面审计。',
  '',
  '反过来，这些留在主会话、不要派：写/改代码、≤2-3 跳的定向小查找、需要与用户持续交互的修改类工作。',
  '',
  '派发时，task 必须自包含（子代理看不到本会话历史，缺什么就要给什么），写清四项：',
  '1. 目标：一句话说清产出什么；',
  '2. 范围：限定要看的目录/文件，禁止全仓乱扫；',
  '3. 深度：快扫定位还是深挖实现；',
  '4. 已知线索与输出格式：已确认的路径/结论一并给出，要求结论先行、发现带 文件路径+行号、不贴大段源码。',
  '委派时同时写明父任务的只读/方案约束、验收标准和不可做事项，子代理不得越过父任务权限。',
  '',
  '回收纪律：已有路径和行号证据可以直接复用；如果当前工作树、时间或证据状态发生冲突，只做最小范围复核，不要整段重做。',
  '子代理结果必须包含 status、facts、evidence、actions、verification、unverified 和 next；主 Agent 根据结果决定是否继续，不把未核实项当成完成。',
  '子任务因引擎本地预算或步数结束时，使用它返回的部分证据完成总结，并说明未核实范围。不要把本地预算解释为模型服务商欠费，也不要再次派发或接管同一探索。',
].join('\n')
import { prependBootstrapToSystemPrompt } from '../../../core/osm-bootstrap.js'
import { getProjectContextBlock } from '../../../core/project-context.js'
import { SQLiteAgentStore } from '../../../storage/agent/index.js'
import { SessionStore } from '../../../storage/session/index.js'
import { tenantConfigStore } from '../../../storage/sqlite/tenant-config.js'
import { estimateTokens } from '../../../core/utils/tokens.js'
import { searchChunks } from '../../../storage/knowledge/kb-repo.js'
import { ModelsStore } from '../../../storage/sqlite/models.js'
import { resolveCapabilities, loadDbCapabilityOverrides } from '../../../core/model-capabilities/index.js'
import { extractAndStoreMemories, buildMemoryRecallBlock } from '../../../middleware/memory/index.js'
import { getSessionMemorySettings, setSessionMemoryScope, type MemoryMode } from '../../../storage/memory/settings.js'

interface ChatBody {
  message: string
  sessionId?: string
  /** Per-conversation memory policy. Omitted means the stored session policy/default. */
  memoryScope?: MemoryMode
  agentId?: string
  systemPrompt?: string
  maxAskUserCount?: number
  /**
   * 思考模式控制：
   *  - boolean：false=强制关闭；true=强制开启（按模型族选高/中 effort）
   *  - 字符串档位：'low' | 'medium' | 'high' = 强制开启并指定推理 effort
   *  - 不传：由引擎按模型能力决定（支持则开，中等 effort）
   */
  thinkingMode?: boolean | 'low' | 'medium' | 'high'
  inheritContext?: boolean
  workspacePaths?: string[]
  toolResponse?: { toolCallId: string, name: string, output: string, requestId: string, runId: string }
  /**
   * 附件清单。
   *
   * 约定：客户端先把文件落盘到工作区（`POST /workspace/upload`），
   * 再把**相对工作区的路径**放进 `name` —— 引擎据此从磁盘读回并自动处理
   * （图片走视觉 image_url / OCR，文本走 smart_read）。
   * `type` 为 MIME，仅作提示；`content`/`encoding` 保留给内联上传场景。
   */
  attachments?: Array<{ name: string; content?: string; type?: string; encoding?: 'utf-8' | 'base64' }>
  ragTopK?: number
  /**
   * 请求级模型覆盖（可选）
   * 优先级：body.model > agent.model > env.LLM_PRIMARY_MODEL
   * 用于桌面客户端等需要按会话即时切换模型的场景。
   */
  model?: string
  /**
   * 子代理专用模型（可选）：subagent 工具未显式指定 model 时优先用它，
   * 再回退到主会话模型。用于「主对话强模型 + 子任务便宜模型」的省钱组合。
   */
  subagentModel?: string
  /**
   * 轻任务专用模型（可选）：图片理解（vision-proxy）等旁路调用优先用它，
   * 再回退到 env.VISION_PROXY_MODEL / 主模型。
   */
  utilityModel?: string
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
    timeoutMs?: number
  }>
  /**
   * 客户端透传的用户 Agent 列表（请求级）。
   * agent_list / agent_get 工具会将这些 agent 与引擎本地 DB 中的 agent 合并返回，
   * 让 AI 可通过工具查询到客户端侧的所有 agent（无需在引擎 DB 中预注册）。
   * 本地 DB agent 优先（按 id 去重）；inline agents 为只读，不参与写操作。
   */
  inlineAgents?: Array<{
    id: string
    name: string
    description?: string
    model?: string
    systemPrompt?: string
    skills?: string[]
    mcpServers?: string[]
    knowledgeBases?: string[]
    allowedTools?: string[]
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
   * agent-engine* 收到后整段拼接到 systemPrompt 末尾，
   * 让 LLM 在跨引擎模式下也能看见用户在 端积累的记忆。
   */
  inlineMemoriesXml?: string
  /**
   * 业务元数据（可选）
   * 存储在 sessions（初次对话时）和 conversations（每条消息）中。
   * 用于第三方引擎透传业务字段，如 userId, appId, traceId 等。
   */
  metadata?: any
  /**
   * 透传给上游 LLM 请求的自定义 HTTP 头（可选）。
   * 由调用方按需注入，agent-engine 通过 SDK defaultHeaders 携带到实际 LLM 请求。
   */
  extraHeaders?: Record<string, string>
}

import { StreamBus, activeStreams, busToIterable } from '../../../core/stream-pipeline/stream-bus.js'

// ── 全局会话级 AbortController 注册表 ──────────────────────────────────────────
// 用于支持前端通过 POST /chat/cancel 主动终止某个会话的流式生成。
// key = `${tenantId}:${sessionId}`，value = 当前正在运行的 AbortController。
// 同一会话同时只允许有一个流（新流开始前会先 abort 旧流）。
const activeChatAborters = new Map<string, AbortController>()
/** Discovery owns a controller before durable root admission; concurrent preparations stay separate. */
const preparingChatAborters = new Map<string, Set<AbortController>>()

function makeAbortKey(tenantId: string, sessionId: string): string {
  return `${tenantId}:${sessionId}`
}
// Also cancel requests still preparing their model/registry before a controller exists.
const cancellationEpochs = new Map<string, number>()
const pendingAdmissions = new Map<string, Set<Promise<void>>>()

/**
 * Wait until a previous tool batch has durably settled before accepting a
 * pending answer.  A waiting frame can reach the client before sibling tool
 * results have been persisted, so resuming immediately could race the old
 * batch and duplicate or reorder history.
 *
 * Code runs are durable jobs and may contain long running commands.  The old
 * fixed 30 second timeout turned a healthy long command into a spurious 409
 * and forced the user to retry the answer.  Keep the bounded guard for the
 * interactive profile, while Code waits for the producer's terminal event.
 */
export async function waitForPriorToolBatch(
  prior: Pick<StreamBus, 'finished' | 'emitter'>,
  toolProfile: string,
): Promise<void> {
  if (prior.finished) return
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      prior.emitter.off('end', finish)
      prior.emitter.off('error', failed)
    }
    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const failed = () => finish()

    prior.emitter.once('end', finish)
    prior.emitter.once('error', failed)
    if (toolProfile !== 'code') {
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        reject(Object.assign(new Error('Previous tool batch is still settling; retry this answer'), { statusCode: 409 }))
      }, 30_000)
    }
    // The producer can finish between the initial check and listener setup.
    if (prior.finished) finish()
  })
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
  let cancelled = false
  for (const controller of preparingChatAborters.get(key) ?? []) {
    if (!controller.signal.aborted) { controller.abort(new Error(reason)); cancelled = true }
  }
  const controller = activeChatAborters.get(key)
  if (!controller || controller.signal.aborted) return cancelled
  try { controller.abort(new Error(reason)) } catch { /* noop */ }
  activeChatAborters.delete(key)
  return true
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const getTenantId = (req: FastifyRequest) => (req as any).authContext?.tenantId ?? 'default'

export async function chatRoutes(fastify: FastifyInstance) {
  await rootRunStore.initialize()
  // Reuse bounded revision caches across frequent snapshot refreshes.
  const snapshotHistory = createConversationHistory()
  const snapshotSubagents = new SubagentStore()
  // Initialize agent store
  const agentStore = new SQLiteAgentStore()

  // ── 取消正在运行的会话 ────────────────────────────────────────────────────
  // POST /chat/cancel  body: { sessionId }
  // 即使前端 SSE 连接异常未触发 close，前端也可主动调用此接口终止后端运行。
  fastify.post<{ Body: { sessionId: string } }>('/chat/cancel', {
    schema: {
      body: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { sessionId } = request.body
    const tenantId = getTenantId(request)
    let cancelled = false
    try {
      cancelled = await withHistoryLock(tenantId, async () => {
        const key = makeAbortKey(tenantId, sessionId)
        cancellationEpochs.set(key, (cancellationEpochs.get(key) ?? 0) + 1)
        let cancelled = abortActiveChat(tenantId, sessionId, 'Cancelled by user via /chat/cancel')
        const active = (await rootRunStore.list(tenantId, sessionId)).filter(run => run.status === 'running' || run.status === 'waiting')
        for (const run of active) {
          const updated = await rootRunStore.update(tenantId, run.runId, { status: 'cancelled', stopReason: 'Cancelled by user' })
          if (updated) activeStreams.get(key)?.publishRunState(updated)
          cancelled = true
        }
        abortActiveChat(tenantId, sessionId, 'Cancelled by user via /chat/cancel')
        return cancelled
      })
    } finally {
      // A failed state write must not leave root or child-owned commands running.
      // Still surface the persistence error so a retry can reconcile the run state.
      const jobs = await commandJobs.cancelScope({ tenantId, sessionId }, 'Cancelled by user via /chat/cancel')
      cancelled ||= jobs.length > 0
    }
    return reply.code(200).send({
      code: 200,
      message: cancelled ? 'OK' : 'No active chat for this session',
      data: { sessionId, cancelled },
      timestamp: Date.now(),
    })
  })

  // ── 单独停止某个子代理 ────────────────────────────────────────────────────
  // POST /subagent/cancel  body: { sessionId, toolCallId }
  // 只中断对应 subagent 工具调用的内层 ReAct，主会话与其余并行子代理继续运行。
  fastify.post<{ Body: { sessionId: string; toolCallId: string } }>('/subagent/cancel', {
    schema: {
      body: {
        type: 'object',
        required: ['sessionId', 'toolCallId'],
        properties: {
          sessionId: { type: 'string', minLength: 1 },
          toolCallId: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { sessionId, toolCallId } = request.body
    const { cancelSubagent } = await import('../../../tools/subagent/subagent-tool.js')
    const cancelled = await cancelSubagent(getTenantId(request), sessionId, toolCallId, 'Stopped by user via /subagent/cancel')
    return reply.code(200).send({
      code: 200,
      message: cancelled ? 'OK' : 'Subagent not running or already finished',
      data: { sessionId, toolCallId, cancelled },
      timestamp: Date.now(),
    })
  })

  fastify.post<{ Body: ChatBody }>('/chat', {
    schema: {
      body: {
        type: 'object',
        // message 不再强制要求 minLength: 1，因为在 toolResponse 场景下可能为空
        properties: {
          message: { type: ['string', 'null', 'array'] },
          sessionId: { type: 'string' },
          agentId: { type: 'string' },
          systemPrompt: { type: 'string' },
          maxAskUserCount: { type: 'number' },
          thinkingMode: { type: ['boolean', 'string'], enum: [true, false, 'low', 'medium', 'high'] },
          inheritContext: { type: 'boolean' },
          workspacePaths: { type: 'array', items: { type: 'string' } },
          ragTopK: { type: 'number' },
          model: { type: 'string' },
          subagentModel: { type: 'string' },
          utilityModel: { type: 'string' },
          modelApiKey: { type: 'string' },
          modelBaseUrl: { type: 'string' },
          modelProvider: { type: 'string' },
          toolResponse: {
            type: 'object',
            properties: {
              requestId: { type: 'string' },
              runId: { type: 'string' },
              toolCallId: { type: 'string' },
              name: { type: 'string' },
              output: { type: 'string' }
            }
          },
          attachments: { type: 'array' },
          capabilities: { type: 'object' },
          skills: { type: 'array' },
          mcpServers: { type: 'array' },
          knowledgeBases: { type: 'array' },
          allowedTools: { type: 'array' },
          inlineSkills: { type: 'array' },
          inlineMcpServers: { type: 'array' },
          inlineAgents: { type: 'array' },
          inlineAgent: { type: 'object' },
          inlineKnowledgeBases: { type: 'array' },
          inlineMemoriesXml: { type: 'string' },
          memoryScope: { type: 'string', enum: ['off', 'global', 'session'] },
          metadata: { type: 'object' },
          extraHeaders: { type: 'object' }
        },
        additionalProperties: true, // 允许扩展字段
      },
    },
  }, async (request, reply) => {
    const toolProfile = getRequestToolProfile(request)
    const requestId = uuidv4()
    request.body.sessionId ??= uuidv4()
    const admissionKey = makeAbortKey(getTenantId(request), request.body.sessionId)
    const admissionEpoch = cancellationEpochs.get(admissionKey) ?? 0
    let resumeRecord = null as Awaited<ReturnType<typeof rootRunStore.get>>
    if (request.body.toolResponse) {
      const response = request.body.toolResponse
      if (!response.runId || !response.requestId || !request.body.sessionId) {
        return reply.code(400).send(fail(40001, 'runId, requestId and sessionId are required to answer a pending request'))
      }
      resumeRecord = await rootRunStore.get(getTenantId(request), response.runId)
      if (!resumeRecord || resumeRecord.sessionId !== request.body.sessionId) return reply.code(404).send(fail(40400, 'Run not found'))
      if (resumeRecord.request.toolProfile && resumeRecord.request.toolProfile !== toolProfile) return reply.code(409).send(fail(40900, 'Resume must use the original tool profile'))
      const pending = resumeRecord.pending.find(item => item.requestId === response.requestId)
      if (!pending || pending.toolCallId !== response.toolCallId || pending.toolName !== response.name) return reply.code(404).send(fail(40400, 'Pending request not found'))
      if (pending.status === 'answered') {
        const accepted = await rootRunStore.answer(getTenantId(request), resumeRecord.sessionId, response.runId, response.requestId, response.toolCallId, response.name, response.output)
        async function* duplicate() { yield '\x00__run__' + JSON.stringify(accepted.run) }
        await sseStream(duplicate(), reply)
        return
      }
      // The waiting frame may arrive before sibling result persistence finishes.
      const prior = activeStreams.get(makeAbortKey(getTenantId(request), resumeRecord.sessionId))
      if (prior && !prior.finished) await waitForPriorToolBatch(prior, toolProfile)
      request.body = { ...resumeRecord.request, message: '', sessionId: resumeRecord.sessionId,
        model: resumeRecord.modelId, workspacePaths: resumeRecord.workspacePaths, toolResponse: response } as ChatBody
    }
    const { 
      message, 
      sessionId = uuidv4(), 
      memoryScope: requestedMemoryScope,
      agentId, 
      systemPrompt, 
      maxAskUserCount, 
      thinkingMode, 
      inheritContext = true, 
      workspacePaths, 
      toolResponse, 
      attachments, 
      ragTopK = 3, 
      model: requestedModel,
      subagentModel: requestedSubagentModel,
      utilityModel: requestedUtilityModel,
      modelApiKey: requestedApiKey,
      modelBaseUrl: requestedBaseUrl, 
      modelProvider: requestedProvider, 
      capabilities: requestedCapabilities, 
      skills: requestedSkills, 
      mcpServers: requestedMcpServers, 
      knowledgeBases: requestedKnowledgeBases, 
      allowedTools: requestedAllowedTools, 
      inlineSkills: requestedInlineSkills, 
      inlineMcpServers: requestedInlineMcpServers, 
      inlineAgents: requestedInlineAgents,
      inlineAgent: requestedInlineAgent, 
      inlineKnowledgeBases: requestedInlineKnowledgeBases, 
      inlineMemoriesXml: requestedInlineMemoriesXml,
      metadata: requestedMetadata,
      extraHeaders: requestedExtraHeaders
    } = request.body

    // Get tenant from auth context (set by auth middleware)
    const tenantId = getTenantId(request)
    const reqLogger = createRequestLogger(requestId, tenantId, sessionId)

    // Memory policy is stored per tenant/session so a client that omits the
    // field on a later turn cannot silently fall back to a different scope.
    // An explicit request value updates the session policy for subsequent turns.
    const storedMemorySettings = await getSessionMemorySettings(tenantId, sessionId, toolProfile as 'code' | 'general')
    const selectedMemoryScope: MemoryMode = requestedMemoryScope ?? storedMemorySettings.memoryScope
    if (requestedMemoryScope !== undefined && requestedMemoryScope !== storedMemorySettings.memoryScope) {
      await setSessionMemoryScope(tenantId, sessionId, requestedMemoryScope)
    }
    const effectiveMemoryScope: MemoryMode = process.env.ENABLE_LONG_TERM_MEMORY === 'false'
      ? 'off'
      : selectedMemoryScope
    reqLogger.info({ memoryScope: selectedMemoryScope, effectiveMemoryScope }, 'Conversation memory policy resolved')

    // ── 会话 Agent 锁定校验 ────────────────────────────────────────────────────
    // 会话一旦发送过第一条消息，就锁定绑定的 agentId，后续不允许切换。
    const sessionStore = new SessionStore()
    const binding = await sessionStore.getBinding(sessionId, tenantId)

    let effectiveAgentId = agentId ?? null

    if (binding === undefined) {
      // 首次请求：绑定当前 agentId（可为 null）及元数据
      await sessionStore.bindAgent(sessionId, tenantId, effectiveAgentId, requestedMetadata)
      reqLogger.info({ sessionId, agentId: effectiveAgentId }, 'Session agent binding created')
    } else {
      // 已有绑定记录：强制使用绑定的 agentId，忽略请求中的 agentId
      if (binding.agentId !== effectiveAgentId) {
        reqLogger.warn(
          { sessionId, requestedAgentId: effectiveAgentId, boundAgentId: binding.agentId },
          'Agent switch rejected: session already bound to an agent. Using bound agentId.'
        )
      }
      effectiveAgentId = binding.agentId
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

    // ── 租户专属默认身份注入 ────────────────────────────────────────────────────
    // 如果租户配置了专属默认身份（default_identity），则将其前置到系统提示词中。
    const tenantIdentity = await tenantConfigStore.get(tenantId, 'default_identity')
    if (tenantIdentity) {
      effectiveSystemPrompt = effectiveSystemPrompt
        ? `${tenantIdentity}\n\n${effectiveSystemPrompt}`
        : tenantIdentity
      reqLogger.info('Tenant-level default identity applied')
    }

    // ── 主 Agent 子代理委派纪律（对齐 wuzu-client codeAgent.ts 的「探索预算」章节）──
    // 放在末尾追加：不改变上层 prompt 的相对优先级，只补充默认缺失的行为约束。
    // 已注册的 agent / inlineAgent 提示词若自带委派说明，此段会与之共存而非冲突
    // （二者语义一致，重复无害）。
    effectiveSystemPrompt = [
      effectiveSystemPrompt,
      SUBAGENT_DISPATCH_PROMPT,
    ].filter(Boolean).join('\n\n')

    // ── inlineAgents 诊断日志 ─────────────────────────────────────────────────
    if (Array.isArray(requestedInlineAgents) && requestedInlineAgents.length > 0) {
      reqLogger.info(
        {
          count: requestedInlineAgents.length,
          ids: requestedInlineAgents.map(a => a.id),
          names: requestedInlineAgents.map(a => a.name)
        },
        'Inline agents received from client'
      )
    }

    // ── inlineSkills 诊断日志 ──────────────────────────────────────────────────
    if (Array.isArray(requestedInlineSkills) && requestedInlineSkills.length > 0) {
      reqLogger.info(
        {
          count: requestedInlineSkills.length,
          ids: requestedInlineSkills.map(s => s.id),
          names: requestedInlineSkills.map(s => s.name)
        },
        'Inline skills received from client'
      )
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
    const abortController = new AbortController()
    const preparing = preparingChatAborters.get(admissionKey) ?? new Set<AbortController>()
    preparing.add(abortController); preparingChatAborters.set(admissionKey, preparing)
    // Before root admission there is no durable producer to reconnect to.
    // Stop only this preparation on disconnect, retaining the existing Code
    // disconnect/replay behavior once a root has actually started below.
    const onPreparationClose = () => {
      if (!reply.raw.writableEnded) abortController.abort(new Error('Client disconnected during tool discovery'))
    }
    reply.raw.once('close', onPreparationClose)
    request.raw.once('aborted', onPreparationClose)
    let prepared: Awaited<ReturnType<typeof createToolRegistry>>
    try {
      if (reply.raw.destroyed || request.raw.aborted || (cancellationEpochs.get(admissionKey) ?? 0) !== admissionEpoch) onPreparationClose()
      prepared = await createToolRegistry({
        signal: abortController.signal,
        toolProfile,
        securityContext: { tenantId, sessionId, toolProfile },
        memoryScope: effectiveMemoryScope,
        allowedSkills,
        allowedTools,
        inlineSkills: requestedInlineSkills,
        inlineMcpServers: requestedInlineMcpServers,
        inlineAgents: requestedInlineAgents,
        workspaceRoot: workspacePaths?.[0]
      })
    } catch (error) {
      if (abortController.signal.aborted) return reply.code(499).send(fail(49900, 'Chat preparation cancelled'))
      throw error
    } finally {
      reply.raw.removeListener('close', onPreparationClose)
      request.raw.removeListener('aborted', onPreparationClose)
      preparing.delete(abortController)
      if (!preparing.size && preparingChatAborters.get(admissionKey) === preparing) preparingChatAborters.delete(admissionKey)
    }
    const { registry, externalSkills, toolCategories } = prepared

    // Code runs are durable root jobs: an SSE viewer may disconnect while the
    // model/tools continue working and reconnect through /chat/stream later.
    const streamBus = new StreamBus(abortController, { retainOnDisconnect: toolProfile === 'code' })
    // Published only after the root run has been claimed below.

    // ── 客户端断开检测：给予重连宽限期 ───────────────────────────────────────
    let aborted = false
    const onClientClose = () => {
      if (aborted || streamBus.finished) return
      aborted = true
      if (streamBus.retainOnDisconnect) {
        reqLogger.info({ sessionId }, 'Client connection closed; retaining Code run for replay')
        return
      }
      reqLogger.info({ sessionId }, 'Client connection closed, entering grace period')
      streamBus.disconnectTimeout = setTimeout(() => {
        if (streamBus.emitter.listenerCount('data') > 0) return
        try { abortController.abort(new Error('Client disconnected timeout')) } catch { /* noop */ }
      }, 15000) // 15s grace period
    }
    reply.raw.on('close', onClientClose)
    request.raw.on('aborted', onClientClose)
    const cleanupRequestListeners = (options: { clearDisconnectTimeout?: boolean } = {}) => {
      reply.raw.off('close', onClientClose)
      request.raw.off('aborted', onClientClose)
      // A non-Code viewer disconnect starts a grace timer.  The SSE sink
      // returns immediately after the socket closes, so keep that timer alive
      // until the producer finishes or the timer aborts it.  Clearing it here
      // would turn a transient disconnect into an unbounded background run.
      if (options.clearDisconnectTimeout !== false && streamBus.disconnectTimeout) {
        clearTimeout(streamBus.disconnectTimeout)
        streamBus.disconnectTimeout = null
      }
    }

    // Build agent context
    const ctx = createAgentContext({
      toolProfile,
      memoryScope: effectiveMemoryScope,
      sessionId,
      tenantId,
      workspacePaths,
      tools: registry,
      history: createConversationHistory(),
      logger: reqLogger,
      requestId,
      signal: abortController.signal,
      inheritContext,
    })

    ctx.emitSubagentEvent = (event) => { streamBus.push('\x00__subagent_event__' + JSON.stringify(event)) }
    ctx.rootSessionId = sessionId
    // Spend accounting is shared by parent/children and independent of context capacity.
    // Code mode must not inherit an operator's cumulative token cap. The
    // provider and the model context window remain the only physical limits.
    const requestBudget = new RequestBudget(toolProfile === 'code' ? Infinity : parseRequestTokenLimit(process.env.AGENT_TOTAL_TOKEN_LIMIT))
    ctx.requestBudget = requestBudget
    ctx.onRequestAttempt = (event) => requestBudget.observe(event)
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
    if (effectiveMemoryScope !== 'off' && typeof requestedInlineMemoriesXml === 'string' && requestedInlineMemoriesXml.trim()) {
      inlineMemoriesBlock =
        '\n\n## 用户长期记忆（User Memories）\n' +
        '以下记忆由客户端持久化并随每次会话同步，可作为回答的上下文参考：\n' +
        requestedInlineMemoriesXml.trim()
      reqLogger.info(
        { byteLen: requestedInlineMemoriesXml.length },
        'Inline user memories XML injected into systemPrompt'
      )
    }

    // ── 项目上下文（AE.md）注入 ────────────────────────────────────────────────
    // .aether/AE.md / ~/.aether/AE.md 的内容作为项目说明追加到系统提示词末尾
    const projectContextBlock = getProjectContextBlock(ctx.projectRoot ?? ctx.cwd)
    if (projectContextBlock) {
      reqLogger.info('Project context (AE.md) injected into systemPrompt')
    }

    const baseSystemPrompt = prependBootstrapToSystemPrompt(
      [effectiveSystemPrompt, skillsPrompt, projectContextBlock].filter(Boolean).join('\n\n')
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

    const plainTextQuery = extractPlainText(message)

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
    // 按用途指派的模型（客户端设置「子代理/轻任务模型」）：请求级下发，
    // 空字符串等价于未指定 —— 回退到主模型（subagent）或 env（vision-proxy）。
    ctx.subagentModel = requestedSubagentModel?.trim() || undefined
    ctx.utilityModel = requestedUtilityModel?.trim() || undefined

    // ── 图片可见性：给模型一个明确、唯一、与事实一致的信号 ────────────────────
    // 转录实证：当提示词一方面说「图片已内嵌，你看得到」，另一方面又引导
    // 「用 smart_read 读」，模型会陷入「我到底看不看得到图片」的反复自我怀疑，
    // 白白烧掉大量 token 却始终无法自证。
    //
    // 因此这里根据模型真实视觉能力给出**互斥**的两句话，绝不两头都说：
    //   - 视觉模型 → 明确告知「已内嵌，禁止再用读图工具」，并明确「不要怀疑自己能否看到」
    //   - 非视觉模型 → 明确告知「你无法直接看图」，图片内容已由视觉代理/OCR 转为文本，
    //                 并**明确封死**「自己动手解码图片」这条死路
    const visionProxyModel = process.env.VISION_PROXY_MODEL?.trim()
    const visionCapabilityNote = modelCaps.vision === true
      ? `\n本机当前模型具备视觉能力：以上图片已内嵌到消息中，**你确实能够看到图片内容**。请直接基于看到的画面作答，不要怀疑自己的视觉能力，也不要再调用 \`read_file\` / \`smart_read\` 等工具重复读取。`
      : `\n注意：当前模型**不具备视觉能力**，无法查看图片像素。${
          visionProxyModel
            ? `图片内容已由视觉代理模型 \`${visionProxyModel}\` 转换为结构化文本描述（含布局/间距/对齐），并附在消息里。`
            : `图片内容已由系统在服务端转换为文本（文本类走 smart_read，图片类走 OCR），并附在消息里。`
        }\n请基于这些文本内容作答。**严禁**再用 \`read_file mode:"vision"\` 尝试看图，**严禁**自己写脚本解码 PNG/JPEG 二进制做「像素取证」——图片数据从未进入你的上下文，这条路必然失败，只会浪费大量轮次。`

    // ── Thinking Mode 注入：根据能力 + 模型族 决定具体 thinking 参数 ────────
    // thinkingMode 支持布尔与档位字符串两种形态：
    //   true / 'low' | 'medium' | 'high' → 强制开启（字符串档位同时指定 effort）
    //   false → 强制关闭；不传 → 模型声明支持则开
    const effortTier =
      thinkingMode === 'low' || thinkingMode === 'medium' || thinkingMode === 'high'
        ? thinkingMode
        : undefined
    const thinkingEnabled = thinkingMode === false ? false
      : thinkingMode === true || effortTier !== undefined ? true : undefined
    const wantThinking =
      thinkingMode === true ||
      effortTier !== undefined ||
      (thinkingMode !== false && modelCaps.thinking === true)
    // 请求级 effort 优先；未指定时强制开启走 high、能力驱动走 env 配置（缺省 medium）
    const effectiveReasoningEffort: 'low' | 'medium' | 'high' | undefined =
      thinkingEnabled === false ? undefined : effortTier ??
      (thinkingMode === true
        ? 'high'
        : (process.env.REASONING_EFFORT as 'low' | 'medium' | 'high' | undefined) ?? 'medium')
    if (wantThinking && modelCaps.thinking) {
      if (isQwenModel) {
        finalThinkingConfig = { enable_thinking: true }
        finalResponseThinkingField = 'reasoning_content'
        reqLogger.info({ model: currentModelName }, 'Qwen 思考模式启用 (enable_thinking=true)')
      } else if (isDeepSeekModel) {
        finalThinkingConfig = { reasoning_effort: effectiveReasoningEffort }
        finalResponseThinkingField = 'reasoning_content'
        reqLogger.info({ model: currentModelName, effort: effectiveReasoningEffort }, 'DeepSeek 思考模式启用')
      } else if (whitelistInfo && whitelistInfo.thinkingMode) {
        finalThinkingConfig = whitelistInfo.thinkingConfig
        finalResponseThinkingField = whitelistInfo.responseThinkingField
        reqLogger.info({ model: currentModelName, thinkingConfig: finalThinkingConfig }, 'Thinking mode enabled via whitelist')
      } else {
        reqLogger.warn({ model: currentModelName }, 'Thinking mode requested 但当前模型族未实现具体注入逻辑，跳过')
      }
    } else if (
      (thinkingMode === true || effortTier !== undefined) &&
      !modelCaps.thinking
    ) {
      reqLogger.warn({ model: currentModelName }, 'Thinking mode 已请求但能力注册表声明该模型不支持 thinking')
    }

    // 并行执行 RAG 和 记忆检索
    const enableMemory = effectiveMemoryScope !== 'off'
    const [ragChunks, memoryRecallBlock] = await Promise.all([
      (async () => {
        return await searchChunks(tenantId, plainTextQuery, ragTopK, boundKnowledgeBases ?? (toolProfile === 'code' ? [] : undefined))
      })(),
      enableMemory ? buildMemoryRecallBlock(tenantId, plainTextQuery, {
        model: resolvedModel,
        contextWindow: modelCaps.contextWindow,
        apiKey: modelApiKey,
        baseUrl: modelBaseUrl,
        provider: modelProvider,
      }, { sessionId, scope: effectiveMemoryScope === 'session' ? 'session' : 'global' }) : Promise.resolve('')
    ])
    
    let ragPrompt = ''
    if (ragChunks.length > 0) {
      const context = ragChunks
        .map((c, i) => `[${i + 1}] (from: ${c.filename})\n${c.content}`)
        .join('\n\n')
      ragPrompt = `\n\n---\n# Relevant Knowledge Base Context\n\nUse the following retrieved context to answer the user's question:\n\n${context}\n---`
    }

    // 注入工作区路径信息，让 AI 知道所有绑定的工作区
    const { workspaceManager } = await import('../../../workspace/index.js')
    const allWorkspacePaths = workspaceManager.getPaths({ tenantId, sessionId, workspacePaths })
    const workspaceInfo = allWorkspacePaths.length > 1
      ? `\n\n当前会话绑定了以下工作区路径：\n${allWorkspacePaths.map((p, i) => `  ${i === 0 ? '主工作区' : '自定义工作区'}: ${p}`).join('\n')}\n调用 \`list_files\` 工具（不传参数）可查看所有工作区内容。`
      : `\n\n当前工作区路径：${allWorkspacePaths[0]}`

    // 代码图索引提示：仅在已建索引时注入，引导模型优先用图谱而非逐字搜索
    const { detectCodegraphAvailability, buildCodegraphPromptBlock } = await import(
      '../../../core/codegraph-prompt.js'
    )
    const codegraphBlock = buildCodegraphPromptBlock(
      await detectCodegraphAvailability(allWorkspacePaths),
      allWorkspacePaths[0]
    )

    const codeExecutionPrompt = toolProfile === 'code' ? `\n\n${CODE_AGENT_EXECUTION_PROMPT}` : ''
    const fullSystemPrompt = baseSystemPrompt + ragPrompt + memoryRecallBlock + `
---
# Rules
1. **Use the \`ask_user\` tool ONLY** when you need the user to make a critical decision among specific options to continue a complex task. For normal conversational questions, open-ended clarifications, or when chatting naturally, DO NOT use the \`ask_user\` tool — just output your question as plain text.
1a. When calling \`ask_user\`, you MUST provide **at least 2 meaningful, specific options**. NEVER call it with only one option (e.g. only "其他").
1b. **能自行查证的一律自行查证，禁止用 \`ask_user\` 代替探索。** 只要信息可以通过工具获得（读文件、列目录、grep、看诊断、读代码图），就必须先去查，而不是先问用户。典型反例：不给路径就问「你指哪个文件」、不读代码就问「是哪个组件」、不跑测试就问「是不是这里错了」。只有在**信息确实只存在于用户脑子里**（业务偏好、优先级取舍、无法从仓库推断的需求）时才用 \`ask_user\`。
2. 用户可见说明使用中文；工具调用必须使用已注册的原始 name，不编造中文别名或不存在的工具。
3. You are ${currentModelName}.
4. When providing a downloadable file to the user, ALWAYS present it as an HTTP download link using this exact Markdown format:
   [文件名](/api/v1/workspace/file/download?sessionId=${sessionId}&path=文件名)
   Use only the filename (not the full path) in the \`path\` parameter. Never use file:// URLs.
5. 多步任务（≥3 步）必须先用 todo 工具建清单：用 \`todo_create\` 逐项创建步骤（标题用简短中文），开始某项前用 \`todo_update\` 置为 in_progress，完成后立即置为 done；全部完成才算任务结束。
6. **先给结论，再说理由。** 不要在回答里反复自我怀疑或把同一假设推演多遍；一旦确认了一件事，就把它当既定事实继续推进，不要回头重复论证。
7. **禁止绕过工具链自造轮子。** 当现有工具做不到某件事时（例如看不到图片），**不要**自己写脚本去实现底层能力（手写 PNG/JPEG 解码器、二进制解析、像素取证、OCR 引擎等）。这类自造轮子几乎必然失败，且会烧掉几十轮工具调用。正确做法：① 换用受支持的路径（如 \`read_file mode:"ocr"\`）；② 确认该路径确实不可用后，直接向用户说明限制并给出替代方案。**同一件事尝试失败一次就换路径，绝不允许用「再换个脚本试试」的方式反复试探。**
${workspaceInfo}${codegraphBlock}${attachments && attachments.length > 0 ? `\n\n## 本次消息已附带以下文件\n${attachments.map(a => `- ${a.name}`).join('\n')}${visionCapabilityNote}` : ''}${codeExecutionPrompt}
`

    // ── Estimate token counts for each injected prompt section ──────────
    // systemPromptTokens: pure system prompt (excluding RAG context)
    const pureSystemPrompt = baseSystemPrompt + memoryRecallBlock + `
---
# Rules
1. **Use the \`ask_user\` tool ONLY** when you need the user to make a critical decision among specific options to continue a complex task. For normal conversational questions, open-ended clarifications, or when chatting naturally, DO NOT use the \`ask_user\` tool — just output your question as plain text.
1a. When calling \`ask_user\`, you MUST provide **at least 2 meaningful, specific options**. NEVER call it with only one option (e.g. only "其他").
1b. **能自行查证的一律自行查证，禁止用 \`ask_user\` 代替探索。** 只要信息可以通过工具获得（读文件、列目录、grep、看诊断、读代码图），就必须先去查，而不是先问用户。典型反例：不给路径就问「你指哪个文件」、不读代码就问「是哪个组件」、不跑测试就问「是不是这里错了」。只有在**信息确实只存在于用户脑子里**（业务偏好、优先级取舍、无法从仓库推断的需求）时才用 \`ask_user\`。
2. 用户可见说明使用中文；工具调用必须使用已注册的原始 name，不编造中文别名或不存在的工具。
3. You are ${currentModelName}.
4. When providing a downloadable file to the user, ALWAYS present it as an HTTP download link using this exact Markdown format:
   [文件名](/api/v1/workspace/file/download?sessionId=${sessionId}&path=文件名)
   Use only the filename (not the full path) in the \`path\` parameter. Never use file:// URLs.
5. 多步任务（≥3 步）必须先用 todo 工具建清单：用 \`todo_create\` 逐项创建步骤（标题用简短中文），开始某项前用 \`todo_update\` 置为 in_progress，完成后立即置为 done；全部完成才算任务结束。
6. **先给结论，再说理由。** 不要在回答里反复自我怀疑或把同一假设推演多遍；一旦确认了一件事，就把它当既定事实继续推进，不要回头重复论证。
7. **禁止绕过工具链自造轮子。** 当现有工具做不到某件事时（例如看不到图片），**不要**自己写脚本去实现底层能力（手写 PNG/JPEG 解码器、二进制解析、像素取证、OCR 引擎等）。这类自造轮子几乎必然失败，且会烧掉几十轮工具调用。正确做法：① 换用受支持的路径（如 \`read_file mode:"ocr"\`）；② 确认该路径确实不可用后，直接向用户说明限制并给出替代方案。**同一件事尝试失败一次就换路径，绝不允许用「再换个脚本试试」的方式反复试探。**
${workspaceInfo}${codegraphBlock}${codeExecutionPrompt}
`
    const skillTokens = estimateTokens(skillsPrompt)
    // Skills are already embedded in baseSystemPrompt, but have their own
    // usage category. Each input section must be counted exactly once.
    const systemPromptTokens = Math.max(0, estimateTokens(pureSystemPrompt) - skillTokens)
    const ragTokens = estimateTokens(ragPrompt)

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

    let rootRun!: RootRun
    let attemptId = ''
    let conversationId = ''
    let precedingTurnUsage: Record<string, number> = {}
    let resumedPending: RootPending | undefined
    const publishRun = (run: RootRun | null) => {
      if (!run) return
      rootRun = run
      streamBus.push('\x00__run__' + JSON.stringify(run))
    }
    // Snapshot readers await publication, while cancellation remains free to interrupt admission.
    let finishAdmission!: () => void
    const pendingAdmission = new Promise<void>(resolve => { finishAdmission = resolve })
    const admissions = pendingAdmissions.get(admissionKey) ?? new Set<Promise<void>>()
    admissions.add(pendingAdmission)
    pendingAdmissions.set(admissionKey, admissions)
    let admission: 'duplicate' | 'stopped' | 'started'
    try {
      admission = await (async () => {
      try {
        if (toolResponse) {
          const accepted = await rootRunStore.answer(tenantId, sessionId, toolResponse.runId, toolResponse.requestId, toolResponse.toolCallId, toolResponse.name, toolResponse.output)
          rootRun = accepted.run
          if (accepted.duplicate) return 'duplicate' as const
          resumedPending = accepted.pending
        } else {
          rootRun = await rootRunStore.create(tenantId, sessionId, resolvedModel ?? ctx.modelName ?? '', workspacePaths ?? [], { ...request.body, memoryScope: selectedMemoryScope, toolProfile } as unknown as Record<string, unknown>)
        }
        attemptId = (await rootRunStore.get(tenantId, rootRun.runId))!.attemptId
        conversationId = rootRun.turnId
        ctx.rootRunId = rootRun.runId
        ctx.turnId = rootRun.turnId
        ctx.userMessageId = rootRun.userMessageId
        ctx.assistantMessageId = rootRun.assistantMessageId
        ctx.conversationId = rootRun.turnId
        if (resumedPending) {
          ctx.resumeToolCall = { toolCall: { id: resumedPending.toolCallId, name: resumedPending.toolName, args: resumedPending.args },
            messageId: resumedPending.messageId ?? '', decision: resumedPending.kind === 'permission' ? (resumedPending.output === 'approved' ? 'approved' : 'rejected') : 'answered', output: resumedPending.output }
        }
        ctx.onPending = async pending => { publishRun(await rootRunStore.pending(tenantId, rootRun.runId, pending, attemptId)) }
        ctx.runObserver = {
          onOutcome: async outcome => {
            const waiting = outcome.status === 'blocked' && rootRun.pending.some(item => item.status === 'pending')
            publishRun(await rootRunStore.update(tenantId, rootRun.runId, { status: waiting ? 'waiting' : outcome.stopReason === 'incomplete' ? 'interrupted' : outcome.status === 'blocked' ? 'failed' : outcome.status,
              error: outcome.error, stopReason: outcome.stopReason }, attemptId))
          },
        }
        if (toolResponse) {
          const prior = activeStreams.get(makeAbortKey(tenantId, sessionId))
          const priorSnapshot = prior?.snapshot()
          const priorRun = priorSnapshot?.projection.find(payload => payload.run)?.run as RootRun | undefined
          if (priorRun?.runId === rootRun.runId) streamBus.seedProjection(priorSnapshot!.projection, priorSnapshot!.subagentWatermarks, priorSnapshot!.projectionTruncated)
          else {
            const precedingChildren = await snapshotSubagents.listRunsForParent(tenantId, sessionId)
            streamBus.seedProjection(persistedTurnProjection(await ctx.history.getFullHistory(ctx), rootRun),
              precedingChildren.filter(child => child.parentConversationId === rootRun.turnId)
                .map(child => ({ runId: child.runId, seq: child.lastSeq })))
          }
        } else {
          streamBus.push('\x00__user_message__' + JSON.stringify({ id: rootRun.userMessageId, role: 'user', content: message,
            conversationId: rootRun.turnId, createdAt: rootRun.createdAt,
            metadata: { ...requestedMetadata, rootRunId: rootRun.runId, turnId: rootRun.turnId,
              attachments: attachments?.map(item => ({ name: item.name, type: item.type })) } }))
        }
        const started = await withHistoryLock(tenantId, async () => {
          const current = await rootRunStore.get(tenantId, rootRun.runId)
          const cancelledBeforeStart = (cancellationEpochs.get(admissionKey) ?? 0) !== admissionEpoch
          if (!current || current.status !== 'running' || current.attemptId !== attemptId || isSessionHistoryMutating(tenantId, sessionId) || cancelledBeforeStart) {
            abortController.abort(new Error('Run stopped before execution'))
            if (current) publishRun(cancelledBeforeStart ? await rootRunStore.update(tenantId, rootRun.runId, { status: 'cancelled', stopReason: 'Cancelled before execution started' }, attemptId) : rootRunStore.public(current))
            streamBus.end()
            return false
          }
          if (toolResponse) {
            precedingTurnUsage = await ctx.history.getSessionUsage(ctx, rootRun.turnId)
            const precedingSnapshot = streamBus.snapshot()
            const projection = precedingSnapshot.projection
            const priorUsage = projection.find(frame => frame.usage)?.usage as Record<string, unknown> | undefined
            // Earlier calls may have been compacted out of the persisted UI
            // projection. Seed their billing once, keeping occupancy paired
            // with the last actual input snapshot when one remains available.
            streamBus.seedProjection([...projection.filter(frame => !frame.usage), { usage: {
              ...priorUsage, ...precedingTurnUsage, sessionId, runId: rootRun.runId,
              turnId: rootRun.turnId, attemptId, usageScope: 'turn',
            } }], precedingSnapshot.subagentWatermarks, precedingSnapshot.projectionTruncated)
          }
          activeStreams.set(makeAbortKey(tenantId, sessionId), streamBus)
          registerActiveChat(tenantId, sessionId, abortController)
          publishRun(rootRun)
          return true
        })
        return started ? 'started' as const : 'stopped' as const
      } finally {
        admissions.delete(pendingAdmission)
        if (!admissions.size) pendingAdmissions.delete(admissionKey)
        finishAdmission()
      }
      })()
    } catch (error) {
      // Admission can fail before the SSE producer is attached (for example
      // after a restart or a database error). Do not leave request listeners or
      // a disconnect timer retaining the request and stream bus indefinitely.
      cleanupRequestListeners()
      throw error
    }
    if (admission === 'duplicate') {
      async function* duplicate() { yield '\x00__run__' + JSON.stringify(rootRun) }
      try { await sseStream(duplicate(), reply) } finally { cleanupRequestListeners() }
      return
    }
    if (admission === 'stopped') {
      try { await sseStream(busToIterable(streamBus), reply) } finally { cleanupRequestListeners() }
      return
    }
    let assistantResponse = ''
    let reasoningContent = ''
    let finalUsage: any = null

    async function* runAgent(): AsyncIterable<string> {
      try {
        // 提取消息中的纯文本部分（message 可能是数组格式）
        const messageText = extractPlainText(message)

        // 视觉能力来自统一注册表（已在前面解析过）
        const isVisionModel = modelCaps.vision === true

        let prompt: string | any[] | null = toolResponse ? null : messageText || null

        if (!toolResponse) {
          const { autoProcessAttachments } = await import('./attachment-auto-processor.js')
          const result = await autoProcessAttachments(ctx, message, messageText, attachments, {
            messageText,
            isVisionModel,
          })
          prompt = result.prompt
          // 记录「图片是否真的进了多模态上下文」，便于线上排查视觉相关死循环
          if (attachments && attachments.length > 0) {
            reqLogger.info(
              { visionInlined: result.visionInlined, isVisionModel, processedFiles: result.processedFiles },
              '附件处理完成'
            )
          }
        }

        ctx.resolvedModel = await resolveModelConfig({ tenantId, model: resolvedModel, overrides: {
          apiKey: modelApiKey, baseUrl: modelBaseUrl, provider: modelProvider,
          capabilities: modelCaps, extraHeaders: requestedExtraHeaders,
          thinkingEnabled, thinkingConfig: finalThinkingConfig, responseThinkingField: finalResponseThinkingField,
        } })
        const llm = createAdapterFromResolved(ctx.resolvedModel)
        const strategy = new ReActStrategy(llm, {
          systemPrompt: fullSystemPrompt || undefined,
          temperature: effectiveTemperature,
          unboundedCode: toolProfile === 'code',
          maxAskUserCount,
          conversationId,
          promptBreakdown: { systemPromptTokens, systemToolsTokens, skillTokens, ragTokens, builtinToolsTokens, mcpToolsTokens },
          thinkingEnabled,
          thinkingConfig: finalThinkingConfig,
          responseThinkingField: finalResponseThinkingField,
          reasoningEffort: effectiveReasoningEffort,
          displayContent: message || null,
          metadata: { ...requestedMetadata,
            attachments: attachments?.map(item => ({ name: item.name, type: item.type })) },
        })
        const pipeline = createPipeline([])

        const generator = pipeline.pipe(strategy.run(prompt, ctx))
        for await (let chunk of generator) {
          if (chunk.startsWith('\x00__assistant_msg_id__')) {
            const assistantMessageId = chunk.slice('\x00__assistant_msg_id__'.length)
            if (assistantMessageId !== rootRun.assistantMessageId) publishRun(await rootRunStore.update(tenantId, rootRun.runId, { assistantMessageId }, attemptId))
          }
          if (chunk.includes('\x00__thinking__')) {
            reasoningContent += chunk.split('\x00__thinking__')[1]
          } else if (chunk.includes('\x00__usage__')) {
            try {
              const usageStr = chunk.split('\x00__usage__')[1]
              const usage: Record<string, unknown> = { ...continuedTurnUsage(precedingTurnUsage, JSON.parse(usageStr)),
                sessionId, runId: rootRun.runId, turnId: rootRun.turnId, attemptId, usageScope: 'turn' }
              if (typeof usage.currentPromptTokens === 'number' || typeof usage.promptTokens === 'number') {
                usage.contextModelId = typeof usage.modelId === 'string' && usage.modelId
                  ? usage.modelId : rootRun.actualModelId ?? rootRun.modelId
              }
              // The stream remains cumulative for one durable turn, even
              // though the resumed ReAct strategy starts its counters at zero.
              chunk = '\x00__usage__' + JSON.stringify(usage)
              finalUsage = { ...finalUsage, ...usage }
              if (typeof usage.modelId === 'string' && usage.modelId && usage.modelId !== rootRun.actualModelId) {
                publishRun(await rootRunStore.update(tenantId, rootRun.runId, { actualModelId: usage.modelId }, attemptId))
              }
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

        setImmediate(() => {
          // Reuse the request's capability decision; an explicit conversation
          // memory policy also applies to code-profile runs.
          if (enableMemory) {
            extractAndStoreMemories({
              sourceTurnId: conversationId,
              messages: fullHistory.map((m: any) => ({
                role: m.role as string,
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
              })),
              sessionId,
              tenantId,
              memoryScope: effectiveMemoryScope === 'session' ? 'session' : 'global',
              llm: {
                model: resolvedModel,
                contextWindow: modelCaps.contextWindow,
                apiKey: modelApiKey,
                baseUrl: modelBaseUrl,
                provider: modelProvider,
              },
              minImportance: 0.3,
            }).then((res) => {
              if (res.stored > 0) {
                reqLogger.info({ extracted: res.extracted, stored: res.stored }, 'Memories auto-extracted')
              }
              if (res.errors.length > 0) {
                reqLogger.warn({ errors: res.errors }, 'Memory extraction had errors')
              }
            }).catch((err) => {
              reqLogger.warn({ err: (err as Error)?.message }, 'Memory extraction failed silently')
            })
          }

          // 上下文智能压缩：如果当前上下文占用超过有效窗口阈值，在后台触发压缩。
          // 口径用单次调用快照 currentPromptTokens（当前上下文真实占用），
          // 不用累计 totalTokens（跨轮计费口径，会严重误触发/漏触发）。
          const autoCompactRatio = parseFloat(process.env.AUTO_COMPACT_THRESHOLD_RATIO ?? '0.92')
          const contextWindow = modelCaps?.contextWindow ?? parseInt(process.env.AUTO_COMPACT_TOKEN_LIMIT ?? '500000', 10)
          const currentPromptTokens = (finalUsage as any)?.currentPromptTokens ?? 0
          if (currentPromptTokens > Math.floor(contextWindow * autoCompactRatio)) {
            reqLogger.info({ currentPromptTokens, contextWindow }, 'Context usage exceeded, triggering auto-compaction')
            import('./conversation.js').then(({ autoCompactSession }) => {
              autoCompactSession(tenantId, sessionId, reqLogger).catch((err: any) => {
                reqLogger.error({ err }, 'Auto-compaction failed')
              })
            })
          }
        })
      } catch (err: any) {
        publishRun(await rootRunStore.update(tenantId, rootRun.runId, { status: abortController.signal.aborted ? 'cancelled' : 'failed',
          error: { code: 'CHAT_FAILED', message: err.message || String(err), retryable: false } }, attemptId))
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

    // 后台运行 Agent
    ;(async () => {
      try {
        for await (const chunk of runAgent()) {
          streamBus.push(chunk)
        }
        if (rootRun.status === 'running') publishRun(await rootRunStore.update(tenantId, rootRun.runId, { status: abortController.signal.aborted ? 'cancelled' : 'interrupted', stopReason: 'Execution ended without an outcome' }, attemptId))
        streamBus.end()
      } catch (err) {
        publishRun(await rootRunStore.update(tenantId, rootRun.runId, { status: abortController.signal.aborted ? 'cancelled' : 'failed',
          error: { code: 'CHAT_FAILED', message: err instanceof Error ? err.message : String(err), retryable: false } }, attemptId))
        streamBus.error(err)
      } finally {
        if (streamBus.disconnectTimeout) {
          clearTimeout(streamBus.disconnectTimeout)
          streamBus.disconnectTimeout = null
        }
        unregisterActiveChat(tenantId, sessionId, abortController)
        setTimeout(() => {
          const key = makeAbortKey(tenantId, sessionId)
          if (activeStreams.get(key) === streamBus) activeStreams.delete(key)
        }, 60000) // 运行结束后保留 1 分钟
      }
    })()

    try {
      await sseStream(busToIterable(streamBus), reply)
    } finally {
      // The stream bus owns the durable producer; these request-local listeners
      // must still be detached after every viewer disconnects or completes.
      cleanupRequestListeners({ clearDisconnectTimeout: !aborted })
    }
  })

  fastify.get<{ Querystring: { sessionId: string } }>('/chat/snapshot', async (request, reply) => {
    const { sessionId } = request.query
    if (!sessionId) return reply.code(400).send(fail(40001, 'sessionId is required'))
    const tenantId = getTenantId(request)
    const key = makeAbortKey(tenantId, sessionId)
    const earlyBus = activeStreams.get(key)
    if (earlyBus?.disconnectTimeout) { clearTimeout(earlyBus.disconnectTimeout); earlyBus.disconnectTimeout = null }
    while (true) {
      await Promise.all(pendingAdmissions.get(key) ?? [])
      const result = await withHistoryLock(tenantId, async () => {
        // An admission can begin while this reader was queued for the history lock.
        if (pendingAdmissions.get(key)?.size) return null
        const [storedHistory, runs, todos, changes, jobs, childRuns] = await Promise.all([
          snapshotHistory.getFullHistory({ tenantId, sessionId }), rootRunStore.list(tenantId, sessionId),
          new TodoStore().list(tenantId, sessionId), new ChangeStore().list(tenantId, sessionId),
          commandJobs.list({ tenantId, sessionId }), snapshotSubagents.listRunsForParent(tenantId, sessionId),
        ])
        const latestTurnId = runs.at(-1)?.turnId
        const totals = latestTurnId && snapshotHistory.getUsageTotals
          ? await snapshotHistory.getUsageTotals({ tenantId, sessionId }, latestTurnId)
          : { sessionUsage: await snapshotHistory.getSessionUsage({ tenantId, sessionId }),
            turnUsage: latestTurnId ? await snapshotHistory.getSessionUsage({ tenantId, sessionId }, latestTurnId) : {} }
        const history = publicHistoryMessages(storedHistory)
        // JSONL keeps the pre-compaction transcript on disk but exposes only
        // the summary + recent tail to the model/UI snapshot.  Tell the UI
        // that an explicit archive read is available without embedding the
        // archive itself in the snapshot response.
        const historyCompacted = history.some(message =>
          message.role === 'system' && message.metadata?.isCompactSummary === true)
        const bus = activeStreams.get(key)
        if (bus) {
          // No await between state projection and cursor: they describe exactly the same delivered prefix.
          const snapshot = bus.snapshot()
          const run = snapshot.projection.find(payload => payload.run)?.run as RootRun | undefined
          if (run && runs.at(-1)?.runId === run.runId) {
            const projectedRuns = [...runs.filter(item => item.runId !== run.runId), run].sort((a, b) => a.seq - b.seq)
            const publishedUsage = snapshot.projection.find(frame => frame.usage)?.usage as Record<string, unknown> | undefined
            const publishedChildren = await snapshotSubagents.getSnapshotsAtSequences(tenantId, snapshot.subagentWatermarks ?? [])
            const subagentRuns = sessionSubagentRunsAtWatermark(childRuns, { tenantId, sessionId }, run.turnId,
              [...snapshot.projection, ...publishedChildren.map(child => ({ subagentEvent: { snapshot: child } }))])
            return { ...snapshot, source: 'live', sessionId, run, runs: projectedRuns, history, historyCompacted, todos, changes, commandJobs: jobs,
              sessionUsage: sessionUsageAtWatermark(totals.sessionUsage, totals.turnUsage, publishedUsage),
              sessionSubagentUsage: sessionSubagentUsage(subagentRuns, { tenantId, sessionId }), subagentRuns }
          }
        }
        return { schemaVersion: 1, source: 'persisted', sessionId, eventId: null, finished: true,
          projection: [], run: runs.at(-1), runs, history, historyCompacted, todos, changes, commandJobs: jobs,
          sessionUsage: totals.sessionUsage, sessionSubagentUsage: sessionSubagentUsage(childRuns, { tenantId, sessionId }),
          subagentRuns: sessionSubagentRunsAtWatermark(childRuns, { tenantId, sessionId }) }
      })
      if (result) return reply.send(success(result))
    }
  })

  fastify.get<{ Querystring: { sessionId: string } }>('/chat/runs', async (request, reply) => {
    if (!request.query.sessionId) return reply.code(400).send(fail(40001, 'sessionId is required'))
    return reply.send(success({ runs: await rootRunStore.list(getTenantId(request), request.query.sessionId) }))
  })

  // ── 查询会话流状态（刷新/切会话后探测是否有进行中的流）────────────────────
  fastify.get<{ Querystring: { sessionId: string } }>('/chat/status', {
    schema: {
      querystring: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { sessionId } = request.query
    const streamBus = activeStreams.get(makeAbortKey(getTenantId(request), sessionId))
    const runs = await rootRunStore.list(getTenantId(request), sessionId)
    const run = runs.at(-1)
    const busRun = streamBus?.snapshot().projection.find(payload => payload.run)?.run as RootRun | undefined
    if (!streamBus || !busRun || runs.at(-1)?.runId !== busRun.runId) {
      return reply.code(200).send(success({ running: false, finished: Boolean(run), run }))
    }
    const lastEventId = streamBus.lastEventId
    return reply.code(200).send(success({
      running: !streamBus.finished,
      finished: streamBus.finished,
      lastEventId,
      run,
    }))
  })

  // ── 恢复断开的流 ──────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { sessionId: string; lastEventId?: string } }>('/chat/stream', {
    schema: {
      querystring: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string', minLength: 1 },
          lastEventId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { sessionId, lastEventId } = request.query

    const tenantId = getTenantId(request)
    const subscription = await withHistoryLock(tenantId, async () => {
      const bus = activeStreams.get(makeAbortKey(tenantId, sessionId))
      const run = bus?.snapshot().projection.find(payload => payload.run)?.run as RootRun | undefined
      if (!bus || !run || (await rootRunStore.list(tenantId, sessionId)).at(-1)?.runId !== run.runId) return null
      try { return { bus, source: busToIterable(bus, lastEventId) } }
      catch { return null }
    })
    if (!subscription) return reply.code(409).send(fail(40902, 'snapshot_required'))
    const { bus: streamBus, source } = subscription

    if (streamBus.disconnectTimeout) {
      clearTimeout(streamBus.disconnectTimeout)
      streamBus.disconnectTimeout = null
    }

    let aborted = false
    const onClientClose = () => {
      if (aborted || streamBus.finished) return
      aborted = true
      if (streamBus.retainOnDisconnect) return
      streamBus.disconnectTimeout = setTimeout(() => {
        if (streamBus.emitter.listenerCount('data') > 0) return
        try { streamBus.abortController.abort(new Error('Client disconnected timeout')) } catch {}
      }, 15000)
    }
    reply.raw.on('close', onClientClose)
    request.raw.on('aborted', onClientClose)

    try {
      await sseStream(source, reply)
    } finally {
      reply.raw.off('close', onClientClose)
      request.raw.off('aborted', onClientClose)
    }
  })
}

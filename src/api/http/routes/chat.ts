// TODO: LLM response caching is not implemented for streaming (SSE) endpoints.
// For non-streaming complete() calls, a cache layer could be added here keyed on
// (message, sessionId, systemPrompt) to avoid redundant LLM roundtrips.
import type { FastifyInstance } from 'fastify'
import { ReActStrategy } from '../../../core/agent-loop/index.js'
import { createPipeline, sseStream } from '../../../core/stream-pipeline/index.js'
import { createAgentContext } from '../../../core/agent-context/index.js'
import { ToolRegistry } from '../../../core/tool-registry/index.js'
import { SQLiteMemoryStore } from '../../../storage/memory-store/index.js'
import { SQLiteConversationHistory } from '../../../storage/conversation/index.js'
import { createLLMAdapter } from '../../../core/llm-adapter/index.js'
import { createRequestLogger } from '../../../observability/index.js'
import { registerBuiltinSkills, buildSkillsSystemPrompt, skillsRegistry } from '../../../skills/index.js'
import { fileTools } from '../../../tools/file/index.js'
import { cmdTool } from '../../../tools/cmd/index.js'
import { createMemoryTools } from '../../../tools/memory/index.js'
import { registerMCPTools } from '../../../tools/mcp/loader.js'
import { createSkillTools, runSkillScriptTool } from '../../../tools/skill/index.js'
import { v4 as uuidv4 } from 'uuid'

interface ChatBody {
  message: string
  sessionId?: string
  systemPrompt?: string
  maxIterations?: number
}

export async function chatRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: ChatBody }>('/chat', async (request, reply) => {
    const requestId = uuidv4()
    const { message, sessionId = uuidv4(), systemPrompt, maxIterations } = request.body

    // Get tenant from auth context (set by auth middleware)
    const tenantId = (request as unknown as { authContext?: { tenantId: string } }).authContext?.tenantId ?? 'default'
    const reqLogger = createRequestLogger(requestId, tenantId, sessionId)

    // Build tool registry
    const registry = new ToolRegistry()
    const memory = new SQLiteMemoryStore()
    registerBuiltinSkills(registry)
    fileTools.forEach((t) => registry.register(t))
    registry.register(cmdTool)
    createMemoryTools(memory).forEach((t) => registry.register(t))
    // 自动从 mcp.config.json 加载所有 MCP 服务器工具
    await registerMCPTools(registry)

    // Build agent context
    const ctx = createAgentContext({
      sessionId,
      tenantId,
      tools: registry,
      memory,
      history: new SQLiteConversationHistory(),
      logger: reqLogger,
      requestId,
    })

    // 从全局 SkillsRegistry 获取最新技能列表（自动热重载，无需每次扫描磁盘）
    const externalSkills = skillsRegistry.getSkills()
    // 注册 list_skills / get_skill / run_skill_script 工具
    createSkillTools(externalSkills).forEach((t) => registry.register(t))
    registry.register(runSkillScriptTool)
    // 系统提示词只注入轻量索引（名称 + 描述），避免超出 token 限制
    const skillsPrompt = buildSkillsSystemPrompt(externalSkills)
    const finalSystemPrompt = [systemPrompt, skillsPrompt].filter(Boolean).join('\n\n')

    // RAG: search knowledge base for relevant context
    const { searchChunks } = await import('../../../storage/knowledge/kb-repo.js')
    const ragChunks = await searchChunks(tenantId, message, 3)
    let ragPrompt = ''
    if (ragChunks.length > 0) {
      const context = ragChunks
        .map((c, i) => `[${i + 1}] (from: ${c.filename})\n${c.content}`)
        .join('\n\n')
      ragPrompt = `\n\n---\n# Relevant Knowledge Base Context\n\nUse the following retrieved context to answer the user's question:\n\n${context}\n---`
    }
    const fullSystemPrompt = finalSystemPrompt + ragPrompt

    const llm = createLLMAdapter()
    const strategy = new ReActStrategy(llm, {
      systemPrompt: fullSystemPrompt || undefined,
      maxIterations,
    })
    const pipeline = createPipeline([])

    async function* runAgent(): AsyncIterable<string> {
      yield* pipeline.pipe(strategy.run(message, ctx))
    }

    reqLogger.info({ message: message.slice(0, 100) }, 'Chat request received')

    await sseStream(runAgent(), reply)
  })
}

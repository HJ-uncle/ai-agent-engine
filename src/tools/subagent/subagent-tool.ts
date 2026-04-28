import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { v4 as uuidv4 } from 'uuid'
import { createLLMAdapter } from '../../core/llm-adapter/index.js'
import { ReActStrategy } from '../../core/agent-loop/react.js'
import { createToolRegistry } from '../registry-factory.js'
import { createAgentContext } from '../../core/agent-context/factory.js'
import { SQLiteConversationHistory } from '../../storage/conversation/index.js'

/**
 * Subagent 工具
 * 
 * 创建一个子代理来执行特定任务，支持自定义系统提示词、模型和最大步数。
 * 子代理会在独立的会话中运行，完成后返回结果。
 */
export const subagentTool: Tool = {
  name: 'subagent',
  displayName: '子代理',
  description: '创建子代理执行任务',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      systemPrompt: { type: 'string' },
      model: { type: 'string' },
      maxSteps: { type: 'integer', description: '默认10' }
    },
    required: ['task']
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { task, systemPrompt, model, maxSteps = 10 } = rawArgs as any

    try {
      // 创建独立的子会话 ID
      const subSessionId = `subagent-${uuidv4()}`
      ctx.logger.info(`[Subagent] 开始执行任务: ${task.slice(0, 50)}...`)
      ctx.logger.info(`[Subagent] 子会话 ID: ${subSessionId}`)

      // 创建子代理的工具注册表
      const { registry: subRegistry, memory: subMemory, externalSkills } = await createToolRegistry()

      // 构建子代理的系统提示词
      const baseSystemPrompt = systemPrompt || `你是一个专业的子代理，专注于完成特定任务。请清晰思考，分步执行，确保任务完成后提供详细的总结。`
      const skillsPrompt = buildSkillsSystemPrompt(externalSkills)
      const finalSystemPrompt = [baseSystemPrompt, skillsPrompt].filter(Boolean).join('\n\n')

      // 创建子代理上下文
      const subCtx = createAgentContext({
        sessionId: subSessionId,
        tenantId: ctx.tenantId,
        tools: subRegistry,
        memory: subMemory,
        history: new SQLiteConversationHistory(),
        logger: ctx.logger.child({ subSessionId }),
        tokenBudget: ctx.tokenBudget,
        signal: ctx.signal
      })

      // 创建 LLM 适配器
      const llm = createLLMAdapter(model || 'gpt-4o-mini')

      // 使用 ReAct 策略执行子代理
      const strategy = new ReActStrategy(llm, {
        maxIterations: maxSteps,
        systemPrompt: finalSystemPrompt,
      })

      // 执行子代理
      let result = ''
      for await (const chunk of strategy.run([
        { role: 'user', content: task }
      ], subCtx)) {
        result += chunk
      }

      // 清理子代理内存（使用 forget 方法清理）
      const memories = await subMemory.list({ tenantId: subCtx.tenantId, sessionId: subCtx.sessionId })
      for (const memory of memories) {
        await subMemory.forget(memory.key, { tenantId: subCtx.tenantId, sessionId: subCtx.sessionId })
      }

      ctx.logger.info(`[Subagent] 任务执行完成，结果长度: ${result.length}`)
      return {
        success: true,
        output: `✅ 子代理任务执行完成\n\n${result}`
      }
    } catch (err: any) {
      ctx.logger.error(`[Subagent] 执行失败: ${err.message}`)
      return {
        success: false,
        output: `❌ 子代理执行失败: ${err.message}`
      }
    }
  }
}

/**
 * 构建技能系统提示词
 */
function buildSkillsSystemPrompt(externalSkills: any[]): string {
  if (externalSkills.length === 0) return ''
  
  const skillsList = externalSkills.map((s) => {
    const params = Object.entries(s.parameters?.properties || {}).map(([key, prop]: any) => {
      return `  ${key}: ${prop.description || '无描述'}`
    }).join('\n')
    return `- ${s.name}: ${s.description}\n${params}`
  }).join('\n')
  
  return `## 可用技能\n\n${skillsList}`
}

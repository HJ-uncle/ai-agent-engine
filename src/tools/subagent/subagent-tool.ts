import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { v4 as uuidv4 } from 'uuid'
import path from 'node:path'
import fs from 'node:fs'
import { createLLMAdapter } from '../../core/llm-adapter/index.js'
import { ReActStrategy } from '../../core/agent-loop/react.js'
import { createToolRegistry } from '../registry-factory.js'
import { createAgentContext } from '../../core/agent-context/factory.js'
import { SQLiteConversationHistory } from '../../storage/conversation/index.js'
import { skillsRegistry } from '../../skills/index.js'
import { resolveSuperpowerMode, SUPERPOWER_MODE_CONFIG } from '../../core/superpower.js'

/**
 * Subagent 工具
 *
 * 创建一个子代理来执行特定任务，支持自定义系统提示词、模型和最大步数。
 * 子代理会在独立的会话中运行，完成后返回结果。
 *
 * 可选 `role` 参数（方法论模式下推荐使用）：
 *   - `implementer`          — 执行 TDD 实现
 *   - `spec-reviewer`        — 对照 spec 审查实现
 *   - `code-quality-reviewer`— 代码质量审查
 * 设置 role 时会自动加载 `SKILLs/superpower-subagent-driven-dev/<role>-prompt.md`
 * 作为默认系统提示词基底；调用方如另外给了 `systemPrompt` 则 append 到其后。
 */
export const ROLE_VALUES = ['implementer', 'spec-reviewer', 'code-quality-reviewer'] as const
export type SubagentRole = typeof ROLE_VALUES[number]

const ROLE_SKILL_DIR = 'superpower-subagent-driven-dev'

/**
 * 根据 role 名加载对应的 prompt 模板。
 * 定位路径：skillsRegistry 中 `superpower-subagent-driven-dev` 技能 SKILL.md
 *           所在目录下的 `<role>-prompt.md`。
 * 找不到时返回 null（调用方会 warn + 回退默认行为）。
 */
export function __loadRoleTemplateForTests(role: SubagentRole): string | null {
  return loadRoleTemplate(role)
}

function loadRoleTemplate(role: SubagentRole): string | null {
  const bundleSkill = skillsRegistry.getSkills().find(
    (s) => s.name.toLowerCase() === ROLE_SKILL_DIR.toLowerCase() ||
      (s.skillMdPath && path.basename(path.dirname(s.skillMdPath)).toLowerCase() === ROLE_SKILL_DIR),
  )
  if (!bundleSkill || !bundleSkill.skillMdPath) return null
  const promptPath = path.join(path.dirname(bundleSkill.skillMdPath), `${role}-prompt.md`)
  try {
    if (!fs.existsSync(promptPath)) return null
    const raw = fs.readFileSync(promptPath, 'utf-8')
    return raw.trim() ? raw : null
  } catch {
    return null
  }
}

export const subagentTool: Tool = {
  name: 'subagent',
  displayName: '子代理',
  description:
    '创建子代理执行任务；可选 role 参数（implementer / spec-reviewer / code-quality-reviewer）'
    + ' 会自动加载 superpower-subagent-driven-dev 技能下的对应 prompt 模板作为系统提示词基底。',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      systemPrompt: { type: 'string' },
      model: { type: 'string' },
      maxSteps: { type: 'integer', description: '默认10' },
      role: {
        type: 'string',
        enum: [...ROLE_VALUES],
        description: '可选：启用方法论子代理预设角色（仅在 methodology/max 模式下生效）'
      }
    },
    required: ['task']
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { task, systemPrompt, model, maxSteps = 10, role } = rawArgs as {
      task: string
      systemPrompt?: string
      model?: string
      maxSteps?: number
      role?: SubagentRole
    }

    // 输入校验：role 若提供必须是三值之一（schema 层已限制，但做双保险）
    if (role !== undefined && !(ROLE_VALUES as readonly string[]).includes(role)) {
      return {
        success: false,
        output: `❌ subagent: 未知 role '${role}'，可选值为 ${ROLE_VALUES.join(' / ')}`,
      }
    }

    try {
      // 创建独立的子会话 ID
      const subSessionId = `subagent-${uuidv4()}`
      ctx.logger.info(`[Subagent] 开始执行任务: ${task.slice(0, 50)}...`)
      ctx.logger.info(`[Subagent] 子会话 ID: ${subSessionId}`)

      // 创建子代理的工具注册表
      const { registry: subRegistry, memory: subMemory, externalSkills } = await createToolRegistry()

      // ── 构建子代理的系统提示词 ────────────────────────────────────────
      // 优先级：
      //   1. role 预设模板（方法论角色，仅 methodology/max 模式下生效；其它模式
      //      降级到默认行为并 warn）
      //   2. 调用方 systemPrompt（如果 role 存在则 append 到模板之后）
      //   3. 内置默认
      // skill 索引附加在末尾（保留原行为）。
      const mode = resolveSuperpowerMode(ctx.logger)
      let rolePreamble = ''
      if (role) {
        if (!SUPERPOWER_MODE_CONFIG[mode].methodology) {
          ctx.logger.warn(
            { role, mode },
            '[Subagent] role 参数仅在 methodology/max 模式下生效，当前模式降级为默认行为',
          )
        } else {
          const tpl = loadRoleTemplate(role)
          if (tpl) {
            rolePreamble = tpl
          } else {
            ctx.logger.warn(
              { role, skill: ROLE_SKILL_DIR },
              '[Subagent] role prompt 模板缺失，降级为默认行为',
            )
          }
        }
      }

      const defaultPrompt = `你是一个专业的子代理，专注于完成特定任务。请清晰思考，分步执行，确保任务完成后提供详细的总结。`
      const basePrompt = rolePreamble
        ? [rolePreamble, systemPrompt].filter(Boolean).join('\n\n---\n\n')
        : (systemPrompt || defaultPrompt)

      const skillsPrompt = buildSkillsSystemPrompt(externalSkills)
      const finalSystemPrompt = [basePrompt, skillsPrompt].filter(Boolean).join('\n\n')

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
      const llm = createLLMAdapter({ model: model || 'gpt-4o-mini' })

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

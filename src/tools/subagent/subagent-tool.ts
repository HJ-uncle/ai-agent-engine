import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { v4 as uuidv4 } from 'uuid'
import path from 'node:path'
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import { createLLMAdapterWithDbConfig } from '../../core/llm-adapter/index.js'
import { ModelsStore } from '../../storage/sqlite/models.js'
import { ReActStrategy } from '../../core/agent-loop/react.js'
import { createToolRegistry } from '../registry-factory.js'
import { createAgentContext } from '../../core/agent-context/factory.js'
import { SQLiteConversationHistory } from '../../storage/conversation/index.js'
import { skillsRegistry } from '../../skills/index.js'
import { resolveOSMMode, OSM_MODE_CONFIG } from '../../core/osm.js'

/** 内层执行摘要：一次工具调用的名字 / 参数摘要 / 成败 */
export interface SubagentToolCall {
  name: string
  success: boolean
  summary: string
}

/** 附在子代理输出末尾的执行元数据（客户端解析后渲染子代理卡片） */
export interface SubagentMeta {
  toolCalls: SubagentToolCall[]
  tokens: number
  durationMs: number
}

export const SUBAGENT_META_MARKER = '__SUBAGENT_META__'

// ── 子代理取消注册表 ─────────────────────────────────────────────────────────
// key: 父会话中该次 subagent 工具调用的 toolCallId（前端子代理卡片上的「停止」按钮
// 通过 POST /subagent/cancel { sessionId, toolCallId } 找到对应控制器并中断，
// 只停该子代理，不影响主会话与其余并行子代理）。
const activeSubagents = new Map<string, AbortController>()

function subagentKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`
}

/** 取消指定子代理；返回是否确实存在并在运行 */
export function cancelSubagent(sessionId: string, toolCallId: string, reason = 'Stopped by user'): boolean {
  const key = subagentKey(sessionId, toolCallId)
  const controller = activeSubagents.get(key)
  if (!controller || controller.signal.aborted) return false
  try { controller.abort(new Error(reason)) } catch { /* noop */ }
  return true
}

/** 摘要优先取的参数键（与前端工具摘要口径一致） */
const SUMMARY_KEYS = ['path', 'command', 'pattern', 'query', 'url', 'task', 'question', 'title', 'name']

function pickSummary(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  for (const key of SUMMARY_KEYS) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'string' && value) {
      const oneLine = value.replace(/\s+/g, ' ').trim()
      return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine
    }
  }
  return ''
}

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
 * 设置 role 时会自动加载 `SKILLs/os-subagent-driven-dev/<role>-prompt.md`
 * 作为默认系统提示词基底；调用方如另外给了 `systemPrompt` 则 append 到其后。
 */
export const ROLE_VALUES = ['implementer', 'spec-reviewer', 'code-quality-reviewer'] as const
export type SubagentRole = typeof ROLE_VALUES[number]

const ROLE_SKILL_DIR = 'os-subagent-driven-dev'

/**
 * 根据 role 名加载对应的 prompt 模板。
 * 定位路径：skillsRegistry 中 `os-subagent-driven-dev` 技能 SKILL.md
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

/**
 * 解析子代理的 LLM 适配器，与 chat 路由共用同一套配置源：
 *   1. 请求的模型名在 ModelsStore（IDE 模型页配置）里 → 复用其完整凭据
 *   2. 模型存在但 apiKey 为空（解密失败/未填）→ 整体回退默认配置，避免模型名与
 *      env 端点不匹配造成 404
 *   3. ModelsStore 查不到 → 只传模型名，凭据走 system_config / env
 *   4. 未指定模型 → 全默认
 */
async function resolveSubagentLLM(
  requested: string | undefined,
  ctx: AgentContext
): Promise<ReturnType<typeof createLLMAdapterWithDbConfig>> {
  // 透传主会话已解析好的模型能力（chat.ts 挂在 ctx.modelCaps 上）。
  // 缺失时适配器会退化为按 baseURL 启发式猜测能力（detectVisionSupport 默认 true），
  // 自定义网关 + 非视觉模型的组合会被误判成视觉模型，消息被包装成多模态数组，
  // 严格校验 content 类型的网关直接 400 —— 子代理首轮 LLM 调用失败就是这么来的。
  const capabilities = ctx.modelCaps ?? undefined
  if (!requested) return createLLMAdapterWithDbConfig({ capabilities })
  try {
    const info = (await new ModelsStore().getModels(ctx.tenantId)).find(
      (m) => m.modelId === requested
    )
    if (info?.apiKey) {
      return createLLMAdapterWithDbConfig({
        model: info.modelId,
        apiKey: info.apiKey,
        baseUrl: info.baseUrl,
        provider: info.provider,
        capabilities
      })
    }
    if (info) {
      ctx.logger.warn(
        { model: requested },
        '[Subagent] model found in DB but apiKey is unavailable, falling back to default config'
      )
      return createLLMAdapterWithDbConfig({ capabilities })
    }
  } catch (err) {
    ctx.logger.warn({ err, model: requested }, '[Subagent] failed to resolve model from DB, falling back')
  }
  return createLLMAdapterWithDbConfig({ model: requested, capabilities })
}

export const subagentTool: Tool = {
  name: 'subagent',
  displayName: '子代理',
  description:
    '创建子代理执行独立任务。适合：需要读大量文件的调研/审计、跨多个目录的探索、'
    + '与主任务相互独立的并行子问题。不适合：一两步就能完成的定向小查、需要持续交互的修改类工作。'
    + 'task 必须自包含（子代理看不到本会话历史）：写清目标、范围（目录/文件）、'
    + '期望输出格式（结论先行、发现带 路径+行号）与已知线索。'
    + '可选 role 参数（implementer / spec-reviewer / code-quality-reviewer）'
    + ' 会自动加载 os-subagent-driven-dev 技能下的对应 prompt 模板作为系统提示词基底。',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      systemPrompt: { type: 'string' },
      model: { type: 'string' },
      maxSteps: { type: 'integer', description: '默认24' },
      role: {
        type: 'string',
        enum: [...ROLE_VALUES],
        description: '可选：启用方法论子代理预设角色（仅在 methodology/max 模式下生效）'
      }
    },
    required: ['task']
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const args = rawArgs as {
      task?: string
      systemPrompt?: string
      model?: string
      maxSteps?: number
      role?: SubagentRole
    }
    const { model, maxSteps = 24, role } = args

    // 兼容性兜底：实测部分模型（deepseek-flash）在并行派发长任务时会把 task
    // 写成空串甚至省略，而完整任务文本出现在 systemPrompt 里 —— 此时把
    // systemPrompt 当任务正文使用，避免子代理拿着空任务空转。
    // 同时保证 task 恒为字符串，下游 task.slice 不会崩。
    const taskRaw = typeof args.task === 'string' ? args.task : ''
    const systemPrompt = typeof args.systemPrompt === 'string' ? args.systemPrompt : undefined
    const task = taskRaw.trim() !== '' ? taskRaw : (systemPrompt ?? '')
    const effectiveSystemPrompt = taskRaw.trim() !== '' ? systemPrompt : undefined

    if (task.trim() === '') {
      return {
        success: false,
        output:
          '❌ subagent: task 参数为空。请把完整的任务描述（目标、步骤、绝对路径约束）作为 task 字符串传入，不要省略或传空字符串。',
      }
    }

    // 输入校验：role 若提供必须是三值之一（schema 层已限制，但做双保险）
    if (role !== undefined && !(ROLE_VALUES as readonly string[]).includes(role)) {
      return {
        success: false,
        output: `❌ subagent: 未知 role '${role}'，可选值为 ${ROLE_VALUES.join(' / ')}`,
      }
    }

    // ── 取消句柄（提升到 try 外声明，catch/finally 里要用）────────────────
    // 子代理使用独立的 AbortController（主会话 abort 时一并联动中断），
    // 并以父会话 toolCallId 为 key 注册到全局表，供 /subagent/cancel 单独停止。
    const subAbort = new AbortController()
    const onParentAbort = () => {
      try { subAbort.abort((ctx.signal as AbortSignal).reason ?? new Error('Parent aborted')) } catch { /* noop */ }
    }
    if (ctx.signal) {
      if (ctx.signal.aborted) onParentAbort()
      else ctx.signal.addEventListener('abort', onParentAbort, { once: true })
    }
    const parentToolCallId = ctx.currentToolCallId
    const registryKey = parentToolCallId ? subagentKey(ctx.sessionId, parentToolCallId) : null
    if (registryKey) activeSubagents.set(registryKey, subAbort)

    try {
      // 创建独立的子会话 ID
      const subSessionId = `subagent-${uuidv4()}`
      ctx.logger.info(`[Subagent] 开始执行任务: ${task.slice(0, 50)}...`)
      ctx.logger.info(`[Subagent] 子会话 ID: ${subSessionId}`)

      // 创建子代理的工具注册表；摘掉 subagent 自身，防止子代理递归派发空转
      const { registry: subRegistry, externalSkills } = await createToolRegistry()
      subRegistry.unregister('subagent')

      // ── 构建子代理的系统提示词 ────────────────────────────────────────
      // 优先级：
      //   1. role 预设模板（方法论角色，仅 methodology/max 模式下生效；其它模式
      //      降级到默认行为并 warn）
      //   2. 调用方 systemPrompt（如果 role 存在则 append 到模板之后）
      //   3. 内置默认
      // skill 索引附加在末尾（保留原行为）。
      const mode = resolveOSMMode(ctx.logger)
      let rolePreamble = ''
      if (role) {
        if (!OSM_MODE_CONFIG[mode].methodology) {
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

      const defaultPrompt = [
        '你是一个专业的子代理，专注于完成调用方交给你的任务。',
        '执行须知：',
        '- 你的工作区与主会话一致（相对路径以主工作区为基准），可直接读写调用方指定的项目；',
        '- 任务里给出的绝对路径可以直接用工具访问（读取文件/列出文件/查找文件均支持绝对路径），不要只在当前工作区里翻找；',
        '- 不要查找附件或上传文件，除非任务明确提到有附件；',
        '- 你的任务就是首条 user 消息里的内容：不要因为工作区里出现无关文件就改变目标，也不要用历史记忆替代任务本身；',
        '- 你没有安全审批渠道：需要用户授权的操作（例如带 shell 元字符的命令）会被安全策略拦截，一旦被拦截任务立即失败。优先用读文件/搜索类工具，把需要执行命令的部分留给调用方；',
        '- 结束时必须用纯文本写出你的完整结论 —— 文字输出是调用方唯一能直接收到的返回值，只写文件不做总结等于没有产出；',
        '- 直接按任务步骤执行。你没有向调用方提问的渠道，任务描述有歧义时按最合理的方式处理，并在结果中说明你的假设。',
        '',
        '—— 产出与执行纪律（与主会话对齐）——',
        '- 一次委派只做一件事；调研/审计类任务先建立待办清单（todo 工具），系统性逐项推进，不要零散东看西看；',
        '- 互相独立的读取/搜索尽量放在同一轮并行发出，不要串行排队等待；',
        '- 结论先行：最终结果用结构化文本给出（结论 → 证据 → 定位），涉及代码的发现必须带 文件路径 + 行号，不要贴大段源码；',
        '- 不复述过程：不要把"我读了哪些文件、调了哪些工具"写进结果，调用方只需要你的结论；',
        '- 失败或信息不足时如实交还：说清卡在哪一步、缺什么信息，不要编造结果。',
      ].join('\n')
      const basePrompt = rolePreamble
        ? [rolePreamble, effectiveSystemPrompt].filter(Boolean).join('\n\n---\n\n')
        : (effectiveSystemPrompt || defaultPrompt)

      const skillsPrompt = buildSkillsSystemPrompt(externalSkills)
      const finalSystemPrompt = [basePrompt, skillsPrompt].filter(Boolean).join('\n\n')

      // 创建子代理上下文
      // 必须继承主会话的 workspacePaths：否则子代理的相对路径会落到引擎沙箱
      // （<WORKSPACE_ROOT>/<tenant>/<session>），表现为「子代理的工作目录不对」——
      // 它看不到调用方正在开发的项目，execute_cmd 也在错误目录里执行。
      // 沙箱目录仍会作为兜底 base 追加在 workspacePaths 之后。
      const subCtx = createAgentContext({
        sessionId: subSessionId,
        tenantId: ctx.tenantId,
        workspacePaths: ctx.workspacePaths,
        tools: subRegistry,
        history: new SQLiteConversationHistory(),
        logger: ctx.logger.child({ subSessionId }),
        tokenBudget: ctx.tokenBudget,
        signal: subAbort.signal
      })

      // 创建 LLM 适配器。
      // 模型解析优先级：显式 model 参数 > 主会话模型（ctx.modelName）> DB/env 默认。
      // 必须走 WithDbConfig 工厂：模型凭据存在 DB（ModelsStore，IDE 模型页配置），
      // 同步工厂只认 env —— 拿不到 key 会报「OpenAI API Key 未配置」
      const requestedModel = model || ctx.modelName
      const llm = await resolveSubagentLLM(requestedModel, ctx)

      // 使用 ReAct 策略执行子代理
      const strategy = new ReActStrategy(llm, {
        maxIterations: maxSteps,
        systemPrompt: finalSystemPrompt,
      })

      // 执行子代理：内层 ReAct 流的控制帧（\x00 开头）不会转发到外层 SSE，
      // 在这里就地解析 tool_start/tool_end/usage，汇总成执行摘要随结果带给客户端
      const startedAt = performance.now()
      let result = ''
      const toolCallsById = new Map<string, SubagentToolCall & { order: number }>()
      let tokens = 0
      // 内层被安全策略拦截（或子代理试图向用户提问）时记录的信息。
      // 子代理没有授权/提问渠道，这类帧一出现内层 ReAct 就会挂起结束、结果为空，
      // 必须如实上报，否则调用方只会收到一句「任务执行完成」。
      let blocked: { toolName: string; description: string; args: unknown } | null = null
      for await (const chunk of strategy.run(
        [{ role: 'user', content: task }],
        subCtx
      )) {
        if (chunk.includes('\x00')) {
          // ── 内层控制帧：提取执行摘要后丢弃，不混入结果文本 ──
          try {
            if (chunk.startsWith('\x00__tool_start__')) {
              const frame = JSON.parse(chunk.slice('\x00__tool_start__'.length)) as {
                name?: string
                args?: unknown
                toolCallId?: string
              }
              const id = frame.toolCallId ?? `call-${toolCallsById.size}`
              toolCallsById.set(id, {
                name: frame.name ?? '未知工具',
                success: true,
                summary: pickSummary(frame.args),
                order: toolCallsById.size
              })
            } else if (chunk.startsWith('\x00__tool_end__')) {
              const frame = JSON.parse(chunk.slice('\x00__tool_end__'.length)) as {
                toolCallId?: string
                success?: boolean
              }
              const id = frame.toolCallId ?? ''
              const existing = toolCallsById.get(id)
              if (existing) existing.success = frame.success !== false
            } else if (chunk.startsWith('\x00__permission_request__')) {
              const frame = JSON.parse(chunk.slice('\x00__permission_request__'.length)) as {
                toolName?: string
                description?: string
                args?: unknown
              }
              blocked = {
                toolName: frame.toolName ?? '未知工具',
                description: frame.description ?? '',
                args: frame.args,
              }
            } else if (chunk.startsWith('\x00__usage__')) {
              const frame = JSON.parse(chunk.slice('\x00__usage__'.length)) as { totalTokens?: number }
              if (typeof frame.totalTokens === 'number') tokens = frame.totalTokens
            }
          } catch {
            // 摘要解析失败不影响子代理本身
          }
          continue
        }
        result += chunk
      }
      const durationMs = Math.round(performance.now() - startedAt)

      ctx.logger.info(`[Subagent] 任务执行完成，结果长度: ${result.length}`)
      const meta: SubagentMeta = {
        toolCalls: [...toolCallsById.values()].sort((a, b) => a.order - b.order),
        tokens,
        durationMs
      }

      // ── 被手动停止（/subagent/cancel）──────────────────────────────────
      // 子 AbortController 被触发但主会话仍在运行：走失败结果返回给主会话，
      // 由主会话的 LLM 决定如何继续（不能用 throw，那会被 ReAct 视为整轮 abort）。
      if (subAbort.signal.aborted && !ctx.signal?.aborted) {
        return {
          success: false,
          output: `🛑 子代理已被手动停止，未产出完整结果。${result.trim() ? `\n\n已产生的部分内容：\n${result}` : ''}\n${SUBAGENT_META_MARKER}${JSON.stringify(meta)}`
        }
      }

      // ── 空结果兜底 ────────────────────────────────────────────────────
      // 内层循环有两种「正常返回但一个字都没有」的情况，绝不能报成成功：
      //   1) 被安全策略拦截（子代理无审批渠道）→ 内层立即挂起结束
      //   2) 模型只写了文件、没产出任何文字总结
      if (result.trim() === '') {
        const written = meta.toolCalls
          .filter((call) => /write|edit|patch/i.test(call.name))
          .map((call) => call.summary)
          .filter(Boolean)
        const reason = blocked
          ? `子代理被安全策略拦截后中止 —— 子代理没有向用户申请授权的渠道，被拦截即等于任务失败。\n- 被拦截的工具：${blocked.toolName}\n- 拦截原因：${blocked.description}\n- 调用参数：${JSON.stringify(blocked.args)}`
          : '子代理没有输出任何文字结果（可能只写了文件、没有做文字总结）。'
        const wroteHint = written.length > 0 ? `\n- 它已写入的文件：${written.join('、')}` : ''
        return {
          success: false,
          output: `⚠️ 子代理未产出可用结果。\n\n${reason}${wroteHint}\n\n建议：改用不需要授权的工具（读文件/搜索），或由主会话先完成需要审批的操作。\n${SUBAGENT_META_MARKER}${JSON.stringify(meta)}`
        }
      }

      return {
        success: true,
        output: `✅ 子代理任务执行完成\n\n${result}\n${SUBAGENT_META_MARKER}${JSON.stringify(meta)}`
      }
    } catch (err: any) {
      // 主动停止（含 /subagent/cancel 触发的 AbortError）按失败结果返回，
      // 不抛给 ReAct —— 抛异常会被判成整轮 abort，把主会话也一起停掉。
      const isAbort = err?.name === 'AbortError' || subAbort.signal.aborted
      if (isAbort && !ctx.signal?.aborted) {
        return {
          success: false,
          output: '🛑 子代理已被手动停止，未产出完整结果。'
        }
      }
      ctx.logger.error(`[Subagent] 执行失败: ${err.message}`)
      return {
        success: false,
        output: `❌ 子代理执行失败: ${err.message}`
      }
    } finally {
      if (registryKey) activeSubagents.delete(registryKey)
      if (ctx.signal) ctx.signal.removeEventListener('abort', onParentAbort)
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

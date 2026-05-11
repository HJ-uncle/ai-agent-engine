import path from 'node:path'
import fs from 'node:fs'
import type { AgentContext, CreateAgentContextOptions } from './types.js'
import { applySuperpowerMultiplier, resolveSuperpowerMode, SUPERPOWER_MODE_CONFIG } from '../superpower.js'

export function createAgentContext(options: CreateAgentContextOptions): AgentContext {
  const tenantId = options.tenantId ?? 'default'
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? './workspace'
  const workspaceDir = path.resolve(workspaceRoot, tenantId, options.sessionId)

  // Auto-create workspace directory
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true })
  }

  // ── Superpower 方法论 artifact 目录 ──────────────────────────────────────
  // 当模式为 methodology / max 时，创建 docs/superpower/{specs,plans,reviews}/
  // 让方法论技能无需先 `create_dir` 就可以直接写文件。
  // 失败只 warn，不 throw（只读 workspace 也要能跑）。
  const mode = resolveSuperpowerMode(options.logger)
  if (SUPERPOWER_MODE_CONFIG[mode].artifactDirs) {
    const triad = ['specs', 'plans', 'reviews']
    for (const sub of triad) {
      const p = path.join(workspaceDir, 'docs', 'superpower', sub)
      try {
        fs.mkdirSync(p, { recursive: true })
      } catch (err) {
        options.logger.warn(
          { path: p, err: (err as Error)?.message ?? String(err) },
          'superpower: failed to create artifact directory',
        )
      }
    }
  }

  // tokenBudget 决策顺序：
  //   1. options.tokenBudget 显式传入 → 原样使用（如 subagent 为子代理限定预算的场景，
  //      这个数字是调用方经过推导的，不应再被 superpower 倍率干预）
  //   2. 未显式传入 → 读 env 默认值（60000），再按 superpower 开关应用倍率
  //
  // 之前的实现把显式 options.tokenBudget 也乘以倍率，会把子代理预算无意放大 5×，
  // 这里通过 hasExplicitBudget 区分，避免该问题。
  const hasExplicitBudget = typeof options.tokenBudget === 'number'
  const envDefaultBudget = parseInt(process.env.TOKEN_BUDGET ?? '60000', 10)
  const tokenBudget = hasExplicitBudget
    ? (options.tokenBudget as number)
    : applySuperpowerMultiplier('tokenBudget', envDefaultBudget)

  return {
    tenantId,
    sessionId: options.sessionId,
    workspaceDir,
    workspacePaths: options.workspacePaths,
    tools: options.tools,
    memory: options.memory,
    history: options.history,
    logger: options.logger.child({ tenantId, sessionId: options.sessionId }),
    tokenBudget,
    requestId: options.requestId,
    signal: options.signal,
    inheritContext: options.inheritContext,
  }
}

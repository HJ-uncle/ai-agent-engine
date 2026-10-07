import path from 'node:path'
import fs from 'node:fs'
import type { AgentContext, CreateAgentContextOptions } from './types.js'
import { applyOSMMultiplier, resolveOSMMode, OSM_MODE_CONFIG } from '../osm.js'
import { bindHistoryGeneration } from '../../storage/conversation/serialization.js'

export function createAgentContext(options: CreateAgentContextOptions): AgentContext {
  const tenantId = options.tenantId ?? 'default'
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? './workspace'
  const workspaceDir = path.resolve(options.scratchDir ?? path.join(workspaceRoot, tenantId, options.sessionId))
  const projectRoot = path.resolve(options.projectRoot ?? options.workspacePaths?.[0] ?? options.cwd ?? workspaceDir)
  const cwd = path.resolve(options.cwd ?? projectRoot)

  // Auto-create workspace directory
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true })
  }

  // ── OSM 方法论 artifact 目录 ──────────────────────────────────────
  // 当模式为 methodology / max 时，确保 .openspec/ 根目录存在。
  // 具体的 feature 目录由技能（如 brainstorming）在运行时根据任务名创建。
  const mode = resolveOSMMode(options.logger)
  if (OSM_MODE_CONFIG[mode].artifactDirs) {
    const p = path.join(workspaceDir, '.openspec', 'changes')
    try {
      fs.mkdirSync(p, { recursive: true })
    } catch (err) {
      options.logger.warn(
        { path: p, err: (err as Error)?.message ?? String(err) },
        'OSM: failed to create .openspec directory',
      )
    }
  }

  // tokenBudget 决策顺序：
  //   1. options.tokenBudget 显式传入 → 原样使用（如 subagent 为子代理限定预算的场景，
  //      这个数字是调用方经过推导的，不应再被 superpower 倍率干预）
  //   2. 未显式传入 → 读 env TOKEN_BUDGET，再按 superpower 开关应用倍率
  //   3. env 也没配 → **不设本地预算**（没有 tokenBudget 键）
  //
  // 之前的实现把显式 options.tokenBudget 也乘以倍率，会把子代理预算无意放大 5×，
  // 这里通过 hasExplicitBudget 区分，避免该问题。
  //
  // 第 3 条同样是后补的。原来 env 缺省时写死 60000，经 balanced 倍率 2 恰好得到 120000，
  // 卡在 128k 窗口下沿：react.ts 的有效窗口取 min(预算, 窗口)，于是引擎比模型早 8k 就
  // 拒绝请求（报 "Request input (112210) plus output reservation (8192) exceeds context
  // window (120000)"，而模型真实窗口远大于此，或者能力表本身就低估了窗口）。
  // 让人为推导出来的预算去限制实际可用空间是本末倒置：没有显式配置时不注入预算，
  // 由模型窗口/服务端决定上限，避免"引擎比模型更早拒答"。
  const unboundedCode = options.toolProfile === 'code'
  const hasExplicitBudget = !unboundedCode && typeof options.tokenBudget === 'number'
  const configuredBudget = parseInt(process.env.TOKEN_BUDGET ?? '', 10)
  const hasEnvBudget = !unboundedCode && Number.isFinite(configuredBudget) && configuredBudget > 0
  const tokenBudget = hasExplicitBudget
    ? (options.tokenBudget as number)
    : hasEnvBudget
      ? applyOSMMultiplier('tokenBudget', configuredBudget)
      : undefined

  return {
    ...options,
    tenantId,
    sessionId: options.sessionId,
    workspaceDir,
    scratchDir: workspaceDir,
    projectRoot,
    cwd,
    workspacePaths: options.workspacePaths,
    tools: options.tools,
    history: bindHistoryGeneration(options.history, tenantId, options.sessionId),
    logger: options.logger.child({ tenantId, sessionId: options.sessionId }),
    tokenBudget,
    requestId: options.requestId,
    signal: options.signal,
    inheritContext: options.inheritContext,
    modelName: options.modelName,
    modelCaps: options.modelCaps,
    resolvedModel: options.resolvedModel,
    subagentModel: options.subagentModel,
    utilityModel: options.utilityModel,
    onRequestAttempt: options.onRequestAttempt,
    requestBudget: options.requestBudget,
    finalizationReserveTokens: options.finalizationReserveTokens,
  }
}

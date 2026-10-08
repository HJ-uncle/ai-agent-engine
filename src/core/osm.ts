/**
 * OpenSpec Methodology (OSM)
 *
 * Layer 2 —— 从单布尔 `SUPERPOWER_ENABLED` 升级为四档 `OSM_MODE`：
 *
 *   off          — 关闭：仅 CORE 工具集，基准数值，无方法论注入
 *   balanced     — 均衡：全量工具，倍率 ×2，无方法论注入
 *   methodology  — OpenSpec 方法论：全量工具，倍率 ×2，注入 bootstrap，创建 artifact 目录
 *   max          — OpenSpec 极致：全量工具，倍率 ×5，注入 bootstrap，artifact 目录，压缩阈值放宽到 0.7
 *
 * 所有细节由下方 `OSM_MODE_CONFIG` 单一真相表驱动；辅助函数
 * （`applyOSMMultiplier` / `getOSMCompressRatio` /
 *  `resolveDefaultAllowedTools`）均通过它派发逻辑，避免散落。
 *
 * 兼容层：`SUPERPOWER_ENABLED` 仍作为 soft alias 存在一个 minor 周期：
 *   - true  → methodology（首次解析时打一次 deprecation warn）
 *   - false → off
 *   `OSM_MODE` 一旦被识别为合法值即优先使用。
 *
 * 方法论骨架（brainstorm / TDD / review 流程）由 Layer 2 的
 * os-* 技能包 + `superpower-bootstrap.ts` 的系统提示词前置注入 承担。
 */

import type { Logger } from 'pino'
import { logger as defaultLogger } from '../observability/index.js'

// ── 模式枚举 ─────────────────────────────────────────────────────────────
export type OSMMode = 'off' | 'balanced' | 'methodology' | 'max'

/** @deprecated Use OSMMode */
export type SuperpowerMode = OSMMode

export const OSM_MODES: readonly OSMMode[] = [
  'off', 'balanced', 'methodology', 'max',
] as const

export function isValidMode(v: unknown): v is OSMMode {
  return typeof v === 'string' && (OSM_MODES as readonly string[]).includes(v)
}

// ── 核心工具（日常必需，始终可用；off 模式下收敛到这个集合）─────────────
export const OSM_CORE_TOOLS: ReadonlySet<string> = new Set([
  // 文件操作（基础）
  'smart_read', 'read_file', 'write_file', 'edit_file', 'list_files', 'create_dir',
  // 用户交互
  'ask_user',
  // 记忆
  'remember', 'recall', 'search_memory',
  // 获取上下文
  'get_current_context',
  // 技能管理
  'list_skills', 'get_skill', 'run_skill_script',
  // 搜索
  'grep', 'glob',
  // 任务追踪
  'todo_list', 'todo_create', 'todo_update', 'todo_delete',
])

// ── 增强工具（仅在 balanced/methodology/max 可用，用于一致性自检）───────
export const OSM_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // 破坏性操作
  'delete_file',
  // 命令执行（高风险）
  'run_command',
  // 网络访问
  'web_fetch', 'http_request',
  // 包管理（系统修改）
  'install_package', 'list_packages',
  // 子代理（资源密集）
  'subagent',
  // 定时任务
  'cron_list', 'cron_create', 'cron_update', 'cron_delete',
  // 后台任务控制
  'task_list', 'task_cancel', 'task_status',
  // Agent 管理
  'agent_list', 'agent_get', 'agent_create', 'agent_do_create',
  'agent_update', 'agent_do_update', 'agent_delete', 'agent_do_delete',
  // LSP 诊断
  'code_diagnose',
])

// ── 倍率字段 & 多档配置表 ────────────────────────────────────────────────
export type OSMMultiplierField =
  | 'tokenBudget'
  | 'maxIterations'
  | 'toolOutputMaxChars'
  | 'historyMaxTokens'

/** @deprecated Use OSMMultiplierField */
export type SuperpowerMultiplierField = OSMMultiplierField

interface OSMModeConfig {
  /** 是否放开全量工具（false 表示会收敛到 CORE 集合） */
  allowAllTools: boolean
  /** 数值字段倍率 */
  multipliers: Readonly<Record<OSMMultiplierField, number>>
  /** 压缩阈值：undefined 表示遵从调用方 baseRatio，数字则直接覆盖 */
  compressRatio?: number
  /** 是否注入方法论 bootstrap */
  methodology: boolean
  /** 是否在 workspace 自动创建 .ae/openspec/ 变更目录骨架 */
  artifactDirs: boolean
}

/**
 * 单一真相表：所有 helper 都通过它派发。
 * 新增 knob 只需增加一列，无需散落到其它文件。
 */
export const OSM_MODE_CONFIG: Readonly<Record<OSMMode, OSMModeConfig>> = {
  off: {
    allowAllTools: false,
    multipliers: { tokenBudget: 1, maxIterations: 1, toolOutputMaxChars: 1, historyMaxTokens: 1 },
    compressRatio: undefined,
    methodology: false,
    artifactDirs: false,
  },
  balanced: {
    allowAllTools: true,
    multipliers: { tokenBudget: 2, maxIterations: 2, toolOutputMaxChars: 2, historyMaxTokens: 2 },
    compressRatio: undefined,
    methodology: false,
    artifactDirs: false,
  },
  methodology: {
    allowAllTools: true,
    multipliers: { tokenBudget: 2, maxIterations: 2, toolOutputMaxChars: 2, historyMaxTokens: 2 },
    compressRatio: undefined,
    methodology: true,
    artifactDirs: true,
  },
  max: {
    allowAllTools: true,
    multipliers: { tokenBudget: 5, maxIterations: 4, toolOutputMaxChars: 4, historyMaxTokens: 4 },
    compressRatio: 0.7,
    methodology: true,
    artifactDirs: true,
  },
}

// ── 一次性告警状态 ───────────────────────────────────────────────────────
let __legacyWarned = false
let __invalidModeWarned = false

/**
 * 测试辅助：重置一次性告警状态（仅供 test 使用，不对外导出稳定 API）。
 * 生产代码请勿调用。
 */
export function __resetOSMWarnFlagsForTests(): void {
  __legacyWarned = false
  __invalidModeWarned = false
}

/**
 * 解析当前 OSM 模式。
 *
 * 优先级：
 *   1. `OSM_MODE` 取值合法 → 使用它
 *   2. 否则若 `OSM_MODE` 有值但非法 → warn 一次并降级到 legacy
 *   3. legacy `SUPERPOWER_ENABLED=true` → methodology（打 deprecation）
 *   4. legacy `SUPERPOWER_ENABLED=false` 或未设置 → off
 *
 * 每次调用都从 `process.env` 读取，保证 PUT /settings 热更新生效。
 *
 * TODO(remove-in-next-minor): 下个 minor 版本移除 `SUPERPOWER_ENABLED` 分支。
 */
export function resolveOSMMode(log: Logger = defaultLogger): OSMMode {
  const rawMode = process.env.OSM_MODE || process.env.SUPERPOWER_MODE
  const rawLegacy = process.env.SUPERPOWER_ENABLED

  // 1. MODE 合法 → 直接使用
  if (rawMode && isValidMode(rawMode)) {
    return rawMode
  }

  // 2. MODE 有值但非法 → 一次性 warn
  if (rawMode && !isValidMode(rawMode) && !__invalidModeWarned) {
    __invalidModeWarned = true
    log.warn(
      { value: rawMode, validValues: OSM_MODES },
      'OSM: OSM_MODE has an unrecognised value — falling back to legacy / off',
    )
  }

  // 3. legacy true → methodology（一次性 deprecation warn）
  if (rawLegacy === 'true') {
    if (!__legacyWarned) {
      __legacyWarned = true
      log.warn(
        {},
        'DEPRECATION: SUPERPOWER_ENABLED is deprecated; use OSM_MODE (off|balanced|methodology|max). ' +
        'Mapping: true→methodology, false→off. Will be removed in the next minor release.',
      )
    }
    return 'methodology'
  }

  // 4. 默认 balanced（legacy=false / 未设置 / 任意其它字符串）
  return 'balanced'
}

/** @deprecated Use resolveOSMMode */
export const resolveSuperpowerMode = resolveOSMMode

/**
 * @deprecated 使用 `resolveOSMMode()`，本函数仅为保持旧 call-site 不崩溃。
 * 将在下个 minor 版本移除。
 */
export function isOSMEnabled(): boolean {
  return resolveOSMMode() !== 'off'
}

/** @deprecated Use isOSMEnabled */
export const isSuperpowerEnabled = isOSMEnabled

/**
 * 对指定整数字段应用 OSM 倍率。
 * `Math.floor(base * M)`，其中 M 从 `OSM_MODE_CONFIG[mode].multipliers` 查表。
 */
export function applyOSMMultiplier(
  field: OSMMultiplierField,
  base: number,
): number {
  const mode = resolveOSMMode()
  const mult = OSM_MODE_CONFIG[mode].multipliers[field]
  return Math.floor(base * mult)
}

/** @deprecated Use applyOSMMultiplier */
export const applySuperpowerMultiplier = applyOSMMultiplier

/**
 * 获取当前模式下的压缩阈值比率。
 *   max → 0.7（宽松，留更多上下文）
 *   off / balanced / methodology → 返回传入的 baseRatio 不变
 */
export function getOSMCompressRatio(baseRatio: number): number {
  const mode = resolveOSMMode()
  const override = OSM_MODE_CONFIG[mode].compressRatio
  return override !== undefined ? override : baseRatio
}

/** @deprecated Use getOSMCompressRatio */
export const getSuperpowerCompressRatio = getOSMCompressRatio

/**
 * 根据 OSM 开关计算最终的工具白名单。
 *
 * 开启全量工具的模式（balanced / methodology / max）：
 *   完全尊重显式配置，不做任何干预（undefined = 全量）
 *
 * 关闭的模式（off）：全局安全阀
 *   - 未配置（undefined/null）→ 仅核心工具
 *   - 显式禁用全部（[]）     → 保持 []（不干预）
 *   - 有显式列表             → 与核心工具取交集
 *                              （保留 Agent 想要的，但自动剔除增强工具）
 *
 * 返回类型统一：undefined / null 都归一化为 undefined，避免 caller 做双重判断。
 */
export function resolveDefaultAllowedTools(
  explicitAllowedTools: string[] | undefined | null,
): string[] | undefined {
  const mode = resolveOSMMode()
  const cfg = OSM_MODE_CONFIG[mode]

  // 全量工具模式 → 完全尊重传入值
  if (cfg.allowAllTools) {
    return explicitAllowedTools == null ? undefined : explicitAllowedTools
  }

  // ── off 模式：收敛到 CORE ──────────────────────────────────────────────
  // 未配置 → 仅核心工具
  if (explicitAllowedTools == null) {
    return [...OSM_CORE_TOOLS]
  }
  // Agent 明确禁用全部工具（[] 语义）→ 保持不变
  if (explicitAllowedTools.length === 0) return []
  // Agent 有显式工具列表 → 与核心工具取交集（剔除增强工具，保留安全工具）
  const intersected = explicitAllowedTools.filter(t => OSM_CORE_TOOLS.has(t))
  // 交集为空时退化为核心工具集（避免 Agent 完全失去工具）
  return intersected.length > 0 ? intersected : [...OSM_CORE_TOOLS]
}

// ── OSM 方法论技能集合 ────────────────────────────────────────────────────

/**
 * OpenSpec 方法论技能集合（精确匹配，不依赖命名约定）。
 *
 * 仅在 methodology / max 档可见；off / balanced 档将这些技能从
 * `list_skills` / `get_skill` 可见列表中过滤掉，避免干扰模型或浪费 Token。
 *
 * 维护规则：新增 os-* 技能时在此集合中同步添加；技能重命名时更新此处，
 * 而无需搜索散落的 `startsWith('os-')` 调用。
 */
export const OSM_METHODOLOGY_SKILL_IDS: ReadonlySet<string> = new Set([
  'os-using-superpowers',
  'os-brainstorming',
  'os-writing-plans',
  'os-tdd',
  'os-systematic-debugging',
  'os-subagent-driven-dev',
  'os-verification-before-completion',
])

/**
 * 判断某技能在当前（或指定）OSM 模式下是否应向 Agent 暴露。
 *
 * - 非方法论技能（不在 OSM_METHODOLOGY_SKILL_IDS 中）→ 恒为 `true`
 * - 方法论技能 → 仅 `methodology` / `max` 返回 `true`
 *
 * @param skillName 技能名称（与 ExternalSkill.name 一致）
 * @param mode      目标档位（省略时实时读取 process.env）
 */
export function isOsmSkillVisible(skillName: string, mode?: OSMMode): boolean {
  if (!OSM_METHODOLOGY_SKILL_IDS.has(skillName)) return true
  const m = mode !== undefined ? mode : resolveOSMMode()
  return OSM_MODE_CONFIG[m].methodology
}

// ── 启动期自检 ────────────────────────────────────────────────────────────
//   1. CORE ∩ ONLY = ∅（一个工具不能既是"基础"又是"增强"）
//   2. CORE 集合内的工具名在实际 registry 中必须全部存在，
//      否则 OFF 模式下 Agent 会静默失去能力。
// 失败时只打 warn，不抛错，因为部分工具可能在运行时按需注册（如 inlineSkills）。

export interface ToolRegistryHandle {
  has?: (name: string) => boolean
  list?: () => Array<{ name: string }>
}

export interface OSMSelfCheckResult {
  /** 同时出现在 CORE 和 ONLY 中的工具名（配置互斥违规） */
  disjointViolations: string[]
  /** CORE 声明但 registry 没注册的工具名（OFF 模式会静默失去能力） */
  missingInRegistry: string[]
  /** registry 有 but CORE/ONLY 都没分类的工具名（仅提示） */
  unknownTools: string[]
}

/** @deprecated Use OSMSelfCheckResult */
export type SuperpowerSelfCheckResult = OSMSelfCheckResult

/**
 * 运行 OSM 配置的一致性自检。
 * 结果为纯数据，允许调用方决定是 log / throw / 上报监控。
 */
export function runOSMSelfCheck(registry: ToolRegistryHandle): OSMSelfCheckResult {
  const disjointViolations: string[] = []
  for (const name of OSM_CORE_TOOLS) {
    if (OSM_ONLY_TOOLS.has(name)) disjointViolations.push(name)
  }

  const missingInRegistry: string[] = []
  const has = typeof registry.has === 'function' ? registry.has.bind(registry) : null
  if (has) {
    for (const name of OSM_CORE_TOOLS) {
      if (!has(name)) missingInRegistry.push(name)
    }
  }

  const unknownTools: string[] = []
  const list = typeof registry.list === 'function' ? registry.list.bind(registry) : null
  if (list) {
    try {
      for (const tool of list()) {
        const n = tool?.name
        if (!n) continue
        if (!OSM_CORE_TOOLS.has(n) && !OSM_ONLY_TOOLS.has(n)) {
          unknownTools.push(n)
        }
      }
    } catch { /* registry.list 可能抛错，忽略 */ }
  }

  return { disjointViolations, missingInRegistry, unknownTools }
}

/** @deprecated Use runOSMSelfCheck */
export const runSuperpowerSelfCheck = runOSMSelfCheck

/** 把自检结果打到 logger（warn 级别，不中断启动）。 */
export function logOSMSelfCheck(logger: Logger, result: OSMSelfCheckResult): void {
  if (result.disjointViolations.length) {
    logger.warn(
      { tools: result.disjointViolations },
      'OSM: tools listed in BOTH CORE and ONLY — please keep sets disjoint',
    )
  }
  if (result.missingInRegistry.length) {
    logger.warn(
      { tools: result.missingInRegistry },
      'OSM: CORE tools not found in registry — Agent may silently lose these capabilities in OFF mode',
    )
  }
  if (result.unknownTools.length) {
    logger.debug(
      { tools: result.unknownTools, count: result.unknownTools.length },
      'OSM: tools registered but not classified (neither CORE nor ONLY) — consider adding to OSM_ONLY_TOOLS',
    )
  }
}

/** @deprecated Use logOSMSelfCheck */
export const logSuperpowerSelfCheck = logOSMSelfCheck

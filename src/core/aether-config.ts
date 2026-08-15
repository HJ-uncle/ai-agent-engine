/**
 * Aether Engine 统一配置目录（.aether/）加载器
 *
 * 目录约定（对标 Claude Code 的 .claude/、Codex 的 .codex/）：
 *
 *   <project>/.aether/
 *   ├── aether.json   项目级配置基线（可 git 提交，团队共享）
 *   ├── mcp.json      项目级 MCP servers
 *   ├── skills/       项目级技能包
 *   └── AE.md         项目上下文说明（自动注入 system prompt）
 *
 *   ~/.aether/        用户级配置（全局技能/AE.md/aether.json，优先级低于项目级）
 *
 * 优先级（低 → 高）：
 *   内置默认 → .env → ~/.aether/aether.json → <project>/.aether/aether.json
 *   → DB system_config（UI 设置页） → 请求级透传
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { logger } from '../observability/index.js'

// ─── 配置结构 ─────────────────────────────────────────────────────────────────

export interface AetherAgentConfig {
  /** 单次会话最大 ReAct 迭代数（→ MAX_ITERATIONS） */
  maxIterations?: number
  /** 单次请求 Token 预算（→ TOKEN_BUDGET） */
  tokenBudget?: number
  /** 历史消息保留 Token 上限（→ HISTORY_MAX_TOKENS） */
  historyMaxTokens?: number
  /** 工具输出截断长度（→ TOOL_OUTPUT_MAX_CHARS） */
  toolOutputMaxChars?: number
}

export interface AetherConfig {
  /** 默认安全模式：safe | standard | full-access（→ DEFAULT_SECURITY_MODE） */
  defaultSecurityMode?: 'safe' | 'standard' | 'full-access'
  /** OSM 能力档位：off | balanced | methodology | max（→ OSM_MODE） */
  osmMode?: 'off' | 'balanced' | 'methodology' | 'max'
  /** 技能根目录覆盖（→ SKILLS_ROOT），默认自动探测 .aether/skills → SKILLs/ */
  skillsPath?: string
  agent?: AetherAgentConfig
}

// ─── 文件定位 ─────────────────────────────────────────────────────────────────

export function getProjectAetherDir(): string {
  return path.resolve(process.cwd(), '.aether')
}

export function getUserAetherDir(): string {
  return path.join(os.homedir(), '.aether')
}

function readAetherJson(dir: string): Partial<AetherConfig> | null {
  const file = path.join(dir, 'aether.json')
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<AetherConfig>
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, file }, 'aether-config: failed to parse aether.json, ignored')
    return null
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 深合并（仅一层 agent 子对象；undefined 字段不覆盖） */
function mergeConfig(base: Partial<AetherConfig>, override: Partial<AetherConfig>): Partial<AetherConfig> {
  const merged: Partial<AetherConfig> = { ...base }
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue
    if (k === 'agent' && isPlainObject(v) && isPlainObject(merged.agent)) {
      merged.agent = { ...merged.agent, ...v } as AetherAgentConfig
    } else {
      ;(merged as Record<string, unknown>)[k] = v
    }
  }
  return merged
}

// ─── 对外 API ─────────────────────────────────────────────────────────────────

/**
 * 加载并合并用户级 + 项目级 aether.json（项目级优先）。
 * 文件不存在时返回空对象，零配置即可启动。
 */
export function loadAetherConfig(): Partial<AetherConfig> {
  const userCfg = readAetherJson(getUserAetherDir())
  const projectCfg = readAetherJson(getProjectAetherDir())
  if (!userCfg && !projectCfg) return {}
  let cfg: Partial<AetherConfig> = {}
  if (userCfg) cfg = mergeConfig(cfg, userCfg)
  if (projectCfg) cfg = mergeConfig(cfg, projectCfg)
  return cfg
}

/**
 * 将 aether.json 的显式字段写入 process.env（覆盖 .env，被 DB 同步覆盖）。
 * 必须在 skillsRegistry.start() 与 systemConfigStore DB 同步之前调用。
 */
export function applyAetherConfigToEnv(cfg: Partial<AetherConfig>): string[] {
  const applied: string[] = []
  const setEnv = (key: string, value: string | undefined) => {
    if (value === undefined) return
    process.env[key] = value
    applied.push(key)
  }

  setEnv('DEFAULT_SECURITY_MODE', cfg.defaultSecurityMode)
  setEnv('OSM_MODE', cfg.osmMode)
  setEnv('SKILLS_ROOT', cfg.skillsPath)
  setEnv('MAX_ITERATIONS', cfg.agent?.maxIterations?.toString())
  setEnv('TOKEN_BUDGET', cfg.agent?.tokenBudget?.toString())
  setEnv('HISTORY_MAX_TOKENS', cfg.agent?.historyMaxTokens?.toString())
  setEnv('TOOL_OUTPUT_MAX_CHARS', cfg.agent?.toolOutputMaxChars?.toString())

  if (applied.length > 0) {
    logger.info({ keys: applied }, 'aether-config: applied .aether/aether.json overrides to process.env')
  }
  return applied
}

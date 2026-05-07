/**
 * DeepSeek 动态价格模块
 * ============================================================================
 * 支持"折扣期自动切换，截止时间到期后回原价"逻辑。
 * 价格配置可通过 ~/.agent-engine/deepseek-prices.json 持久化，
 * 也可通过 API PUT /api/deepseek/prices 动态更新。
 *
 * 价格单位：元人民币 / 百万 tokens
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ── 类型定义 ─────────────────────────────────────────────────────────────────

export interface ModelPriceTier {
  /** 输入 token 价格（元/百万） */
  input: number
  /** 输出 token 价格（元/百万） */
  output: number
  /** KV Cache 命中 token 价格（元/百万） */
  cacheHit: number
}

export interface ModelPriceConfig {
  /** 模型 ID（与 DeepSeek API model 字段对应） */
  modelId: string
  /** 原价（折扣到期后使用） */
  normalPrice: ModelPriceTier
  /** 折扣价（折扣期内使用） */
  discountPrice?: ModelPriceTier
  /** 折扣截止时间（ISO8601，可为 null 表示无折扣或永久折扣） */
  discountUntil?: string | null
}

export interface DeepSeekPricesConfig {
  /** 各模型的价格配置 */
  models: ModelPriceConfig[]
  /** 低余额警告阈值（元），默认 10 */
  lowBalanceThreshold?: number
  /** 最后更新时间 */
  updatedAt?: string
}

export interface EffectiveModelPrice extends ModelPriceTier {
  /** 是否正在使用折扣价 */
  isDiscounted: boolean
  /** 折扣截止时间（若有） */
  discountUntil?: string | null
}

// ── 默认价格快照（2026-05-07，以官网为准）──────────────────────────────────

export const DEFAULT_PRICES_CONFIG: DeepSeekPricesConfig = {
  lowBalanceThreshold: 10,
  updatedAt: '2026-05-07T00:00:00+08:00',
  models: [
    {
      modelId: 'deepseek-chat',
      normalPrice: {
        input: 2,
        output: 8,
        cacheHit: 0.5,
      },
      discountPrice: {
        input: 1,
        output: 4,
        cacheHit: 0.1,
      },
      // 折扣截止时间：由用户手动配置，默认留空（不确定官方活动时间）
      discountUntil: null,
    },
    {
      modelId: 'deepseek-reasoner',
      normalPrice: {
        input: 4,
        output: 16,
        cacheHit: 1,
      },
      discountPrice: {
        input: 1,
        output: 8,
        cacheHit: 0.1,
      },
      discountUntil: null,
    },
  ],
}

// ── 配置文件路径 ──────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), '.agent-engine')
const PRICES_FILE = path.join(CONFIG_DIR, 'deepseek-prices.json')

// ── 文件读写 ──────────────────────────────────────────────────────────────────

/**
 * 读取价格配置文件，不存在时自动写入默认值
 */
export function loadPricesConfig(): DeepSeekPricesConfig {
  try {
    if (!fs.existsSync(PRICES_FILE)) {
      savePricesConfig(DEFAULT_PRICES_CONFIG)
      return DEFAULT_PRICES_CONFIG
    }
    const raw = fs.readFileSync(PRICES_FILE, 'utf-8')
    return JSON.parse(raw) as DeepSeekPricesConfig
  } catch {
    return DEFAULT_PRICES_CONFIG
  }
}

/**
 * 持久化价格配置到文件
 */
export function savePricesConfig(config: DeepSeekPricesConfig): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true })
    }
    const updated: DeepSeekPricesConfig = {
      ...config,
      updatedAt: new Date().toISOString(),
    }
    fs.writeFileSync(PRICES_FILE, JSON.stringify(updated, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[DeepSeek Pricing] 无法写入价格配置文件:', err)
  }
}

// ── 核心逻辑 ──────────────────────────────────────────────────────────────────

/**
 * 获取指定模型的当前有效价格（自动判断折扣是否有效）
 * @param modelId  DeepSeek 模型 ID（如 'deepseek-chat'）
 * @param config   价格配置（可选，默认从文件读取）
 * @param now      当前时间（可注入，方便单测）
 */
export function getPriceForModel(
  modelId: string,
  config?: DeepSeekPricesConfig,
  now: Date = new Date(),
): EffectiveModelPrice | null {
  const cfg = config ?? loadPricesConfig()

  // 精确匹配或前缀匹配（如 'deepseek-chat-0324' → 'deepseek-chat'）
  const entry =
    cfg.models.find((m) => m.modelId === modelId) ??
    cfg.models.find((m) => modelId.startsWith(m.modelId))

  if (!entry) return null

  const isDiscounted =
    !!entry.discountPrice &&
    !!entry.discountUntil &&
    now < new Date(entry.discountUntil)

  const tier = isDiscounted ? entry.discountPrice! : entry.normalPrice

  return {
    ...tier,
    isDiscounted,
    discountUntil: entry.discountUntil,
  }
}

/**
 * 计算 KV Cache 节省金额（元）
 * = cacheHitTokens × (normalCacheHit - effectiveCacheHit) / 1_000_000
 */
export function calcCacheSavings(
  cacheHitTokens: number,
  modelId: string,
  config?: DeepSeekPricesConfig,
  now?: Date,
): { savedYuan: number; normalCacheHitPrice: number; effectiveCacheHitPrice: number } | null {
  const cfg = config ?? loadPricesConfig()
  const effective = getPriceForModel(modelId, cfg, now)
  if (!effective) return null

  const entry = cfg.models.find((m) => m.modelId === modelId || modelId.startsWith(m.modelId))
  if (!entry) return null

  const normalCacheHitPrice = entry.normalPrice.cacheHit
  const effectiveCacheHitPrice = effective.cacheHit
  const savedYuan = (cacheHitTokens / 1_000_000) * (normalCacheHitPrice - effectiveCacheHitPrice)

  return { savedYuan, normalCacheHitPrice, effectiveCacheHitPrice }
}

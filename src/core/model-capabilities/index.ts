/**
 * 模型能力统一注册表
 * ============================================================================
 * 单一真相源，集中管理所有 LLM 模型的能力开关：vision / thinking / toolCalling
 * / jsonMode / search / caching / video / audio / parallelTools 等。
 *
 * 三级优先级（从高到低）：
 *   1. request 级别：API/SDK 请求体里传入的 capabilities 字段
 *   2. db 级别：system_config 中的 MODEL_CAPABILITIES_<MODEL_ID> JSON
 *   3. builtin 级别：本文件 DEFAULT_RULES 内置的模式匹配规则
 *
 * 使用方式：
 *   import { resolveCapabilities, capabilityRegistry } from '@/core/model-capabilities'
 *   const caps = resolveCapabilities({ model: 'qwen-plus', baseUrl: '...' })
 *   if (caps.vision) { ... }
 *
 * 添加新模型：
 *   capabilityRegistry.register({
 *     match: { model: [/my-new-model/i] },
 *     caps: { vision: true, toolCalling: true },
 *     priority: 10,
 *   })
 */

import { usesNativeOllama } from '../llm-adapter/protocol.js'

/** 模型能力清单（全部为可选 boolean，未声明视为未知/false） */
export interface ModelCapabilities {
  /** 多模态：image_url 输入（图片理解） */
  vision?: boolean
  /** 视频帧序列输入 */
  video?: boolean
  /** 音频输入 */
  audio?: boolean
  /** 推理模式（reasoning_content / thinking_delta） */
  thinking?: boolean
  /** Function Calling / Tool Use */
  toolCalling?: boolean
  /** Structured JSON Output */
  jsonMode?: boolean
  /** 内置网络搜索增强 */
  search?: boolean
  /** Prompt / KV Cache（命中折扣） */
  caching?: boolean
  /** 单次请求并行多 tool call */
  parallelTools?: boolean
  /** 流式 usage（stream_options.include_usage） */
  streamUsage?: boolean
  /** Prefix / Continue 续写 */
  prefix?: boolean
  /**
   * 上下文窗口上限（token 数）。前端用量环以此为分母；未声明时前端回落到估算值。
   * 注意与 maxTokens（输出上限）区分——这里是「模型一次能吃进去多少」。
   */
  contextWindow?: number
}

/** 单条规则匹配条件，任意一组命中即视为匹配（OR 关系） */
export interface CapabilityMatcher {
  model?: RegExp[]
  baseUrl?: RegExp[]
  provider?: string[]
}

export interface CapabilityRule {
  /** 用于调试和去重 */
  id?: string
  /** 命中条件，三个字段之间为 OR */
  match: CapabilityMatcher
  /** 命中时叠加的能力（与已累计的能力做 merge） */
  caps: Partial<ModelCapabilities>
  /** 数字越大越靠后，可覆盖前面规则的同名 cap；默认 0 */
  priority?: number
}

export interface ResolveInput {
  model?: string
  baseUrl?: string
  provider?: string
  /** request 级别 override，最高优先级 */
  overrides?: Partial<ModelCapabilities> | null
  /** db 级别 override（可在 chat.ts 中传入） */
  dbOverrides?: Partial<ModelCapabilities> | null
}

/**
 * 内置规则：按家族组织。命中多个规则时，priority 高 + 后注册者覆盖前者。
 *
 * 默认所有能力为 undefined，资源宽容：
 *   未声明 vision=false 也不阻止；只在 vision=true 才走多模态路径
 */
const DEFAULT_RULES: CapabilityRule[] = [
  // ── OpenAI 系列 ─────────────────────────────────────────────────────────
  {
    id: 'openai:gpt-4o',
    match: { model: [/gpt-4o/i, /gpt-4-turbo/i, /gpt-4v/i, /gpt-4-vision/i, /gpt-5/i, /o1/i, /o3/i, /o4/i] },
    caps: { vision: true, toolCalling: true, jsonMode: true, parallelTools: true, streamUsage: true, caching: true, contextWindow: 128_000 },
  },
  {
    id: 'openai:o-series-thinking',
    match: { model: [/^o1/i, /^o3/i, /^o4/i] },
    caps: { thinking: true, contextWindow: 200_000 },
  },
  {
    id: 'openai:gpt-3.5',
    match: { model: [/gpt-3\.5/i] },
    caps: { vision: false, toolCalling: true, jsonMode: true, streamUsage: true, contextWindow: 16_385 },
  },

  // ── Anthropic Claude 系列 ───────────────────────────────────────────────
  {
    id: 'anthropic:claude-3+',
    match: { model: [/claude-3/i, /claude-4/i, /claude-opus/i, /claude-sonnet/i, /claude-haiku/i] },
    caps: { vision: true, toolCalling: true, caching: true, parallelTools: true, prefix: true, contextWindow: 200_000 },
  },
  {
    id: 'anthropic:claude-thinking',
    match: { model: [/claude-3-7/i, /claude-4/i, /claude-opus-4/i, /claude-sonnet-4/i] },
    caps: { thinking: true },
  },

  // ── Google Gemini 系列 ──────────────────────────────────────────────────
  {
    id: 'gemini:1.5+',
    match: { model: [/gemini-1\.5/i, /gemini-2/i, /gemini-pro-vision/i] },
    caps: { vision: true, video: true, audio: true, toolCalling: true, jsonMode: true, streamUsage: true, contextWindow: 1_000_000 },
  },

  // ── DeepSeek 系列 ───────────────────────────────────────────────────────
  // contextWindow 是**启发式上限**，不是模型真实能力的权威声明：这条规则按 provider
  // 名粗匹配，会套到该 provider 下所有模型（新老代际窗口差异很大）。写死 128_000 会让
  // 引擎比模型更早拒答大窗口型号（报 "Request input (...) plus output reservation (...)
  // exceeds context window (128000)"）。这里取一个足够宽的占位值，让本地预检只拦住
  // 明显异常的请求，真实上限交给服务端判定；需要精确控制时用 DB 的 model
  // capabilityOverrides.contextWindow 覆盖（优先级高于本表）。
  {
    id: 'deepseek:base',
    match: { provider: ['deepseek'], baseUrl: [/deepseek/i], model: [/deepseek/i] },
    caps: { toolCalling: true, jsonMode: true, caching: true, streamUsage: true, prefix: true, vision: false, contextWindow: 1_000_000 },
  },
  {
    id: 'deepseek:reasoner',
    // 注意：网关别名可能不带 v4 前缀（如 "deepseek-flash"），这类模型在网关侧
    // 默认输出 reasoning_content（thinking mode）。若此处漏判，引擎不会在回传
    // 带 tool_calls 的 assistant 消息时补 reasoning_content，网关将报
    // 400 "The reasoning_content in the thinking mode must be passed back to the API."
    match: {
      model: [
        /deepseek.*reasoner/i,
        /deepseek.*r1/i,
        /v3.*think/i,
        /v4(?:\.\d+)?[.-]?(pro|flash)/i,
        /deepseek[.-]?(?:v\d+(?:\.\d+)?[.-]?)?(?:pro|flash)/i, // 网关别名：deepseek-flash / deepseek-pro 等
      ],
    },
    caps: { thinking: true },
  },

  // ── Qwen / 通义千问 / 百炼 ──────────────────────────────────────────────
  // 匹配语义是 provider / model / baseUrl **三者取 OR**（任一命中即整条生效），
  // 所以 baseUrl 正则不能写成 /aliyuncs\.com/i 这类宽泛域名 —— 阿里云 MaaS 上
  // 挂的不止通义（例如 token-plan.cn-beijing.maas.aliyuncs.com 上跑的是 DeepSeek），
  // 一条宽泛正则会把它们全部套上 qwen 能力集，连带把 contextWindow 覆盖成 128k，
  // 让别的 provider 的模型被错误地按 qwen 窗口限制。只认官方 DashScope API 域名，
  // 其余阿里云通路交给 provider / model 名匹配。
  {
    id: 'qwen:base',
    match: {
      provider: ['qwen'],
      baseUrl: [/dashscope/i],
      model: [/^qwen/i, /^qwq/i],
    },
    caps: { vision: true, toolCalling: true, search: true, streamUsage: true, caching: true, contextWindow: 128_000 },
  },
  {
    id: 'qwen:thinking',
    match: { model: [/qwen3/i, /qwq/i] },
    caps: { thinking: true },
  },
  {
    id: 'qwen:text-only',
    match: { model: [/qwen-long/i, /qwen-math/i, /qwen-audio/i, /qwen-code/i] },
    caps: { vision: false },
    priority: 10, // 覆盖 qwen:base 的 vision=true
  },
  {
    id: 'qwen:vl',
    match: { model: [/qwen.*vl/i, /qwen.*vision/i, /qwen-omni/i] },
    caps: { vision: true, video: true },
    priority: 10,
  },
  {
    id: 'qwen:audio',
    match: { model: [/qwen-audio/i, /qwen-omni/i] },
    caps: { audio: true },
    priority: 10,
  },

  // ── Moonshot / Kimi ─────────────────────────────────────────────────────
  {
    id: 'moonshot:base',
    match: { baseUrl: [/moonshot/i], model: [/moonshot/i, /kimi/i] },
    caps: { toolCalling: true, jsonMode: true, streamUsage: false, contextWindow: 256_000 },
  },
  {
    id: 'moonshot:vision',
    match: { model: [/moonshot.*vision/i, /kimi.*vision/i, /kimi-vl/i, /k2\.5/i] },
    caps: { vision: true },
  },

  // ── Zhipu GLM ───────────────────────────────────────────────────────────
  {
    id: 'zhipu:base',
    match: { baseUrl: [/zhipu/i, /bigmodel\.cn/i], model: [/glm-/i, /chatglm/i] },
    caps: { toolCalling: true, jsonMode: true, contextWindow: 128_000 },
  },
  {
    id: 'zhipu:vision',
    match: { model: [/glm-4v/i, /cogvlm/i] },
    caps: { vision: true },
  },

  // ── Ollama / 本地模型 ───────────────────────────────────────────────────
  {
    id: 'ollama:base',
    match: { provider: ['ollama'], baseUrl: [/ollama/i] },
    caps: { toolCalling: true },
  },
  {
    id: 'ollama:vision',
    match: { model: [/llava/i, /bakllava/i, /minicpm-v/i, /llama.*vision/i] },
    caps: { vision: true },
  },
]

/** 单例注册表 */
export class ModelCapabilityRegistry {
  private rules: CapabilityRule[] = []

  constructor(initial: CapabilityRule[] = []) {
    for (const r of initial) this.register(r)
  }

  /** 注册一条规则；同 id 的旧规则会被替换 */
  register(rule: CapabilityRule): void {
    if (rule.id) {
      const idx = this.rules.findIndex((r) => r.id === rule.id)
      if (idx >= 0) {
        this.rules[idx] = rule
        return
      }
    }
    this.rules.push(rule)
  }

  /** 移除一条规则 */
  unregister(id: string): boolean {
    const idx = this.rules.findIndex((r) => r.id === id)
    if (idx < 0) return false
    this.rules.splice(idx, 1)
    return true
  }

  /** 列出所有规则（调试用） */
  list(): readonly CapabilityRule[] {
    return this.rules
  }

  /** 命中检测 */
  private matchRule(rule: CapabilityRule, input: ResolveInput): boolean {
    const m = rule.match
    const model = input.model ?? ''
    const baseUrl = input.baseUrl ?? ''
    const provider = (input.provider ?? '').toLowerCase()

    if (m.provider && m.provider.length > 0 && m.provider.map((p) => p.toLowerCase()).includes(provider)) {
      return true
    }
    if (m.model && m.model.some((re) => re.test(model))) {
      return true
    }
    if (m.baseUrl && m.baseUrl.some((re) => re.test(baseUrl))) {
      return true
    }
    return false
  }

  /** 解析最终能力集 */
  resolve(input: ResolveInput): ModelCapabilities {
    let result: ModelCapabilities = {}

    // 按优先级升序遍历内置规则（同优先级按注册顺序）
    const sorted = [...this.rules].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    for (const rule of sorted) {
      if (this.matchRule(rule, input)) {
        result = { ...result, ...rule.caps }
      }
    }

    // db 级别 override（中优先级）
    if (input.dbOverrides) {
      result = { ...result, ...stripUndef(input.dbOverrides) }
    }

    // request 级别 override（最高优先级）
    if (input.overrides) {
      result = { ...result, ...stripUndef(input.overrides) }
    }

    return result
  }
}

function stripUndef<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {}
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] !== undefined) out[k] = obj[k]
  }
  return out
}

/** 全局单例 */
export const capabilityRegistry = new ModelCapabilityRegistry(DEFAULT_RULES)

/** Effective capabilities cannot exceed what the selected wire adapter implements. */
export function resolveCapabilities(input: ResolveInput): ModelCapabilities {
  const capabilities = capabilityRegistry.resolve(input)
  if (usesNativeOllama(input.provider, input.baseUrl)) {
    // Native Ollama currently serializes text and usage only. Model rules and
    // manual overrides must not advertise tools/images that this adapter drops.
    return {
      ...capabilities,
      toolCalling: false, parallelTools: false, vision: false, video: false, audio: false,
      thinking: false, jsonMode: false, search: false, caching: false, prefix: false,
      streamUsage: true,
    }
  }
  return capabilities
}

/**
 * 从 system_config 数据库读取某个模型的 cap override（异步）
 * key 形如：MODEL_CAPABILITIES_<MODEL_ID>，value 为 JSON 字符串
 */
export async function loadDbCapabilityOverrides(model: string): Promise<Partial<ModelCapabilities> | null> {
  try {
    const { systemConfigStore } = await import('../../storage/sqlite/system-config.js')
    const key = `MODEL_CAPABILITIES_${model.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
    const raw = await systemConfigStore.get(key)
    if (!raw) return null
    return JSON.parse(raw) as Partial<ModelCapabilities>
  } catch {
    return null
  }
}

/**
 * Agent Engine HTTP Client（SDK 版）
 *
 * 使用 Node 18+ 内置 fetch，无需额外依赖。
 */

// ==================== 常量 ====================

const ENGINE_HTTP_API_PREFIX = '/api/v1'

// ==================== 异常类型 ====================

export class EngineHttpError extends Error {
  readonly status: number
  readonly url: string
  readonly responseText?: string

  constructor(message: string, status: number, url: string, responseText?: string) {
    super(message)
    this.name = 'EngineHttpError'
    this.status = status
    this.url = url
    this.responseText = responseText
  }
}

export class EngineHttpTimeoutError extends Error {
  readonly url: string
  readonly timeoutMs: number

  constructor(url: string, timeoutMs: number) {
    super(`HTTP request timed out after ${timeoutMs}ms: ${url}`)
    this.name = 'EngineHttpTimeoutError'
    this.url = url
    this.timeoutMs = timeoutMs
  }
}

export class EngineHttpAbortedError extends Error {
  readonly url: string

  constructor(url: string) {
    super(`HTTP request aborted: ${url}`)
    this.name = 'EngineHttpAbortedError'
    this.url = url
  }
}

// ==================== 客户端配置 ====================

export interface AgentEngineHttpClientConfig {
  baseUrl: string
  apiKey?: string
  /** 请求级默认超时（ms）。SSE streamChat 不使用此值（由调用方控制 abort） */
  timeoutMs?: number
}

// ==================== 工具函数 ====================

/** 拼接 baseUrl + /api/v1 + path，去重斜杠 */
function buildUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '')
  const trimmedPath = path.replace(/^\/+/, '')
  // 自动补 /api/v1，但若 path 已经以 api/v1、health、metrics、models 开头则跳过
  if (
    trimmedPath.startsWith('api/v1') ||
    trimmedPath.startsWith('health') ||
    trimmedPath.startsWith('metrics') ||
    trimmedPath.startsWith('models')
  ) {
    return `${trimmedBase}/${trimmedPath}`
  }
  return `${trimmedBase}${ENGINE_HTTP_API_PREFIX}/${trimmedPath}`
}

function buildHeaders(
  config: AgentEngineHttpClientConfig,
  extra?: Record<string, string>,
  hasBody = false
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json'
  }
  // 只在有请求体时才添加 Content-Type，避免 DELETE/GET 等无 body 请求
  // 被 Fastify 以 "Body cannot be empty when content-type is set to application/json" 拒绝
  if (hasBody) {
    headers['Content-Type'] = 'application/json'
  }
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  }
  if (extra) Object.assign(headers, extra)
  return headers
}

/** 合并外部 signal 与 timeout signal */
function mergeSignals(
  external?: AbortSignal,
  timeoutMs?: number
): { signal: AbortSignal; cleanup: () => void; timer?: NodeJS.Timeout } {
  const ctrl = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const onAbort = (): void => ctrl.abort()
  if (external) {
    if (external.aborted) ctrl.abort()
    else external.addEventListener('abort', onAbort, { once: true })
  }
  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => ctrl.abort(), timeoutMs)
  }
  return {
    signal: ctrl.signal,
    timer,
    cleanup: () => {
      if (timer) clearTimeout(timer)
      if (external) external.removeEventListener('abort', onAbort)
    }
  }
}

async function safeReadText(response: Response): Promise<string | undefined> {
  try {
    return await response.text()
  } catch {
    return undefined
  }
}

// ==================== 客户端类 ====================

export class AgentEngineHttpClient {
  private config: AgentEngineHttpClientConfig

  constructor(config: AgentEngineHttpClientConfig) {
    if (!config.baseUrl) throw new Error('AgentEngineHttpClient: baseUrl is required')
    this.config = { ...config }
  }

  updateConfig(patch: Partial<AgentEngineHttpClientConfig>): void {
    this.config = { ...this.config, ...patch }
  }

  getConfig(): Readonly<AgentEngineHttpClientConfig> {
    return this.config
  }

  // ==================== 普通 JSON 请求 ====================

  async requestJson<TBody = unknown, TResp = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    path: string,
    options?: {
      body?: TBody
      query?: Record<string, string | number | boolean | undefined>
      signal?: AbortSignal
      timeoutMs?: number
      extraHeaders?: Record<string, string>
    }
  ): Promise<TResp> {
    let url = buildUrl(this.config.baseUrl, path)
    if (options?.query) {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(options.query)) {
        if (v === undefined) continue
        params.set(k, String(v))
      }
      const qs = params.toString()
      if (qs) url += (url.includes('?') ? '&' : '?') + qs
    }

    const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs ?? 60000
    const merged = mergeSignals(options?.signal, timeoutMs)

    const hasBody = options?.body !== undefined
    const serializedBody = hasBody ? JSON.stringify(options!.body) : undefined

    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers: buildHeaders(this.config, options?.extraHeaders, hasBody),
        body: serializedBody,
        signal: merged.signal
      })
    } catch (error) {
      merged.cleanup()
      if ((error as { name?: string }).name === 'AbortError') {
        if (options?.signal?.aborted) {
          throw new EngineHttpAbortedError(url)
        }
        throw new EngineHttpTimeoutError(url, timeoutMs)
      }
      throw new EngineHttpError(
        `HTTP request failed: ${(error as Error).message}`,
        0,
        url
      )
    }

    merged.cleanup()

    if (!response.ok) {
      const text = await safeReadText(response)
      throw new EngineHttpError(
        `HTTP ${response.status} ${response.statusText} for ${url}`,
        response.status,
        url,
        text
      )
    }

    const text = await response.text()
    if (!text) return undefined as unknown as TResp
    try {
      return JSON.parse(text) as TResp
    } catch {
      return text as unknown as TResp
    }
  }
}

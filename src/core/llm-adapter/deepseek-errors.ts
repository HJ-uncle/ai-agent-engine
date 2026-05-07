/**
 * DeepSeek 特有错误类型
 * ============================================================================
 * 将 DeepSeek HTTP 错误码映射为语义化 Error 子类，便于前端分级处理。
 */

// ── 错误基类 ──────────────────────────────────────────────────────────────────

export class DeepSeekError extends Error {
  readonly provider = 'deepseek'
  readonly httpStatus: number
  readonly errorCode: string

  constructor(message: string, httpStatus: number, errorCode: string) {
    super(message)
    this.name = this.constructor.name
    this.httpStatus = httpStatus
    this.errorCode = errorCode
  }

  /** 序列化为可通过 HTTP 响应透传的对象 */
  toJSON() {
    return {
      provider: this.provider,
      errorType: this.name,
      errorCode: this.errorCode,
      httpStatus: this.httpStatus,
      message: this.message,
    }
  }
}

// ── 402：余额不足 ─────────────────────────────────────────────────────────────

export class DeepSeekInsufficientBalanceError extends DeepSeekError {
  readonly rechargeUrl = 'https://platform.deepseek.com/top_up'
  readonly retryable = false

  constructor(message = '账户余额不足，请前往 DeepSeek 平台充值') {
    super(message, 402, 'INSUFFICIENT_BALANCE')
  }

  override toJSON() {
    return { ...super.toJSON(), rechargeUrl: this.rechargeUrl, retryable: this.retryable }
  }
}

// ── 429：速率限制 ─────────────────────────────────────────────────────────────

export class DeepSeekRateLimitError extends DeepSeekError {
  readonly retryable = true
  readonly retriesExhausted: boolean

  constructor(message = '请求频率过高，请稍后重试', retriesExhausted = true) {
    super(message, 429, 'RATE_LIMIT_EXCEEDED')
    this.retriesExhausted = retriesExhausted
  }

  override toJSON() {
    return { ...super.toJSON(), retryable: this.retryable, retriesExhausted: this.retriesExhausted }
  }
}

// ── 503：服务不可用 ───────────────────────────────────────────────────────────

export class DeepSeekServiceUnavailableError extends DeepSeekError {
  readonly retryable = true

  constructor(message = 'DeepSeek 服务暂时不可用，请稍后重试') {
    super(message, 503, 'SERVICE_UNAVAILABLE')
  }

  override toJSON() {
    return { ...super.toJSON(), retryable: this.retryable }
  }
}

// ── 422：参数错误 ─────────────────────────────────────────────────────────────

export class DeepSeekInvalidParamError extends DeepSeekError {
  readonly retryable = false
  readonly problematicParam?: string

  constructor(message = '请求参数错误', problematicParam?: string) {
    super(message, 422, 'INVALID_PARAM')
    this.problematicParam = problematicParam
  }

  override toJSON() {
    return { ...super.toJSON(), retryable: this.retryable, problematicParam: this.problematicParam }
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** 从 OpenAI SDK APIError 的 status + body 解析出 DeepSeekError（若可映射） */
export function parseDeepSeekError(status: number, body?: any): DeepSeekError | null {
  switch (status) {
    case 402:
      return new DeepSeekInsufficientBalanceError(
        body?.error?.message ?? body?.message ?? '账户余额不足',
      )
    case 429:
      return new DeepSeekRateLimitError(
        body?.error?.message ?? body?.message ?? '请求频率过高',
        true,
      )
    case 503:
      return new DeepSeekServiceUnavailableError(
        body?.error?.message ?? body?.message ?? 'DeepSeek 服务暂时不可用',
      )
    case 422: {
      // 尝试从错误信息中提取问题参数名
      const msg: string = body?.error?.message ?? body?.message ?? ''
      const paramMatch = msg.match(/['"`](\w+)['"`]/) ?? msg.match(/parameter\s+(\w+)/i)
      return new DeepSeekInvalidParamError(msg || '请求参数错误', paramMatch?.[1])
    }
    default:
      return null
  }
}

/** 检查一个 Error 是否是 DeepSeek 特有错误 */
export function isDeepSeekError(err: unknown): err is DeepSeekError {
  return err instanceof DeepSeekError
}

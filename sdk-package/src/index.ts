/**
 * agent-engine-sdk 主入口
 *
 * AgentEngineSdk 封装双模式（embedded / remote）的 agent-engine 接入：
 *
 * - embedded 模式：在本地以子进程方式启动 bin/main.js，自动探测端口，
 *   等待就绪后暴露 baseUrl，Electron 退出时自动关闭子进程。
 *
 * - remote 模式：直接连接用户部署的 agent-engine 服务，不启动任何子进程。
 *
 * 用法示例：
 * ```ts
 * const sdk = new AgentEngineSdk({ mode: 'embedded' })
 * const { baseUrl } = await sdk.start()
 * // 使用 baseUrl 初始化 AgentEngineProvider...
 * // 退出时：
 * await sdk.stop()
 * ```
 */
import * as path from 'path'
import { AgentEngineSdkConfig, EngineHealthResult, SdkMode, SdkStartResult } from './types'
import { findAvailablePort } from './embedded/portFinder'
import { startProcess, ProcessHandle } from './embedded/processManager'
import { waitUntilReady } from './embedded/readinessProbe'
import { AgentEngineHttpClient } from './client/httpClient'

export { AgentEngineSdkConfig, EngineHealthResult, SdkMode, SdkStartResult } from './types'
export { EngineHttpError, EngineHttpTimeoutError, EngineHttpAbortedError } from './client/httpClient'

// ==================== 默认值 ====================

const DEFAULT_PREFERRED_PORT = 12323
const DEFAULT_STARTUP_TIMEOUT_MS = 15000

// ==================== SDK 主类 ====================

export class AgentEngineSdk {
  private readonly config: AgentEngineSdkConfig
  private _baseUrl: string = ''
  private _started: boolean = false
  private processHandle: ProcessHandle | null = null
  private http: AgentEngineHttpClient | null = null

  constructor(config: AgentEngineSdkConfig) {
    // 校验 remote 模式必须有 baseUrl
    if (config.mode === 'remote') {
      if (!config.remote?.baseUrl) {
        throw new Error(
          '[AgentEngineSdk] remote.baseUrl is required when mode is "remote"'
        )
      }
    }
    this.config = config
  }

  // ==================== 访问器 ====================

  /**
   * 当前连接的 baseUrl。
   * start() 成功后可用；未启动时返回空字符串。
   */
  get baseUrl(): string {
    return this._baseUrl
  }

  /** 当前运行模式 */
  get mode(): SdkMode {
    return this.config.mode
  }

  /** 是否已启动 */
  get started(): boolean {
    return this._started
  }

  // ==================== 生命周期 ====================

  /**
   * 启动 SDK。
   *
   * - embedded 模式：端口探测 → 启动子进程 → 就绪探测，resolve 实际 baseUrl
   * - remote 模式：直接 resolve config.remote.baseUrl
   * - 幂等：已启动时直接返回当前 baseUrl
   *
   * @returns SdkStartResult 含可用 baseUrl
   */
  async start(): Promise<SdkStartResult> {
    // 幂等
    if (this._started) {
      return { baseUrl: this._baseUrl }
    }

    if (this.config.mode === 'embedded') {
      await this._startEmbedded()
    } else {
      this._startRemote()
    }

    // 初始化 HTTP 客户端
    this.http = new AgentEngineHttpClient({
      baseUrl: this._baseUrl,
      apiKey: this.config.apiKey,
      timeoutMs: this.config.timeoutMs ?? 60000
    })

    this._started = true
    return { baseUrl: this._baseUrl }
  }

  /**
   * 停止 SDK。
   *
   * - embedded 模式：终止子进程，清理状态
   * - remote 模式：no-op
   * - 未启动时：no-op
   */
  async stop(): Promise<void> {
    if (!this._started && this.processHandle === null) {
      return
    }

    if (this.config.mode === 'embedded' && this.processHandle !== null) {
      try {
        await this.processHandle.stop()
      } catch (err) {
        console.warn('[AgentEngineSdk] stop: 子进程关闭异常:', err)
      }
      this.processHandle = null
    }

    this._baseUrl = ''
    this._started = false
    this.http = null
  }

  /**
   * 健康检查。
   *
   * 发送 GET /health，返回 EngineHealthResult。
   * 不 reject，失败时 ok=false + error 信息。
   */
  async healthCheck(): Promise<EngineHealthResult> {
    const baseUrl = this._baseUrl || this.config.remote?.baseUrl || ''
    if (!baseUrl) {
      return { ok: false, error: 'SDK not started. Call sdk.start() before healthCheck()' }
    }

    const client = this.http ?? new AgentEngineHttpClient({
      baseUrl,
      apiKey: this.config.apiKey,
      timeoutMs: 5000
    })

    const start = Date.now()
    try {
      const result = await client.requestJson<unknown, { status?: string }>(
        'GET',
        '/health',
        { timeoutMs: 5000 }
      )
      const latencyMs = Date.now() - start
      const ok = (result as { status?: string })?.status === 'ok' || !!result
      return {
        ok,
        latencyMs,
        detail: result ? JSON.stringify(result) : undefined
      }
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : 'health check failed'
      }
    }
  }

  // ==================== 私有方法 ====================

  private async _startEmbedded(): Promise<void> {
    const embeddedOpts = this.config.embedded ?? {}
    const preferredPort = embeddedOpts.preferredPort ?? DEFAULT_PREFERRED_PORT
    const startupTimeoutMs = embeddedOpts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS

    // 1. 端口探测
    const port = await findAvailablePort(preferredPort)

    // 2. 解析 bin/main.js 路径
    const binPath = embeddedOpts.binaryPath ?? path.join(__dirname, '..', 'bin', 'main.js')

    // 3. 解析 dataDir
    // 注意：默认值始终基于 SDK 包内 bin/ 同级的 data/，不跟随自定义 binaryPath 变化，
    // 避免用户传入外部 binPath 时将数据写入意外位置。
    const dataDir = embeddedOpts.dataDir ?? path.join(__dirname, '..', 'data')

    // 4. 启动子进程
    console.log(`[AgentEngineSdk] 启动内嵌 agent-engine，端口: ${port}，bin: ${binPath}`)

    this.processHandle = startProcess({
      binPath,
      port,
      dataDir,
      env: embeddedOpts.env,
      onExit: (code, signal) => {
        console.warn(`[AgentEngineSdk] agent-engine 子进程退出: code=${code}, signal=${signal}`)
        if (this._started) {
          // 意外退出时标记状态
          this._started = false
        }
      }
    })

    // 5. 就绪探测
    const baseUrl = `http://127.0.0.1:${port}`
    try {
      await waitUntilReady({ baseUrl, timeoutMs: startupTimeoutMs })
    } catch (err) {
      // 就绪超时，清理子进程
      await this.processHandle.stop().catch(() => {})
      this.processHandle = null
      throw err
    }

    this._baseUrl = baseUrl
    console.log(`[AgentEngineSdk] agent-engine 已就绪: ${baseUrl}`)
  }

  private _startRemote(): void {
    // remote 模式：直接使用配置的 baseUrl
    this._baseUrl = this.config.remote!.baseUrl
    console.log(`[AgentEngineSdk] 使用远端 agent-engine: ${this._baseUrl}`)
  }
}

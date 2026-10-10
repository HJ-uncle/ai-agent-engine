/**
 * agent-engine-sdk 公开类型定义
 *
 * 包含 SDK 双模式配置、运行时选项、健康检查结果等所有对外暴露的类型。
 */

// ==================== 运行模式 ====================

/** SDK 运行模式：内嵌子进程 或 远端连接 */
export type SdkMode = 'embedded' | 'remote'

// ==================== 内嵌模式选项 ====================

export interface EmbeddedOptions {
  /**
   * agent-engine 入口脚本的绝对路径。
   * 默认使用 SDK 包内的 bin/dist/main.js。
   */
  binaryPath?: string

  /**
   * 首选端口，冲突时自动递增探测。
   * 默认 12323。
   */
  preferredPort?: number

  /**
   * SQLite 数据库文件路径，对应引擎 DATA_DIR；兼容旧的目录路径，自动追加 agent.db。
   * 默认为 bin/ 同级的 data/agent.db。
   * 建议在 Electron 应用中设置为 app.getPath('userData')/agent-engine/agent.db。
   */
  dataDir?: string

  /**
   * 额外注入给子进程的环境变量（会与 process.env 合并，优先级更高）。
   */
  env?: Record<string, string>

  /**
   * 等待 agent-engine 就绪的最大超时时间（ms）。
   * 默认 15000（15 秒）。
   */
  startupTimeoutMs?: number
}

// ==================== 远端模式选项 ====================

export interface RemoteOptions {
  /**
   * 远端 agent-engine 服务的 baseUrl，例如 'http://127.0.0.1:12323'。
   * 必填。
   */
  baseUrl: string
}

// ==================== SDK 总配置 ====================

export interface AgentEngineSdkConfig {
  /** 运行模式 */
  mode: SdkMode

  /** 内嵌模式专用配置（mode === 'embedded' 时生效） */
  embedded?: EmbeddedOptions

  /** 远端模式专用配置（mode === 'remote' 时生效，baseUrl 必填） */
  remote?: RemoteOptions

  /** API 鉴权密钥（可选，对应 agent-engine Authorization: Bearer <apiKey>） */
  apiKey?: string

  /** HTTP 请求超时（ms），默认 60000 */
  timeoutMs?: number
}

// ==================== 健康检查结果 ====================

export interface EngineHealthResult {
  /** 服务是否健康 */
  ok: boolean
  /** 请求延迟（ms） */
  latencyMs?: number
  /** 版本信息（若服务返回） */
  version?: string
  /** 详细信息 */
  detail?: string
  /** 错误描述（ok=false 时存在） */
  error?: string
}

// ==================== SDK 启动结果 ====================

export interface SdkStartResult {
  /** 可用于 HTTP 调用的 baseUrl，如 'http://127.0.0.1:12324' */
  baseUrl: string
}

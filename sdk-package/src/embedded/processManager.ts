/**
 * 子进程生命周期管理模块
 *
 * 使用 child_process.spawn 启动 agent-engine（node bin/main.js），
 * 注入 PORT、DATA_DIR 等环境变量，并提供优雅关闭（SIGTERM → SIGKILL）能力。
 *
 * 关键约束：
 * - detached: false — 确保父进程退出时子进程自动终止
 * - 子进程监听 stdin close 事件，父进程异常退出时自行退出（需 agent-engine 侧配合）
 */
import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'

// ==================== 类型 ====================

export interface StartProcessOptions {
  /** node 可执行文件路径（默认使用 process.execPath） */
  nodePath?: string
  /** agent-engine bin/main.js 的绝对路径 */
  binPath: string
  /** 监听端口，注入为 PORT 环境变量 */
  port: number
  /** 数据目录，注入为 AGENT_ENGINE_DATA_DIR 环境变量 */
  dataDir?: string
  /** 额外环境变量（优先级高于 process.env） */
  env?: Record<string, string>
  /** 子进程意外退出时的回调 */
  onExit?: (code: number | null, signal: string | null) => void
}

export interface ProcessHandle {
  /** 底层 ChildProcess 实例 */
  process: ChildProcess
  /** 子进程监听的端口 */
  port: number
  /** 发起优雅关闭 */
  stop: (timeoutMs?: number) => Promise<void>
}

// ==================== 启动子进程 ====================

/**
 * 启动 agent-engine 子进程。
 *
 * @param opts 启动选项
 * @returns ProcessHandle 控制句柄
 */
export function startProcess(opts: StartProcessOptions): ProcessHandle {
  const nodePath = opts.nodePath ?? process.execPath
  const binDir = path.dirname(opts.binPath)

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PORT: String(opts.port),
    HOST: '127.0.0.1',
    // 禁用 pino-pretty 颜色（避免 Electron 控制台乱码）
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    // 使用主包识别的 AGENT_ENGINE_DATA_DIR，而非旧的 DATA_DIR
    ...(opts.dataDir ? { AGENT_ENGINE_DATA_DIR: opts.dataDir } : {}),
    ...(opts.env ?? {})
  }

  const child = spawn(nodePath, ['main.js'], {
    cwd: binDir,
    env,
    detached: false,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  // 转发子进程日志（便于调试）
  child.stdout?.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split('\n').filter(Boolean)
    for (const line of lines) {
      console.log(`[agent-engine] ${line}`)
    }
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split('\n').filter(Boolean)
    for (const line of lines) {
      console.warn(`[agent-engine:err] ${line}`)
    }
  })

  child.on('exit', (code, signal) => {
    opts.onExit?.(code, signal)
  })

  const handle: ProcessHandle = {
    process: child,
    port: opts.port,
    stop: (timeoutMs = 5000) => stopProcess(child, timeoutMs)
  }

  return handle
}

// ==================== 停止子进程 ====================

/**
 * 优雅关闭子进程：先 SIGTERM，超时后发 SIGKILL。
 *
 * @param child 子进程实例
 * @param timeoutMs SIGTERM 等待超时（默认 5000ms）
 */
export function stopProcess(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) {
      // 已经退出
      resolve()
      return
    }

    let timer: NodeJS.Timeout | null = null

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      resolve()
    }

    child.once('exit', cleanup)

    // 先发 SIGTERM
    try {
      child.kill('SIGTERM')
    } catch {
      // 进程可能已退出，忽略
      cleanup()
      return
    }

    // 超时后强制 SIGKILL
    timer = setTimeout(() => {
      child.removeListener('exit', cleanup)
      try {
        child.kill('SIGKILL')
      } catch {
        /* 忽略 */
      }
      // 再等一次 exit 事件，或直接 resolve
      child.once('exit', resolve)
      // 兜底：200ms 后无论如何 resolve
      setTimeout(resolve, 200)
    }, timeoutMs)
  })
}

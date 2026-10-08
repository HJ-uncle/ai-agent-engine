/**
 * TerminalManager — 管理服务器端 node-pty 伪终端实例
 * 每个终端由 UUID 标识，支持 create / write / resize / kill
 */
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import * as pty from 'node-pty'

export interface TerminalSession {
  id: string
  pty: pty.IPty
  cwd: string
  /** 当前运行中的命令（title 显示用） */
  title: string
  events: EventEmitter
  tenantId: string
  userId?: string
}

export interface TerminalOwner {
  tenantId: string
  userId?: string
}

class TerminalManager {
  private sessions = new Map<string, TerminalSession>()
  private ownerCounts = new Map<string, number>()

  /**
   * 创建新的 PTY 会话
   * @param id       唯一标识（由调用方传入，通常是 uuid）
   * @param cwd      工作目录
   * @param cols     初始列数
   * @param rows     初始行数
   */
  create(id: string, cwd: string, cols = 120, rows = 30, workspaceRoots?: string[], owner?: TerminalOwner): TerminalSession {
    const tenantId = owner?.tenantId ?? 'default'
    const ownerKey = `${tenantId}\u0000${owner?.userId ?? ''}`
    if ((this.ownerCounts.get(ownerKey) ?? 0) >= 32) throw new Error('Terminal limit reached for this owner')
    // 正确获取 workspace-shell.mjs 的路径（跨平台兼容）
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = dirname(__filename)
    const shellScript = resolve(__dirname, './workspace-shell.mjs')

    // 确保 cwd 必须存在且可访问
    const safeCwd = cwd
    if (!existsSync(safeCwd)) throw new Error('Terminal working directory does not exist')

    // 所有绑定的工作空间（含自定义路径）传给 shell
    const roots = workspaceRoots && workspaceRoots.length > 0 ? workspaceRoots : [safeCwd]

    // 准备 spawn 选项
    const spawnOptions: any = {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: safeCwd,
      env: {
        ...executionEnvironment(),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        WORKSPACE_ROOT: roots[0],
        WORKSPACE_ROOTS: JSON.stringify(roots),  // shell 读取所有工作空间
      },
    }

    // workspace-shell.mjs 是纯 ESM 标准库脚本，必须跑在真实 node 上。
    // 不能用 process.execPath：IDE 内嵌模式下引擎进程是 electron.exe
    // （ELECTRON_RUN_AS_NODE=1），而 Windows ConPTY 拉起的 electron.exe
    // 会忽略该变量 —— 实测 0 字节输出立即退出（code=0），终端表现为
    // 「已退出」。改用 PATH 里的 node.exe（或 AETHER_ENGINE_NODE 显式指定），
    // 都不可用时降级系统 shell。
    const nodeCandidates = [
      process.env.AETHER_ENGINE_NODE,
      process.platform === 'win32' ? 'node.exe' : 'node'
    ].filter(Boolean) as string[]

    let p: pty.IPty | null = null
    for (const nodeBin of nodeCandidates) {
      try {
        p = pty.spawn(nodeBin, [shellScript], spawnOptions)
        break
      } catch {
        // 该候选不可用（PATH 无 node 等），尝试下一个
      }
    }
    if (!p) throw new Error('Failed to start restricted workspace shell')

    const events = new EventEmitter()

    // PTY 输出 → EventEmitter，由 WebSocket 路由订阅
    p.onData(data => events.emit('data', data))
    p.onExit(({ exitCode }) => {
      events.emit('exit', exitCode)
      if (this.sessions.delete(id)) this.decrementOwner(ownerKey)
    })

    const session: TerminalSession = {
      id, pty: p, cwd: safeCwd, title: 'workspace-shell', events,
      tenantId, userId: owner?.userId,
    }
    this.sessions.set(id, session)
    this.ownerCounts.set(ownerKey, (this.ownerCounts.get(ownerKey) ?? 0) + 1)
    return session
  }

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id)
  }

  write(id: string, data: string): boolean {
    if (typeof data !== 'string' || data.length > 64 * 1024) return false
    const session = this.sessions.get(id)
    if (!session) return false
    session.pty.write(data)
    return true
  }

  resize(id: string, cols: number, rows: number): boolean {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || cols > 500 || rows < 1 || rows > 500) return false
    const session = this.sessions.get(id)
    if (!session) return false
    session.pty.resize(cols, rows)
    return true
  }

  kill(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    try { session.pty.kill() } catch { /* ignore */ }
    if (this.sessions.delete(id)) this.decrementOwner(`${session.tenantId}\u0000${session.userId ?? ''}`)
  }

  killAll(): void {
    for (const id of this.sessions.keys()) this.kill(id)
  }

  list(): Array<{ id: string; cwd: string; title: string }> {
    return [...this.sessions.values()].map(s => ({ id: s.id, cwd: s.cwd, title: s.title }))
  }

  private decrementOwner(ownerKey: string): void {
    const remaining = (this.ownerCounts.get(ownerKey) ?? 1) - 1
    if (remaining > 0) this.ownerCounts.set(ownerKey, remaining); else this.ownerCounts.delete(ownerKey)
  }
}

// 单例
export const terminalManager = new TerminalManager()

/** Keep engine credentials and signing material out of arbitrary build commands. */
function executionEnvironment(): NodeJS.ProcessEnv {
  const blocked = /(TOKEN|SECRET|PASSWORD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|JWT|ENCRYPTION|DATABASE_URL)/i
  const allowed = new Set(['PATH', 'Path', 'PATHEXT', 'ComSpec', 'COMSPEC', 'SystemRoot', 'SYSTEMROOT',
    'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'LANG', 'TERM', 'COLORTERM',
    'AETHER_ENGINE_NODE'])
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (blocked.test(key) || (!allowed.has(key) && !key.startsWith('LC_'))) continue
    result[key] = value
  }
  return result
}

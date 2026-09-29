import { throwIfAborted } from '../../core/utils/abort.js'
import { spawn } from 'node:child_process'
import os from 'node:os'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { isCommandAllowed, getCmdWhitelist } from '../../security/cmd-whitelist.js'
import { policyEngine, getSecurityMode } from '../../security/policy-engine.js'
import { workspaceManager } from '../../workspace/index.js'

// Windows cmd.exe 内建命令（不存在独立 .exe，必须通过 cmd /c 调用）
const WIN_BUILTINS = new Set([
  'dir', 'type', 'copy', 'move', 'del', 'rd', 'md', 'mkdir', 'rmdir',
  'ren', 'rename', 'cls', 'echo', 'set', 'cd', 'pushd', 'popd',
  'title', 'ver', 'vol', 'path', 'assoc', 'ftype', 'mklink',
])

export interface CMDToolOptions {
  timeoutMs?: number
  allowedCommands?: string[]
}

export const cmdTool: Tool = {
  name: 'execute_cmd',
  displayName: '执行命令',
  description: '执行白名单内的 Shell 命令',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
      cwd: { type: 'string', description: '工作目录（full-access 模式下可为任意绝对路径）' },
      timeoutMs: { type: 'number', description: '超时毫秒数（上限 600000；默认 standard 30s / full-access 120s）' },
    },
    required: ['command'],
  },

  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const args = rawArgs as { command: string; args?: string[]; cwd?: string; timeoutMs?: number }
    const { command, args: cmdArgs = [], cwd: cwdArg, timeoutMs } = args
    const startTime = Date.now()
    throwIfAborted(ctx.signal)

    // 1) 策略引擎裁决（含注入检测 + 审计日志）
    const decision = await policyEngine.evaluate({
      command,
      args: cmdArgs,
      tenantId: ctx.tenantId,
      sessionId: ctx.sessionId,
    })
    if (decision.action === 'deny') {
      return {
        success: false,
        output: `❌ 命令被策略拒绝: ${decision.reason}`,
      }
    }
    if (decision.action === 'ask') {
      // 交给 agent-loop / 前端做二次确认。此处返回 needsConfirmation。
      return {
        success: false,
        needsConfirmation: true,
        pendingAction: {
          type: 'confirm_command',
          command,
          args: cmdArgs,
          reason: decision.reason,
          ruleId: decision.ruleId,
          ruleName: decision.ruleName,
        },
        output: `⚠️ 该命令需要用户确认: ${decision.reason}`,
      }
    }

    // 2) 兼容旧白名单（safe 模式下双保险；standard / full-access 跳过白名单）
    const mode = getSecurityMode(ctx.tenantId, ctx.sessionId)
    if (mode === 'safe' && !isCommandAllowed(command)) {
      return {
        success: false,
        output: `Command "${command}" is not allowed. Permitted commands: ${Array.from(getCmdWhitelist()).join(', ')}`,
      }
    }

    // Ensure workspace exists
    workspaceManager.init(ctx)
    const cwd = cwdArg ? workspaceManager.resolveSafePath(ctx, cwdArg) : workspaceManager.getWorkingDirectory(ctx)
    throwIfAborted(ctx.signal)
    // full-access 模式下默认超时 120s，避免长命令被 5s 硬截断
    const defaultTimeout = mode === 'full-access' ? 120000 : 30000
    // 显式 timeoutMs 优先（上限 10 分钟），其次环境变量，最后按模式默认
    const timeout = typeof timeoutMs === 'number' && timeoutMs > 0
      ? Math.min(Math.floor(timeoutMs), 600000)
      : parseInt(process.env.CMD_TIMEOUT_MS ?? String(defaultTimeout), 10)

    return new Promise<ToolResult>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let cancelled = false
      let settled = false
      let termination: Promise<void> | undefined
      let forceTimer: ReturnType<typeof setTimeout> | undefined
      let spawnCmd = command
      let spawnArgs = cmdArgs
      const windows = os.platform() === 'win32'
      if (windows && (WIN_BUILTINS.has(command.toLowerCase()) || /\.(cmd|bat)$/i.test(command))) {
        spawnCmd = 'cmd.exe'
        spawnArgs = ['/c', command, ...cmdArgs]
      }
      const spawnEnv = mode === 'full-access' ? { ...process.env } : {
        PATH: process.env.PATH, HOME: cwd, SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC,
      }
      const child = spawn(spawnCmd, spawnArgs, {
        cwd, shell: false, windowsHide: true, detached: !windows, env: spawnEnv,
      })
      const stopTree = () => {
        if (termination || !child.pid || child.exitCode !== null || child.signalCode !== null) return
        const pid = child.pid
        if (windows) {
          termination = new Promise<void>(done => {
            const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
            killer.once('error', () => { child.kill(); done() })
            killer.once('close', () => { child.kill(); done() })
          })
        } else {
          try { process.kill(-pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
          termination = new Promise<void>(done => {
            forceTimer = setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch { /* already exited */ } done() }, 1000)
          })
        }
      }
      const abort = () => { cancelled = true; stopTree() }
      const timer = setTimeout(() => { timedOut = true; stopTree() }, timeout)
      const cleanup = () => {
        clearTimeout(timer)
        if (forceTimer) clearTimeout(forceTimer)
        ctx.signal?.removeEventListener('abort', abort)
      }
      ctx.signal?.addEventListener('abort', abort, { once: true })
      if (ctx.signal?.aborted) abort()
      child.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
      child.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })
      child.once('error', (error) => {
        if (settled) return
        settled = true
        cleanup()
        if (cancelled) { reject(ctx.signal?.reason ?? new DOMException('Command cancelled', 'AbortError')); return }
        resolve({ success: false, output: 'Failed to execute command: ' + error.message, error: error.message, durationMs: Date.now() - startTime })
      })
      child.once('close', async code => {
        await termination
        if (settled) return
        settled = true
        cleanup()
        if (cancelled) { reject(ctx.signal?.reason ?? new DOMException('Command cancelled', 'AbortError')); return }
        if (timedOut) {
          resolve({ success: false, output: 'Command timed out after ' + timeout + 'ms', error: 'Command timeout', durationMs: Date.now() - startTime })
          return
        }
        const output = [stdout, stderr].filter(Boolean).join('\n').trim()
        resolve({ success: code === 0, output: output || 'Command exited with code ' + code, durationMs: Date.now() - startTime })
      })
    })
  },
}

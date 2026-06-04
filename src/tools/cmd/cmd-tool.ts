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
    },
    required: ['command'],
  },

  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const args = rawArgs as { command: string; args?: string[]; cwd?: string }
    const { command, args: cmdArgs = [], cwd: cwdArg } = args
    const startTime = Date.now()

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
    const workspaceCwd = workspaceManager.init(ctx)
    // full-access 模式下允许调用方指定任意 cwd，否则锁定到 workspace 沙箱
    const cwd = (mode === 'full-access' && cwdArg) ? cwdArg : workspaceCwd
    // full-access 模式下默认超时 120s，避免长命令被 5s 硬截断
    const defaultTimeout = mode === 'full-access' ? 120000 : 30000
    const timeout = parseInt(process.env.CMD_TIMEOUT_MS ?? String(defaultTimeout), 10)

    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false

      // Windows：内建命令 或 .cmd/.bat 文件 需通过 cmd.exe /c 调用
      let spawnCmd = command
      let spawnArgs = cmdArgs
      if (os.platform() === 'win32') {
        const cmdLower = command.toLowerCase()
        const isBuiltin = WIN_BUILTINS.has(cmdLower)
        const isScriptFile = cmdLower.endsWith('.cmd') || cmdLower.endsWith('.bat')
        if (isBuiltin || isScriptFile) {
          spawnCmd = 'cmd.exe'
          spawnArgs = ['/c', command, ...cmdArgs]
        }
      }

      // full-access 模式下透传完整环境变量，保证 node/npm 等工具正常工作
      const spawnEnv = mode === 'full-access'
        ? { ...process.env }
        : {
            PATH: process.env.PATH,
            HOME: cwd, // Restrict HOME to workspace
            SystemRoot: process.env.SystemRoot, // Windows 需要此变量让 cmd.exe 正常工作
            COMSPEC: process.env.COMSPEC,
          }

      const child = spawn(spawnCmd, spawnArgs, {
        cwd,
        shell: false, // NEVER use shell:true — prevents injection
        timeout,
        env: spawnEnv,
      })

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, timeout)

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        const durationMs = Date.now() - startTime

        if (timedOut) {
          resolve({
            success: false,
            output: `Command timed out after ${timeout}ms`,
            durationMs,
          })
          return
        }

        const output = [stdout, stderr].filter(Boolean).join('\n').trim()
        resolve({
          success: code === 0,
          output: output || `Command exited with code ${code}`,
          durationMs,
        })
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({
          success: false,
          output: `Failed to execute command: ${err.message}`,
          durationMs: Date.now() - startTime,
        })
      })
    })
  },
}

import { spawn } from 'node:child_process'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { isCommandAllowed, getCmdWhitelist } from '../../security/cmd-whitelist.js'
import { workspaceManager } from '../../workspace/index.js'

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
    },
    required: ['command'],
  },

  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const args = rawArgs as { command: string; args?: string[] }
    const { command, args: cmdArgs = [] } = args
    const startTime = Date.now()

    // Security: check whitelist
    if (!isCommandAllowed(command)) {
      return {
        success: false,
        output: `Command "${command}" is not allowed. Permitted commands: ${Array.from(getCmdWhitelist()).join(', ')}`,
      }
    }

    // Ensure workspace exists
    const cwd = workspaceManager.init(ctx)
    const timeout = parseInt(process.env.CMD_TIMEOUT_MS ?? '5000', 10)

    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false

      const child = spawn(command, cmdArgs, {
        cwd,
        shell: false, // NEVER use shell:true — prevents injection
        timeout,
        env: {
          PATH: process.env.PATH,
          HOME: cwd, // Restrict HOME to workspace
        },
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

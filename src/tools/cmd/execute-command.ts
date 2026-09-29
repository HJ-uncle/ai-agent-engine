import fs from 'node:fs'
import { throwIfAborted } from '../../core/utils/abort.js'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { commandJobs, type CommandJobScope } from '../../core/command-jobs/index.js'
import { policyEngine, getSecurityMode } from '../../security/policy-engine.js'
import { workspaceManager } from '../../workspace/index.js'

export interface CMDToolOptions { timeoutMs?: number; allowedCommands?: string[] }
interface CommandArgs { command: string; args?: string[]; cwd?: string; timeoutMs?: number; background?: boolean }

export function commandJobScope(ctx: AgentContext): CommandJobScope {
  return { tenantId: ctx.tenantId, sessionId: ctx.rootSessionId ?? ctx.sessionId,
    ...(ctx.rootSessionId && ctx.rootSessionId !== ctx.sessionId ? { ownerSessionId: ctx.sessionId, ownerRunId: ctx.runId } : {}) }
}

export async function preflightCommand(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult | undefined> {
  const args = rawArgs as CommandArgs
  if (!args || typeof args.command !== 'string' || !args.command.trim() || args.command.includes('\0') ||
    (args.args !== undefined && (!Array.isArray(args.args) || args.args.some(value => typeof value !== 'string' || value.includes('\0')))) ||
    (args.cwd !== undefined && (typeof args.cwd !== 'string' || !args.cwd || args.cwd.includes('\0'))) ||
    (args.background !== undefined && typeof args.background !== 'boolean') ||
    (args.timeoutMs !== undefined && (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0))) {
    return { success: false, output: '命令参数无效：command/cwd 必须为字符串，args 为字符串数组，background 为布尔值，timeoutMs 为正数', error: 'COMMAND_INVALID_ARGUMENTS' }
  }
  const decision = await policyEngine.evaluate({ command: args.command, args: args.args ?? [], tenantId: ctx.tenantId,
    sessionId: ctx.sessionId, ignoreSessionApproval: ctx.toolProfile === 'code',
    approved: Boolean(ctx.currentToolCallId && ctx.currentToolCallId === ctx.approvedToolCallId) })
  if (decision.action === 'allow') return undefined
  if (decision.action === 'deny') return { success: false, output: `命令被策略拒绝: ${decision.reason}`, metadata: { blocked: true } }
  return { success: false, needsConfirmation: true,
    pendingAction: { type: 'confirm_command', command: args.command, args: args.args ?? [], cwd: args.cwd,
      background: args.background ?? false, timeoutMs: args.timeoutMs, reason: decision.reason, ruleId: decision.ruleId, ruleName: decision.ruleName },
    output: `该命令需要用户确认: ${decision.reason}` }
}

export const cmdTool: Tool = {
  name: 'execute_cmd', displayName: '执行命令',
  description: '按当前安全策略执行命令。默认前台等待退出；background=true 启动后台命令并返回 jobId，成功启动不等于命令成功。使用 command_output 查看输出/真实退出状态，cancel_command 停止。后台默认超时10分钟；只保留最后256KiB输出，重启后不重跑或接管原进程。',
  preflight: preflightCommand,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } },
      cwd: { type: 'string', description: '工作目录，仍受当前工作区安全策略限制' },
      timeoutMs: { type: 'number', description: '超时毫秒数，上限600000；默认后台600s，前台safe/standard 30s、full-access 120s' },
      background: { type: 'boolean', description: '默认false；true在成功启动后立即返回jobId，后续读取输出或取消' },
    }, required: ['command'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const startedAt = Date.now()
    throwIfAborted(ctx.signal)
    const blocked = await preflightCommand(rawArgs, ctx)
    if (blocked) return blocked
    const { command, args = [], cwd: cwdArg, timeoutMs, background = false } = rawArgs as CommandArgs
    const mode = getSecurityMode(ctx.tenantId, ctx.sessionId)
    workspaceManager.init(ctx)
    const cwd = fs.realpathSync(workspaceManager.resolveSafePath(ctx, cwdArg ?? workspaceManager.getWorkingDirectory(ctx)))
    workspaceManager.resolveSafePath(ctx, cwd)
    throwIfAborted(ctx.signal)
    const defaultTimeout = background ? 600_000 : mode === 'full-access' ? 120_000 : 30_000
    const configuredTimeout = timeoutMs ?? Number(process.env.CMD_TIMEOUT_MS ?? defaultTimeout)
    const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? Math.min(Math.max(1, Math.floor(configuredTimeout)), 600_000) : defaultTimeout
    const scope = commandJobScope(ctx)
    const launched = await commandJobs.start({ ...scope, ownerSessionId: ctx.sessionId,
      runId: ctx.rootRunId, ownerRunId: ctx.runId, turnId: ctx.turnId ?? ctx.conversationId, toolCallId: ctx.currentToolCallId,
      command, args, cwd, background, timeoutMs: timeout, signal: ctx.signal,
      env: mode === 'full-access' ? { ...process.env } : {
        PATH: process.env.PATH, HOME: cwd, SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC,
      },
    })
    if (background) return { success: launched.status === 'running' || launched.status === 'succeeded',
      output: JSON.stringify({ jobId: launched.jobId, status: launched.status, message: launched.status === 'running' ? 'Command started; read command_output for progress and exit status.' : launched.error?.message }),
      error: launched.status === 'failed' ? launched.error?.code : undefined,
      metadata: { commandJob: launched }, durationMs: Date.now() - startedAt }
    const finished = (await commandJobs.wait(scope, launched.jobId))!
    // Preserve the foreground abort contract; the durable job retains all available output.
    throwIfAborted(ctx.signal)
    let cursor = 0
    let truncated = false
    let expired = false
    const stdout: string[] = []
    const stderr: string[] = []
    for (;;) {
      const page = await commandJobs.output(scope, launched.jobId, { cursor })
      if (!page) { expired = true; truncated = true; break }
      for (const entry of page.entries) (entry.stream === 'stdout' ? stdout : stderr).push(entry.text)
      truncated ||= page.truncated
      cursor = page.nextCursor
      if (!page.hasMore) break
    }
    const text = [stdout.join(''), stderr.join('')].filter(Boolean).join('\n').trim()
    const detail = finished.error?.message ?? `Command exited with code ${finished.exitCode}`
    return { success: finished.status === 'succeeded', output: [expired ? '[Command output expired from retained history]' : truncated ? '[Output truncated; retained tail follows]' : '', text || detail,
      finished.status === 'timed_out' && text ? detail : ''].filter(Boolean).join('\n'),
      error: finished.status === 'succeeded' ? undefined : finished.error?.code,
      metadata: { commandJob: finished, exitCode: finished.exitCode, signal: finished.signal, outputTruncated: truncated },
      durationMs: Date.now() - startedAt }
  },
}

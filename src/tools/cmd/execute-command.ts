import fs from 'node:fs'
import path from 'node:path'
import { throwIfAborted } from '../../core/utils/abort.js'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { commandJobs, type CommandJobScope } from '../../core/command-jobs/index.js'
import { policyEngine, getSecurityMode } from '../../security/policy-engine.js'
import { workspaceManager } from '../../workspace/index.js'
import { commandLooksLikeShellLine, createCommandLaunchPlan } from '../../core/command-jobs/launch-plan.js'
import { createCommandChangeObserver } from './command-change-observer.js'
import { commandChangeSummary } from './command-change-summary.js'
import { createCommandEnvironment } from './command-environment.js'

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
  const cwd = path.resolve(workspaceManager.getWorkingDirectory(ctx), args.cwd ?? '.')
  if (commandLooksLikeShellLine(args.command, cwd)) {
    return { success: false, error: 'COMMAND_INVALID_ARGUMENTS',
      output: 'command 必须是可执行文件名或路径，不能填写整行 shell 命令；参数逐项放入 args，文件路径本身不要加引号。' +
        '\n示例：{"command":"node","args":["-v"]}；{"command":"where","args":["python"]}。' +
        '\n运行脚本直接使用 {"command":"node","args":["-e","你的 JavaScript 源码"]}，无需嵌套 cmd 或手工转义源码。' +
        '\n确需 Windows 管道/重定向时使用 {"command":"cmd.exe","args":["/d","/s","/c","完整 shell 脚本"]}。' }
  }
  try { createCommandLaunchPlan(args.command, args.args ?? [], cwd, process.env) }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'COMMAND_INVALID_ARGUMENTS') {
      return { success: false, error: 'COMMAND_INVALID_ARGUMENTS', output: error.message }
    }
    throw error
  }
  const decision = await policyEngine.evaluate({ command: args.command, args: args.args ?? [], tenantId: ctx.tenantId,
    // Security mode belongs to the visible root conversation; child agents keep
    // separate sessions for history and job ownership.
    sessionId: ctx.rootSessionId ?? ctx.sessionId, ignoreSessionApproval: ctx.toolProfile === 'code',
    approved: Boolean(ctx.currentToolCallId && ctx.currentToolCallId === ctx.approvedToolCallId),
    background: args.background === true })
  if (decision.action === 'allow') return undefined
  if (decision.action === 'deny') return { success: false, output: `命令被策略拒绝: ${decision.reason}`, metadata: { blocked: true } }
  return { success: false, needsConfirmation: true,
    pendingAction: { type: 'confirm_command', command: args.command, args: args.args ?? [], cwd: args.cwd,
      background: args.background ?? false, timeoutMs: args.timeoutMs, reason: decision.reason, ruleId: decision.ruleId, ruleName: decision.ruleName },
    output: `该命令需要用户确认: ${decision.reason}` }
}

export const cmdTool: Tool = {
  name: 'execute_cmd', displayName: '执行命令',
  description: '按当前策略执行程序及参数，默认不经shell、前台等退出。后台返回jobId，启动不等于成功；command_output分页读取完整输出/退出状态，cancel_command停止。结束（含失败/取消）返回cwd内有界changes/changeTracking；排除依赖/内部目录、链接、超限文件和目录外副作用，可能含并发编辑，须审阅并明确选择回退，非全部副作用可撤回。重启不重跑或接管原进程。',
  preflight: preflightCommand,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '仅程序名/路径，如node或npm；不加引号或参数。Windows支持PATH/PATHEXT的.cmd/.bat。' },
      args: { type: 'array', items: { type: 'string' }, description: '逐项原文，不加shell引号；例["-v"]。Node/Python源码直接跟在-e/-c后。管道/重定向显式用shell解析：Windows command="cmd.exe", args=["/d","/s","/c","脚本"]。' },
      cwd: { type: 'string', description: '工作目录，受工作区策略限制' },
      timeoutMs: { type: 'number', description: '可选正数毫秒；省略则直到退出或取消' },
      background: { type: 'boolean', description: '默认false；true启动后立即返回jobId' },
    }, required: ['command'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const startedAt = Date.now()
    throwIfAborted(ctx.signal)
    const blocked = await preflightCommand(rawArgs, ctx)
    if (blocked) return blocked
    const { command, args = [], cwd: cwdArg, timeoutMs, background = false } = rawArgs as CommandArgs
    const mode = getSecurityMode(ctx.tenantId, ctx.rootSessionId ?? ctx.sessionId)
    workspaceManager.init(ctx)
    const cwd = fs.realpathSync(workspaceManager.resolveSafePath(ctx, cwdArg ?? workspaceManager.getWorkingDirectory(ctx)))
    workspaceManager.resolveSafePath(ctx, cwd)
    throwIfAborted(ctx.signal)
    // An omitted deadline is unlimited in every profile. A caller can still
    // opt into an explicit positive timeout for a bounded probe.
    const timeout = timeoutMs === undefined ? undefined
      : (Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.max(1, Math.floor(timeoutMs)) : undefined)
    const scope = commandJobScope(ctx)
    const launched = await commandJobs.start({ ...scope, ownerSessionId: ctx.sessionId,
      runId: ctx.rootRunId, ownerRunId: ctx.runId, turnId: ctx.turnId ?? ctx.parentConversationId ?? ctx.conversationId, toolCallId: ctx.currentToolCallId,
      command, args, cwd, background, timeoutMs: timeout, signal: ctx.signal,
      observeChanges: job => createCommandChangeObserver(ctx, cwd, job),
      env: createCommandEnvironment(mode, cwd),
    })
    if (background) return { success: launched.status === 'running' || launched.status === 'succeeded',
      output: JSON.stringify({ jobId: launched.jobId, status: launched.status, message: launched.status === 'running' ? 'Command started; read command_output for progress and exit status.' : launched.error?.message }),
      error: launched.status === 'failed' ? launched.error?.code : undefined,
      changes: launched.changes, metadata: { commandJob: launched }, durationMs: Date.now() - startedAt }
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
    const failureSummary = finished.status === 'succeeded' ? '' :
      `[${finished.error?.code ?? 'COMMAND_FAILED'}] status=${finished.status}; exitCode=${finished.exitCode ?? 'null'}; signal=${finished.signal ?? 'none'}: ${detail}`
    return { success: finished.status === 'succeeded', output: [expired ? '[Command output expired from retained history]' : truncated ? '[Output truncated; retained tail follows]' : '',
      failureSummary, text || (finished.status === 'succeeded' ? detail : ''),
      commandChangeSummary(finished)].filter(Boolean).join('\n'),
      error: finished.status === 'succeeded' ? undefined : finished.error?.code,
      changes: finished.changes,
      metadata: { commandJob: finished, exitCode: finished.exitCode, signal: finished.signal, outputTruncated: truncated },
      durationMs: Date.now() - startedAt }
  },
}

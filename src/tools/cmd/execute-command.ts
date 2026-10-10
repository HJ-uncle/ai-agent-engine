import fs from 'node:fs'
import path from 'node:path'
import { throwIfAborted } from '../../core/utils/abort.js'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { commandJobs, type CommandJobScope } from '../../core/command-jobs/index.js'
import { policyEngine, getSecurityMode } from '../../security/policy-engine.js'
import { workspaceManager } from '../../workspace/index.js'
import { commandLooksLikeShellLine, createCommandLaunchPlan } from '../../core/command-jobs/launch-plan.js'

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
  description: '使用可执行文件 command + 参数数组 args 执行命令，默认不经 shell；不要把 node -v 等整行命令放进 command。示例：{"command":"node","args":["-v"]}。Node/Python 内联源码直接作为 -e/-c 的下一项参数，无需套 cmd 或手工添加 shell 引号。按当前安全策略执行；默认前台等待退出；background=true 启动后台命令并返回 jobId，成功启动不等于命令成功。Code 模式未指定 timeoutMs 时持续运行直到退出或取消；使用 command_output 查看完整分页输出/真实退出状态，cancel_command 停止。重启后不重跑或接管原进程。',
  preflight: preflightCommand,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '仅可执行文件名或路径，如 node、npm、C:\\Program Files\\nodejs\\node.exe；路径不要加引号，不要带参数。Windows 自动解析 PATH/PATHEXT 中的 .cmd/.bat。' },
      args: { type: 'array', items: { type: 'string' }, description: '逐项参数，保留原始内容，不手工包 shell 引号。例如 ["-v"] 或 ["-e", "console.log(\"hello\")"]。管道/重定向须显式使用对应 shell（Windows cmd.exe 的 args=["/d","/s","/c","完整 shell 脚本"]）；脚本内容由该 shell 解析。' },
      cwd: { type: 'string', description: '工作目录，仍受当前工作区安全策略限制' },
      timeoutMs: { type: 'number', description: '可选超时毫秒数；省略时 Code 模式持续运行直到退出或取消，其他模式使用安全默认值' },
      background: { type: 'boolean', description: '默认false；true在成功启动后立即返回jobId，后续读取输出或取消' },
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
    const defaultTimeout = background ? 600_000 : mode === 'full-access' ? 120_000 : 30_000
    // Code runs are durable work: an omitted deadline must not terminate a legitimate long build, test, or server.
    const configuredTimeout = timeoutMs ?? (ctx.toolProfile === 'code' ? undefined : Number(process.env.CMD_TIMEOUT_MS ?? defaultTimeout))
    const timeout = configuredTimeout === undefined ? undefined : (Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? Math.max(1, Math.floor(configuredTimeout)) : defaultTimeout)
    const scope = commandJobScope(ctx)
    const launched = await commandJobs.start({ ...scope, ownerSessionId: ctx.sessionId,
      runId: ctx.rootRunId, ownerRunId: ctx.runId, turnId: ctx.turnId ?? ctx.conversationId, toolCallId: ctx.currentToolCallId,
      command, args, cwd, background, timeoutMs: timeout, signal: ctx.signal,
      env: mode === 'full-access' ? { ...process.env } : {
        PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, HOME: cwd, SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC,
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
    const failureSummary = finished.status === 'succeeded' ? '' :
      `[${finished.error?.code ?? 'COMMAND_FAILED'}] status=${finished.status}; exitCode=${finished.exitCode ?? 'null'}; signal=${finished.signal ?? 'none'}: ${detail}`
    return { success: finished.status === 'succeeded', output: [expired ? '[Command output expired from retained history]' : truncated ? '[Output truncated; retained tail follows]' : '',
      failureSummary, text || (finished.status === 'succeeded' ? detail : '')].filter(Boolean).join('\n'),
      error: finished.status === 'succeeded' ? undefined : finished.error?.code,
      metadata: { commandJob: finished, exitCode: finished.exitCode, signal: finished.signal, outputTruncated: truncated },
      durationMs: Date.now() - startedAt }
  },
}

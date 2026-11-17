import fs from 'node:fs'
import path from 'node:path'
import { throwIfAborted } from '../../core/utils/abort.js'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { commandJobs, type CommandJobScope } from '../../core/command-jobs/index.js'
import { policyEngine, getSecurityMode } from '../../security/policy-engine.js'
import { workspaceManager } from '../../workspace/index.js'
import { commandLooksLikeShellLine, createCommandLaunchPlan } from '../../core/command-jobs/launch-plan.js'
import { createCommandChangeObserver } from './command-change-observer.js'
import { formatCommandReceipt, readCommandReceipt, type CommandReceiptResult } from './command-receipt.js'
import { getToolOutputLimit } from '../../core/agent-loop/tool-output-limit.js'
import { createCommandEnvironment } from './command-environment.js'
import { captureBuildSource, resolveSourceChangeChoice, sourceChangePendingAction, verifySourceSnapshot, type BuildSourceSnapshot, type SourceChangeChoice, type SourceChangeWait } from '../../runtime/source-change-protocol.js'
import { getSourceChangeWaitStatus, SOURCE_CHANGE_WAIT_DEFAULTS } from '../../runtime/source-change-wait.js'

export interface CMDToolOptions { timeoutMs?: number; allowedCommands?: string[] }
interface CommandArgs { command: string; args?: string[]; cwd?: string; timeoutMs?: number; background?: boolean }

function isBuildInvocation(command: string, args: readonly string[]): boolean {
  const name = path.basename(command).toLowerCase().replace(/\.cmd$|\.exe$/i, '')
  if (name === 'npm' || name === 'pnpm' || name === 'yarn') return args.some(arg => /^build(?::|$)/i.test(arg)) || args.includes('run') && args.some(arg => /^build(?::|$)/i.test(arg))
  if (name === 'node' || name === 'tsx' || name === 'ts-node' || name === 'npx') return args.some(arg => /(?:^|[\\/])(?:scripts[\\/])?build(?:\.[cm]?[jt]s)?$/i.test(arg))
  return /(?:^|[\\/])build(?:\.[cm]?[jt]s)?$/i.test(command)
}

function tryBuildSourceSnapshot(cwd: string, command: string, args: readonly string[]): BuildSourceSnapshot | undefined {
  if (!isBuildInvocation(command, args) || !fs.existsSync(path.join(cwd, 'package.json')) || !fs.existsSync(path.join(cwd, 'src'))) return undefined
  try { return captureBuildSource(cwd) } catch { return undefined }
}

/**
 * A source-change receipt can remain visible while a different live command
 * still owns the overlapping workspace.  The receipt intentionally contains
 * only execution identifiers and paths; command text and output stay private.
 */
async function sourceChangeWaitFor(ctx: AgentContext, root: string, snapshot: BuildSourceSnapshot, currentJobId: string): Promise<SourceChangeWait | undefined> {
  const status = await getSourceChangeWaitStatus({ tenantId: ctx.tenantId, root,
    currentSessionId: ctx.rootSessionId ?? ctx.sessionId, currentRunId: ctx.rootRunId ?? ctx.runId,
    currentJobId,
    snapshot, stableWindowMs: SOURCE_CHANGE_WAIT_DEFAULTS.stableWindowMs })
  // Automatic waiting is reserved for a proven overlapping writer. A build
  // can legitimately change generated sources by itself; that case must keep
  // the explicit source-change choices instead of silently retrying.
  if (!status.blockers.length) return undefined
  const reason = status.reason === 'ready' ? 'stable-window' : status.reason
  return { mode: 'external-writer', reason, startedAt: status.observedAt, pollMs: SOURCE_CHANGE_WAIT_DEFAULTS.pollMs,
    stableWindowMs: status.stableWindowMs, blockers: status.blockers }
}

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
    const maxChars = getToolOutputLimit(ctx.toolProfile, ctx)
    // A newly launched job must return its identity plus an honest receipt even
    // if reading logs fails. Reject before side effects when that cannot fit.
    if (maxChars < 1024) return { success: false, error: 'COMMAND_OUTPUT_BUDGET_TOO_SMALL',
      output: 'Command not started. Retry execute_cmd alone with an output allowance of at least 1024 characters.'.slice(0, maxChars) }
    const blocked = await preflightCommand(rawArgs, ctx)
    if (blocked) return blocked
    const { command, args = [], cwd: cwdArg, timeoutMs, background = false } = rawArgs as CommandArgs
    const mode = getSecurityMode(ctx.tenantId, ctx.rootSessionId ?? ctx.sessionId)
    workspaceManager.init(ctx)
    const cwd = fs.realpathSync(workspaceManager.resolveSafePath(ctx, cwdArg ?? workspaceManager.getWorkingDirectory(ctx)))
    workspaceManager.resolveSafePath(ctx, cwd)
    throwIfAborted(ctx.signal)
    const sourceAction = ctx.resumeToolCall?.pendingAction?.type === 'source_change' ? ctx.resumeToolCall.pendingAction : undefined
    const sourceChoice = sourceAction ? resolveSourceChangeChoice(sourceAction, ctx.resumeToolCall?.output) : undefined
    if (sourceAction && sourceChoice === 'pause') return { success: false, status: 'interrupted', output: '已暂停构建：外部源码变化仍需重新检查。', error: 'SOURCE_CHANGE_PAUSED', metadata: { sourceChange: { choice: sourceChoice, risk: false } } }
    // A recheck/rebuild choice starts this exact tool call again against a
    // fresh source identity. Full-access approvals never bypass this guard.
    const buildSnapshot = tryBuildSourceSnapshot(cwd, command, args)
    // An omitted deadline is unlimited in every profile. A caller can still
    // opt into an explicit positive timeout for a bounded probe.
    if (background && buildSnapshot) return { success: false, status: 'failed', output: '构建源码保护要求前台执行，以便在结束时完成最终版本复核；请将 background 设为 false 后重试。', error: 'SOURCE_GUARD_REQUIRES_FOREGROUND', metadata: { sourceChange: { code: 'SOURCE_GUARD_REQUIRES_FOREGROUND', fileMutationApplied: false } } }
    const timeout = timeoutMs === undefined ? undefined
      : (Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.max(1, Math.floor(timeoutMs)) : undefined)
    const scope = commandJobScope(ctx)
    const launched = await commandJobs.start({ ...scope, ownerSessionId: ctx.sessionId,
      runId: ctx.rootRunId, ownerRunId: ctx.runId, turnId: ctx.turnId ?? ctx.parentConversationId ?? ctx.conversationId, toolCallId: ctx.currentToolCallId,
      command, args, cwd, background, timeoutMs: timeout, signal: ctx.signal,
      observeChanges: job => createCommandChangeObserver(ctx, cwd, job),
      env: createCommandEnvironment(mode, cwd),
    })
    if (background) {
      const receipt = formatCommandReceipt(launched, { maxChars })
      return { success: !receipt.error && (launched.status === 'running' || launched.status === 'succeeded'),
        output: receipt.output, error: receipt.error ?? (launched.status === 'failed' ? launched.error?.code : undefined),
        changes: launched.changes, metadata: { commandJob: launched }, durationMs: Date.now() - startedAt }
    }
    const finished = (await commandJobs.wait(scope, launched.jobId))!
    // Preserve the foreground abort contract; the durable job retains all available output.
    throwIfAborted(ctx.signal)
    // Read one budgeted page in reception order. Full output remains durable;
    // the receipt cursor only advances past text actually returned to the model.
    let outputError: string | undefined
    const readResult = async (notice?: string): Promise<CommandReceiptResult> => {
      const noticeCost = notice ? JSON.stringify({ notice }).length - 1 : 0
      let receipt: CommandReceiptResult | null = null
      try { receipt = await readCommandReceipt(scope, launched.jobId, { maxChars: Math.max(1, maxChars - noticeCost) }) }
      catch { outputError = 'COMMAND_OUTPUT_FAILED' }
      if (!receipt?.receipt) {
        outputError ??= receipt?.error ?? 'COMMAND_OUTPUT_EXPIRED'
        // Log delivery failure is separate from process execution. Preserve the
        // new jobId/exit status, changes metadata and any source-change approval;
        // never tell the model to repeat an already executed command.
        const fallbackNotice = [notice, `${outputError}: 命令已执行，请勿重复运行。使用 command_output 和本回执 jobId 从 cursor=0 读取日志；完整文件变化与覆盖限制请在界面审阅。`].filter(Boolean).join('\n')
        const overhead = JSON.stringify({ notice: fallbackNotice }).length - 1
        const fallback = formatCommandReceipt({ ...finished, changes: undefined, changeTracking: undefined }, { maxChars: maxChars - overhead })
        if (!fallback.receipt) throw new Error('Minimum command execution receipt budget violated')
        const annotated = { ...fallback.receipt, notice: fallbackNotice }
        return { job: finished, receipt: annotated, output: JSON.stringify(annotated) }
      }
      if (!notice) return receipt
      const annotated = { ...receipt.receipt, notice }
      return { ...receipt, receipt: annotated, output: JSON.stringify(annotated) }
    }
    let sourceChange: { choice: SourceChangeChoice; risk: boolean } | undefined
    if (buildSnapshot) {
      try {
        const check = verifySourceSnapshot(buildSnapshot)
        if (check.changed) {
          const wait = await sourceChangeWaitFor(ctx, buildSnapshot.root, check.after as BuildSourceSnapshot, finished.jobId)
          const pending = sourceChangePendingAction(check, { phase: 'build', operation: 'execute_cmd', wait })
          const notice = [wait ? '检测到其他会话仍在修改同一源码目录，已自动等待其结束；结束后将重新校验并继续。' : '',
            sourceChoice ? `构建重试后再次检测到源码变化（上次选择 ${sourceChoice}）。请选择下一步；构建结果仍未被信任。` : '构建期间检测到外部源码变化。请选择 pause、recheck、rebuild 或 skip；构建结果未被信任。'].filter(Boolean).join('\n')
          const receipt = await readResult(notice)
          return { success: false, status: 'waiting', needsConfirmation: true,
            output: receipt.output,
            error: 'SOURCE_CHANGED_DURING_BUILD', pendingAction: pending, changes: finished.changes,
            metadata: { commandJob: finished, sourceChange: { code: 'SOURCE_CHANGED_DURING_BUILD', previousChoice: sourceChoice, choices: pending.choices, fileMutationApplied: false, ...(wait ? { wait } : {}) }, exitCode: finished.exitCode, signal: finished.signal,
              ...(outputError ? { commandOutputError: outputError } : {}) }, durationMs: Date.now() - startedAt }
        } else if (sourceChoice) sourceChange = { choice: sourceChoice, risk: sourceChoice === 'skip' }
      } catch (error) {
        return { success: false, status: 'failed', output: `SOURCE_RECHECK_FAILED: ${error instanceof Error ? error.message : String(error)}`,
          error: 'SOURCE_RECHECK_FAILED', metadata: { commandJob: finished, sourceChange: { choice: sourceChoice, risk: sourceChoice === 'skip', finalVerification: 'failed' } }, durationMs: Date.now() - startedAt }
      }
    }
    const receipt = await readResult(sourceChange ? `[source-change] choice=${sourceChange.choice}; risk=${sourceChange.risk}` : undefined)
    return { success: !receipt.error && finished.status === 'succeeded', output: receipt.output,
      error: receipt.error ?? (finished.status === 'succeeded' ? undefined : finished.error?.code),
      changes: finished.changes,
      metadata: { commandJob: finished, exitCode: finished.exitCode, signal: finished.signal,
        outputTruncated: receipt.receipt?.truncated ?? true, ...(outputError ? { commandOutputError: outputError } : {}), ...(sourceChange ? { sourceChange } : {}) },
      durationMs: Date.now() - startedAt }
  },
}

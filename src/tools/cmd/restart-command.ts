import fs from 'node:fs'
import type { AgentContext } from '../../core/agent-context/index.js'
import { commandJobs, commandJobIsTerminal, type CommandJobSnapshot } from '../../core/command-jobs/index.js'
import { ToolRegistry } from '../../core/tool-registry/index.js'
import { throwIfAborted } from '../../core/utils/abort.js'
import { createConversationHistory } from '../../storage/conversation/factory.js'
import { workspaceManager } from '../../workspace/index.js'
import { cmdTool } from './execute-command.js'

export class CommandRestartError extends Error {
  constructor(readonly statusCode: 403 | 409, readonly code: string, message: string) { super(message) }
}

/** A manual restart is a fresh launch, with current policy and no inherited approval or turn identity. */
export async function restartStoredCommand(
  identity: Pick<AgentContext, 'tenantId' | 'sessionId' | 'logger' | 'signal'>,
  jobId: string,
): Promise<CommandJobSnapshot | null> {
  throwIfAborted(identity.signal)
  const scope = { tenantId: identity.tenantId, sessionId: identity.sessionId }
  const original = await commandJobs.get(scope, jobId)
  if (!original) return null
  if (!original.background || !commandJobIsTerminal(original.status)) {
    throw new CommandRestartError(409, 'COMMAND_JOB_NOT_TERMINAL', 'Only a terminal background command job can be restarted')
  }

  // Do not use the historical cwd as an allowed workspace root. Resolve it
  // against the user's current binding and security mode before executing.
  let cwd: string
  try {
    cwd = fs.realpathSync(workspaceManager.resolveSafePath(scope, original.cwd))
    workspaceManager.resolveSafePath(scope, cwd)
    if (!fs.statSync(cwd).isDirectory()) throw new Error('Command working directory is not a directory')
  } catch (error) {
    throw new CommandRestartError(403, 'COMMAND_RESTART_WORKSPACE_FORBIDDEN', error instanceof Error ? error.message : 'Command working directory is unavailable')
  }
  const context: AgentContext = {
    ...scope, logger: identity.logger, signal: identity.signal,
    workspaceDir: workspaceManager.getScratchDirectory(scope),
    // This profile rejects legacy session-wide approvals. No model is run;
    // the registry/history complete the native tool context without granting
    // business capabilities or writing conversation messages.
    toolProfile: 'code', tools: new ToolRegistry(), history: createConversationHistory(),
  }
  const binding = workspaceManager.getBindingSnapshot(context)
  try {
    return await workspaceManager.withBindingLease(context, binding, async () => {
      const result = await cmdTool.execute({ command: original.command, args: [...original.args], cwd, background: true }, context)
      const launched = result.metadata?.commandJob as CommandJobSnapshot | undefined
      // A spawn failure still owns a real failed job. Return that identity so
      // callers can inspect its terminal state instead of guessing/retrying.
      if (launched) return launched
      if (result.needsConfirmation) throw new CommandRestartError(409, 'COMMAND_RESTART_APPROVAL_REQUIRED',
        `${result.output}。请在当前会话重新执行命令并完成确认；重启按钮不会代替批准。`)
      if (result.metadata?.blocked) throw new CommandRestartError(403, 'COMMAND_RESTART_POLICY_DENIED', result.output)
      throw new CommandRestartError(409, result.error ?? 'COMMAND_RESTART_REJECTED', result.output || 'Command restart was rejected before launch')
    })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'WORKSPACE_LEASE_BUSY') {
      throw new CommandRestartError(409, 'COMMAND_RESTART_WORKSPACE_BUSY', '工作区正在切换或执行需要固定绑定的操作，请稍后刷新并重试。')
    }
    throw error
  }
}

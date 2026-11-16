import type { AgentContext, Pending } from '../core/agent-context/types.js'
import { getExecutionOwners, type ExecutionOwner } from '../core/collaboration/execution-owner.js'
import { installProductionCollaborationBoundary } from '../core/collaboration/production-boundary.js'
import { admissionProjectingHistory, readAdmissionSeed } from '../storage/root-admission/projection.js'
import { markPluginRootRequest, readPluginRootProvenance } from '../storage/root-admission/plugin-owner.js'
import { rootRunStore, type RootRun, type RootPending } from '../storage/root-runs/index.js'
import { getDb } from '../storage/sqlite/db.js'
import { publicPending } from '../core/stream-pipeline/public-pending.js'
import { workspaceManager } from '../workspace/index.js'
import type { WorkspaceBindingSnapshot } from '../workspace/manager.js'
import { ensureControllerSchema, assertControllerRoot } from '../core/collaboration/controller-origin.js'
import { resolveSourceChangeChoice } from '../runtime/source-change-protocol.js'
import type { CapabilityAccess, PluginExecutionContext } from './capability-runtime.js'
import { bindPluginWorkbench } from './workbench-binding.js'
import { PluginError } from './types.js'
import { browserBridge } from '../tools/browser/browser-bridge.js'
import type { BrowserHostAuthority } from '../core/browser-authority.js'

const parkedBrowsers = new Map<string, { authority: BrowserHostAuthority; sessionId: string; rootRunId: string }>()
const browserKey = (tenantId: string, rootRunId: string) => JSON.stringify([tenantId, rootRunId])

export async function createPluginAgentRoot(access: CapabilityAccess, tenantId: string, childSessionId: string,
  boundSessionId: string, modelId: string, workspaceRoot: string, task: string, signal?: AbortSignal): Promise<RootRun> {
  return rootRunStore.create(tenantId, childSessionId, modelId, [workspaceRoot], markPluginRootRequest({
    message: task, toolProfile: 'general', memoryScope: 'off',
  }, { pluginId: access.id, revision: access.revision, boundSessionId }), undefined, signal)
}

export async function ownedPluginRoot(access: CapabilityAccess, tenantId: string, boundSessionId: string,
  childSessionId: string, rootRunId: string): Promise<NonNullable<Awaited<ReturnType<typeof rootRunStore.get>>>> {
  const root = await rootRunStore.get(tenantId, rootRunId)
  const owner = root ? readPluginRootProvenance(root.request) : undefined
  if (!root || root.sessionId !== childSessionId || !owner || owner.pluginId !== access.id || owner.boundSessionId !== boundSessionId)
    throw new PluginError('PLUGIN_AGENT_NOT_FOUND', '此 Agent 执行不属于当前插件与会话', 404)
  if (owner.revision !== access.revision) throw new PluginError('PLUGIN_STALE', '插件版本已变化，请重新发起任务', 409)
  return root
}

export async function assertPluginAgentController(tenantId: string, root: Awaited<ReturnType<typeof ownedPluginRoot>>, execution?: PluginExecutionContext, expectedAttemptId = root.attemptId): Promise<void> {
  const subject = execution?.controllerSubject, db = getDb()
  if (!subject || subject.tenantId !== tenantId) throw new PluginError('PLUGIN_AGENT_CONTROLLER', '需要原会话用户通过宿主回答此请求', 403)
  await ensureControllerSchema(db)
  const scope = { tenantId, rootSessionId: root.sessionId, rootRunId: root.runId, rootAttemptId: expectedAttemptId }
  // A desktop restart creates a fresh verified local process identity. Accounts
  // retain an exact controller key across attempts and may never change users.
  const prior = (await db.execute({ sql: 'SELECT subject_kind,auth_method FROM collaboration_controller_roots WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND root_session_id=?',
    args: [tenantId, root.runId, expectedAttemptId, root.sessionId] })).rows[0]
  if (subject.kind === 'instance' && subject.method === 'local-instance' && prior?.subject_kind === 'instance' && prior.auth_method === 'local-instance') return
  try { await assertControllerRoot(db, scope, subject) }
  catch { throw new PluginError('PLUGIN_AGENT_CONTROLLER', '此用户无权回答当前 Agent 请求', 403) }
}

/** Exact root identity, admission projection and descendant ownership are shared with ordinary Agents. */
export async function executePluginAgentRoot(input: {
  root: RootRun; context: AgentContext; access: CapabilityAccess; boundSessionId: string;
  workspaceContext: NonNullable<PluginExecutionContext['workspaceContext']>; workspace: Readonly<WorkspaceBindingSnapshot>;
  execution?: PluginExecutionContext; resumedPending?: RootPending;
  onPending(pending: ReturnType<typeof publicPending>): Promise<void>;
  run(context: AgentContext): Promise<void>;
}): Promise<void> {
  const { context: ctx, root, access } = input, owners = getExecutionOwners(), controller = new AbortController(), parentSignal = ctx.signal
  parkedBrowsers.delete(browserKey(ctx.tenantId, root.runId))
  const abort = () => controller.abort(parentSignal?.reason)
  if (parentSignal?.aborted) abort()
  parentSignal?.addEventListener('abort', abort, { once: true })
  let owner: ExecutionOwner | undefined, unbind: (() => void) | undefined, parked = false, settled = false
  let resolveCompletion!: () => void, rejectCompletion!: (error: unknown) => void
  const completion = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject })
  void completion.catch(() => undefined)
  try {
    const stored = await ownedPluginRoot(access, ctx.tenantId, input.boundSessionId, ctx.sessionId, root.runId)
    owner = await owners.admitRoot({ tenantId: ctx.tenantId, rootRunId: root.runId, rootAttemptId: stored.attemptId,
      controller, controllerSubject: input.execution?.controllerSubject })
    owners.registerCompletion(owner, completion)
    Object.assign(ctx, { executionOwner: owner, signal: controller.signal, rootSessionId: root.sessionId, rootRunId: root.runId,
      turnId: root.turnId, conversationId: root.turnId, userMessageId: root.userMessageId, assistantMessageId: root.assistantMessageId })
    delete ctx.runId; delete ctx.parentSessionId
    workspaceManager.inheritPluginRootWorkspace(ctx, input.workspaceContext, input.workspace)
    unbind = bindPluginWorkbench(owner, { sessionId: input.boundSessionId, pluginId: access.id, userId: input.execution?.browserPrincipal?.userId })
    const seed = await readAdmissionSeed(getDb(), ctx, root.runId)
    ctx.history = admissionProjectingHistory(ctx.history, seed.anchor)
    installProductionCollaborationBoundary(ctx)
    if (input.resumedPending) {
      const pending = input.resumedPending
      const sourceChoice = pending.pendingAction?.type === 'source_change' && resolveSourceChangeChoice(pending.pendingAction, pending.output) !== undefined
      ctx.resumeToolCall = { toolCall: { id: pending.toolCallId, name: pending.toolName, args: pending.args }, messageId: pending.messageId ?? '',
        decision: pending.kind === 'permission' ? pending.output === 'approved' || sourceChoice ? 'approved' : 'rejected' : 'answered',
        output: pending.output, pendingAction: pending.pendingAction }
    }
    let candidate: Pending | undefined
    ctx.onPending = pending => { candidate = structuredClone(pending) }
    ctx.commitPending = async pending => {
      if (!candidate || candidate.requestId !== pending.requestId) throw new Error('PENDING_CANDIDATE_MISMATCH')
      const value = await rootRunStore.finishOwned(owner!, { status: 'waiting' }, candidate)
      parked = value.status === 'waiting'; settled = true
      if (!parked) throw new Error('PENDING_EXECUTION_CANCELLED')
      await input.onPending(publicPending(candidate))
    }
    const observer = ctx.runObserver
    ctx.runObserver = { ...observer, onOutcome: async outcome => {
      if (!settled) {
        await rootRunStore.finishOwned(owner!, { status: outcome.stopReason === 'incomplete' ? 'interrupted' : outcome.status === 'blocked' ? 'failed' : outcome.status,
          error: outcome.error, stopReason: outcome.stopReason })
        settled = true
      }
      await observer?.onOutcome?.(outcome)
    } }
    await input.run(ctx)
    if (!settled) { await rootRunStore.finishOwned(owner, { status: 'succeeded' }); settled = true }
  } catch (error) {
    if (owner && !settled) { await rootRunStore.finishOwned(owner, { status: controller.signal.aborted ? 'cancelled' : 'failed', stopReason: 'plugin_execution_failed' }); settled = true }
    else if (owner && parked && controller.signal.aborted) { await rootRunStore.cancelParked(owner, 'plugin_cancelled_while_waiting'); parked = false }
    throw error
  } finally {
    let cleanupError: unknown
    try {
      if (owner && parked && parentSignal?.aborted) { await rootRunStore.cancelParked(owner, 'plugin_cancelled_while_waiting'); parked = false }
    } catch (error) { cleanupError = error }
    finally {
      unbind?.(); parentSignal?.removeEventListener('abort', abort)
      if (ctx.browserAuthority) {
        if (parked && !parentSignal?.aborted && !cleanupError) parkedBrowsers.set(browserKey(ctx.tenantId, root.runId), { authority: ctx.browserAuthority, sessionId: ctx.sessionId, rootRunId: root.runId })
        else browserBridge.hostDemands.releaseRoot(ctx.browserAuthority, ctx.sessionId, root.runId)
      }
      try { if (owner && settled && !cleanupError) owners.releaseRoot(owner) }
      catch (error) { cleanupError = error }
      if (cleanupError || owner && !settled) rejectCompletion(cleanupError ?? new Error('PLUGIN_ROOT_CLEANUP_UNKNOWN'))
      else resolveCompletion()
    }
    if (cleanupError) throw cleanupError
  }
}

/** A parked root has no active owner; cancellation is still durable across restart. */
export async function cancelInactivePluginRoot(tenantId: string, rootRunId: string, reason: string): Promise<void> {
  const root = await rootRunStore.get(tenantId, rootRunId)
  if (root && ['running', 'waiting'].includes(root.status) && !getExecutionOwners().find(tenantId, root.runId, root.attemptId))
    await rootRunStore.update(tenantId, root.runId, { status: 'cancelled', stopReason: reason }, root.attemptId)
  const key = browserKey(tenantId, rootRunId), browser = parkedBrowsers.get(key)
  if (browser && !getExecutionOwners().find(tenantId, rootRunId, root?.attemptId ?? '')) {
    browserBridge.hostDemands.releaseRoot(browser.authority, browser.sessionId, browser.rootRunId); parkedBrowsers.delete(key)
  }
}

export async function cancelParkedPluginRoots(tenantId: string, pluginId: string): Promise<void> {
  const db = await rootRunStore.admissionDatabase()
  const rows = await db.execute({ sql: "SELECT run_id,state FROM root_runs WHERE tenant_id=? AND json_extract(state,'$.status')='waiting'", args: [tenantId] })
  for (const row of rows.rows) {
    const request = JSON.parse(String(row.state)).request
    if (readPluginRootProvenance(request)?.pluginId === pluginId) await cancelInactivePluginRoot(tenantId, String(row.run_id), 'plugin_disabled')
  }
}

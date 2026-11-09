import type { Message } from '../agent-context/types.js'

export const DELIVERY_CLOSEOUT_PROMPT = 'The complete final file list is staged after acceptance. Use this one closeout opportunity to reconcile the saved plan with actual evidence, including the successful registration step, then answer. Never mark unfinished work completed. Do not repeat document editing, inspection or exploration. If a concrete new defect requires repair, first revoke the list with deliver_files({items:[]}); repair and validate before registering the full list again. A new user instruction may reopen work.'
export const DELIVERY_ANSWER_PROMPT = 'File delivery closeout has finished. Give the final answer now using the accepted files and evidence. Preserve any unresolved plan steps honestly and explain material unfinished work; do not mark them completed merely to close the run. No more editing or exploration is available in this closeout.'

/** Only durable, successful root receipts enter closeout; model prose never does. */
export class DeliveryCloseout {
  private seen = new Set<string>()
  private active?: { callId: string; phase: 'reconcile' | 'answer' }
  hasSelection = false
  revision = 0

  observe(messages: Message[], scope: { rootRunId?: string; turnId?: string; parentSessionId?: string }): void {
    if (!scope.rootRunId || !scope.turnId || scope.parentSessionId) return
    const calls = new Map(messages.filter(message => message.toolCall).map(message => [message.toolCall!.id, message.toolCall!]))
    for (const message of messages) {
      if (!message.id || this.seen.has(message.id) || message.metadata?.rootRunId !== scope.rootRunId || message.metadata?.turnId !== scope.turnId) continue
      this.seen.add(message.id)
      if (message.role === 'user' && (!message.metadata.collaborationDelivery || message.metadata.collaborationDelivery.source === 'user-controller')) {
        this.active = undefined
        continue
      }
      if (message.role !== 'tool') continue
      const call = calls.get(message.toolCallId ?? '')
      const success = message.metadata.success === true && (!message.metadata.status || message.metadata.status === 'succeeded')
      if (call?.name === 'deliver_files' && message.toolName === 'deliver_files' && success && Array.isArray(call.args.items)) {
        this.revision++
        this.hasSelection = call.args.items.length > 0
        if (!call.args.items.length) this.active = undefined
        else this.active = { callId: call.id, phase: this.active ? 'answer' : 'reconcile' }
      } else if (this.active) {
        // Even a failed closeout update consumes this opportunity: do not
        // turn an honest stale plan into another unbounded tool loop.
        this.active.phase = 'answer'
      }
    }
  }

  get phase(): 'reconcile' | 'answer' | undefined { return this.active?.phase }
  get prompt(): string { return this.phase === 'reconcile' ? DELIVERY_CLOSEOUT_PROMPT : this.phase === 'answer' ? DELIVERY_ANSWER_PROMPT : '' }
  invalidate(): void { this.active = undefined }

  tools<T extends { name: string }>(tools: T[]): T[] {
    return this.phase === 'answer' ? [] : this.phase === 'reconcile'
      ? tools.filter(tool => tool.name === 'plan_update' || tool.name === 'deliver_files') : tools
  }
}

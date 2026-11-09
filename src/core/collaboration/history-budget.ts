import { CollaborationError } from './types.js'

/** Only a successfully authenticated, newer snapshot can request re-budgeting.
 * Invalid authority, edited admission anchors and damaged receipts must retain
 * their original errors and must never be retried through this path. */
export class RequestHistoryChangedError extends CollaborationError {
  constructor(readonly backend: 'sqlite' | 'jsonl') {
    super('conflict', `${backend === 'jsonl' ? 'JSONL history' : 'History'} changed after request budgeting; no provider request was dispatched`)
    this.name = 'RequestHistoryChangedError'
  }
}

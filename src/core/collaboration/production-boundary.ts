import type { AgentContext } from '../agent-context/types.js'
import { sqliteHistoryIdentity } from '../../storage/conversation/sqlite-origin.js'
import { jsonlHistoryIdentity } from '../../storage/conversation/jsonl-origin.js'
import { createSQLiteReActBoundary } from './sqlite-react-boundary.js'
import { createJSONLReActBoundary } from './jsonl-react-boundary.js'
import { CollaborationError } from './types.js'

/** Invoke only after canonical admission and immutable root/child identities are installed. */
export function installProductionCollaborationBoundary(ctx: AgentContext): void {
  if (!ctx.executionOwner) throw new CollaborationError('forbidden', 'Production collaboration requires canonical execution ownership')
  if (ctx.sqliteDelivery || ctx.jsonlDelivery) throw new CollaborationError('conflict', 'Production context already owns a private delivery boundary')
  if (sqliteHistoryIdentity(ctx.history)) ctx.sqliteDelivery = createSQLiteReActBoundary(ctx)
  else if (jsonlHistoryIdentity(ctx.history)) ctx.jsonlDelivery = createJSONLReActBoundary(ctx)
  else throw new CollaborationError('forbidden', 'Production history backend has no trusted delivery origin')
}

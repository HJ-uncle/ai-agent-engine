import { createHash, randomUUID } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import type { StreamSnapshot } from '../stream-pipeline/stream-bus.js'
import { ensureChildRecoverySchema } from './child-recovery-schema.js'
import { childProjectionReferences, resolvePublishedProjectionReferences } from './child-recovery-projection.js'
import { requireChildRecovery, recoveryVersion } from './child-usage-authority.js'
import { assertPublishedFence, capturePublishedFence, ensurePublicationOwner, lookupPublishedChild, readLiveChildUsage,
  PUBLISHED_CHILD_PAGE_BYTES, type PublicationScope, type PublishedFence } from './published-store.js'
import { PublishedRecoveryLeases } from './recovery-leases.js'
import { assertTurnBootstrapArchive, assertTurnBootstrapEntry, assertTurnBootstrapProof, barePublishedFence, bootstrapHash, publishedVersionProof, turnBootstrapDigest } from './turn-bootstrap-proof.js'
import type { ChildProjectionReference } from './recovery-leases.js'
import { prepareBootstrapBody, readBootstrapBody, type BootstrapBodyArchive } from './turn-bootstrap-body.js'

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
const scopeKeys = ['tenantId', 'parentSessionId', 'rootSessionId', 'parentTurnId', 'rootRunId', 'attemptId', 'streamId'] as const
const ownerArgs = (scope: PublicationScope) => [scope.tenantId, scope.parentSessionId, scope.streamId]
type RestoredSnapshot = Omit<StreamSnapshot, 'subagentWatermarks'> & { projectionIndices: number[]; bodyArchive?: BootstrapBodyArchive }
type RunScope = Omit<PublicationScope, 'streamId'>
export interface TurnBootstrap {
  checkpointId: string
  source: 'persisted-published'
  fence: PublishedFence
  /** This is the current-turn projection at E, not mutable execution/latest state. */
  snapshot: RestoredSnapshot
  originalProjectionCount: number
  projectionReferenceCount: number
  currentTurnComplete: boolean
}
/** Durable turn checkpoints are created only at the producer publication fence.
 * Missing older bootstraps are explicit recovery; latest child state never fills
 * a previous stream's admitted prefix. No capability or route is enabled here. */
export class PublishedTurnBootstraps {
  private readyPromise?: Promise<void>
  constructor(readonly db: Client, private readonly now: () => number = Date.now) {}
  private ready(): Promise<void> { return this.readyPromise ??= ensureChildRecoverySchema(this.db).catch(error => { this.readyPromise = undefined; throw error }) }
  private async transaction<T>(mode: 'read' | 'write', action: (tx: Transaction) => Promise<T>): Promise<T> {
    const tx = await this.db.transaction(mode)
    try { const value = await action(tx); if (mode === 'write') await tx.commit(); else await tx.rollback(); return value }
    catch (error) { if (!tx.closed) await tx.rollback(); throw error }
    finally { tx.close() }
  }
  private async assertRootOwner(tx: Transaction, scope: PublicationScope, version?: number): Promise<void> {
    const row = (await tx.execute({ sql: `SELECT turn_id,json_extract(state,'$.attemptId') AS attempt_id,
      json_extract(state,'$.version') AS version,json_extract(state,'$.status') AS status
      FROM root_runs WHERE tenant_id=? AND session_id=? AND run_id=?`, args: [scope.tenantId,scope.parentSessionId,scope.rootRunId] })).rows[0]
    if (!row || row.turn_id !== scope.parentTurnId || row.attempt_id !== scope.attemptId || version !== undefined && Number(row.version) !== version)
      requireChildRecovery('root_owner_changed')
    if (version === undefined && row.status !== 'running') requireChildRecovery('root_owner_inactive')
  }
  async capture(scope: PublicationScope, input: StreamSnapshot, options?: { childSequenceSource: 'published-store' }): Promise<TurnBootstrap> {
    // Freeze caller-owned data before the first await; it cannot change the proof
    // halfway through a held SQLite commit or add an unadmitted child later.
    const snapshot = structuredClone(input), owner = Object.freeze({ ...scope }), resolvePublished = options?.childSequenceSource === 'published-store'
    if (resolvePublished && snapshot.subagentWatermarks?.length) requireChildRecovery('projection_shape_conflict')
    const prefix = owner.streamId + ':'
    if (snapshot.schemaVersion !== 1 || snapshot.streamId !== owner.streamId || !snapshot.eventId.startsWith(prefix) ||
      !/^(0|[1-9][0-9]*)$/.test(snapshot.eventId.slice(prefix.length)) || snapshot.publicationRecovery) requireChildRecovery('bootstrap_prefix_invalid')
    const sequence = recoveryVersion(snapshot.eventId.slice(prefix.length))
    const shape = childProjectionReferences(snapshot), run = shape.projection.find(frame => frame.run)?.run as Record<string, unknown> | undefined
    if (!run || run.runId !== owner.rootRunId || run.turnId !== owner.parentTurnId || run.sessionId !== owner.parentSessionId ||
      !Number.isSafeInteger(run.version) || Number(run.version) < 1) requireChildRecovery('bootstrap_root_invalid')
    const { subagentWatermarks: _marks, ...header } = snapshot
    const ordinary = prepareBootstrapBody({ ...header, projection: shape.projection, projectionIndices: shape.projectionIndices })
    const restored = ordinary.snapshot
    if (shape.entries.length > 4096 || snapshot.projection.length > 16384 || bytes(restored) > PUBLISHED_CHILD_PAGE_BYTES) requireChildRecovery('response_budget')
    const encodedSnapshot = JSON.stringify(restored), clock = this.now()
    if (!Number.isSafeInteger(clock) || clock < 0) throw new Error('Invalid bootstrap clock')
    await this.ready()
    return this.transaction('write', async tx => {
      await this.assertRootOwner(tx, owner, Number(run.version))
      const fence = await capturePublishedFence(tx, owner, sequence)
      await readLiveChildUsage(tx, fence)
      const entries = resolvePublished ? await resolvePublishedProjectionReferences(tx, fence, shape.entries) : shape.entries
      const archive = createHash('sha256')
      for (const entry of entries) archive.update(JSON.stringify(entry) + '\n')
      const archiveDigest = archive.digest('hex')
      const encodedFence = JSON.stringify(fence), digest = turnBootstrapDigest(encodedFence, encodedSnapshot, archiveDigest, snapshot.projection.length, shape.entries.length)
      const runHead = (await tx.execute({ sql: 'SELECT stream_id,generation FROM parent_turn_bootstrap_run_heads WHERE tenant_id=? AND parent_session_id=? AND root_run_id=? AND attempt_id=?',
        args: [owner.tenantId,owner.parentSessionId,owner.rootRunId,owner.attemptId] })).rows[0]
      if (runHead && (runHead.stream_id !== owner.streamId || runHead.generation !== fence.generation)) requireChildRecovery('bootstrap_owner_conflict')
      const previous = (await tx.execute({ sql: `SELECT b.* FROM parent_turn_bootstrap_heads h JOIN parent_turn_bootstraps b ON b.checkpoint_id=h.checkpoint_id
        WHERE h.tenant_id=? AND h.parent_session_id=? AND h.stream_id=? AND h.generation=?`, args: [...ownerArgs(owner),fence.generation] })).rows[0]
      if (previous && (Number(previous.event_sequence) > sequence || Number(previous.event_sequence) === sequence && Number(previous.usage_revision) > fence.usageRevision)) requireChildRecovery('bootstrap_regression')
      if (previous && Number(previous.event_sequence) === sequence && Number(previous.usage_revision) === fence.usageRevision) {
        if (previous.digest !== digest) requireChildRecovery('bootstrap_conflict')
        // Checkpoints from the foundation prototype did not have this index.
        // Idempotent capture still has to bind the trusted run/attempt selector.
        await this.bindRunHead(tx, owner, fence, String(previous.checkpoint_id))
        return this.loadAt(tx, owner, String(previous.checkpoint_id))
      }
      const id = randomUUID()
      await tx.execute({ sql: 'INSERT INTO parent_turn_bootstraps VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', args: [id,owner.tenantId,owner.parentSessionId,owner.streamId,fence.generation,
        sequence,fence.revision,fence.usageRevision,encodedFence,encodedSnapshot,archiveDigest,digest,snapshot.projection.length,shape.entries.length,clock] })
      for (let index=0;index<ordinary.chunks.length;index++) await tx.execute({sql:'INSERT INTO parent_turn_bootstrap_body_chunks VALUES(?,?,?,?)',args:[id,index,ordinary.chunks[index],bootstrapHash(ordinary.chunks[index])]})
      for (const entry of entries) {
        await assertTurnBootstrapEntry(tx, fence, entry, snapshot.projection.length)
        const encoded = JSON.stringify(entry)
        await tx.execute({ sql: 'INSERT INTO parent_turn_bootstrap_refs VALUES(?,?,?,?,?,?)', args: [id,entry.projectionIndex,entry.runId,entry.atSeq,encoded,bootstrapHash(encoded)] })
      }
      await tx.execute({ sql: `INSERT INTO parent_turn_bootstrap_heads VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,parent_session_id,stream_id,generation)
        DO UPDATE SET checkpoint_id=excluded.checkpoint_id`, args: [...ownerArgs(owner),fence.generation,id] })
      await this.bindRunHead(tx, owner, fence, id)
      return this.loadAt(tx, owner, id)
    })
  }
  private async bindRunHead(tx: Transaction, owner: PublicationScope, fence: PublishedFence, id: string): Promise<void> {
    await tx.execute({ sql: `INSERT INTO parent_turn_bootstrap_run_heads VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,parent_session_id,root_run_id,attempt_id)
      DO UPDATE SET checkpoint_id=excluded.checkpoint_id`, args: [owner.tenantId,owner.parentSessionId,owner.rootRunId,owner.attemptId,owner.streamId,fence.generation,id] })
  }
  private async loadAt(tx: Transaction, scope: PublicationScope, id: string): Promise<TurnBootstrap> {
    const row = (await tx.execute({ sql: 'SELECT fence_json,digest FROM parent_turn_bootstraps WHERE checkpoint_id=? AND tenant_id=? AND parent_session_id=?',
      args: [id,scope.tenantId,scope.parentSessionId] })).rows[0]
    if (!row) requireChildRecovery('bootstrap_unavailable')
    let base: PublishedFence
    try { base = JSON.parse(String(row.fence_json)) as PublishedFence } catch { requireChildRecovery('bootstrap_corrupt') }
    for (const key of scopeKeys) if (base[key] !== scope[key]) requireChildRecovery('scope_mismatch')
    const fence: PublishedFence = { ...base, recoveryMode: 'persisted-published', bootstrapId: id, bootstrapDigest: String(row.digest) }
    await assertPublishedFence(tx, fence); await readLiveChildUsage(tx, fence)
    const proof = await assertTurnBootstrapProof(tx, fence), original = Number(proof.original_count)
    await assertTurnBootstrapArchive(tx, fence, proof)
    const count = Number(proof.refs_count)
    let snapshot: RestoredSnapshot
    try { snapshot = JSON.parse(String(proof.snapshot_json)) as RestoredSnapshot } catch { requireChildRecovery('bootstrap_corrupt') }
    if (snapshot.streamId !== fence.streamId || snapshot.eventId !== `${fence.streamId}:${fence.eventSequence}` || !Array.isArray(snapshot.projection) || !Array.isArray(snapshot.projectionIndices) ||
      snapshot.projection.length !== snapshot.projectionIndices.length || snapshot.projectionIndices.some((index, position) => !Number.isSafeInteger(index) || index < 0 || index >= original || position > 0 && index <= snapshot.projectionIndices[position-1])) requireChildRecovery('bootstrap_corrupt')
    return { checkpointId: id, source: 'persisted-published', fence, snapshot, originalProjectionCount: original,
      projectionReferenceCount: count, currentTurnComplete: snapshot.projectionTruncated !== true }
  }
  async load(scope: PublicationScope, checkpointId: string): Promise<TurnBootstrap> {
    const owner = Object.freeze({ ...scope }); await this.ready()
    return this.transaction('read', tx => this.loadAt(tx, owner, checkpointId))
  }
  async latest(scope: PublicationScope): Promise<TurnBootstrap> {
    const owner = Object.freeze({ ...scope }); await this.ready()
    return this.transaction('read', async tx => {
      const current = await capturePublishedFence(tx, owner)
      const row = (await tx.execute({ sql: 'SELECT checkpoint_id FROM parent_turn_bootstrap_heads WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND generation=?', args: [...ownerArgs(owner),current.generation] })).rows[0]
      if (!row) requireChildRecovery('bootstrap_unavailable')
      return this.loadAt(tx, owner, String(row.checkpoint_id))
    })
  }
  /** The persisted stream identity is indexed during producer capture. Neither a
   * current child view nor a resident process is permitted to supply this owner. */
  async latestForRun(scope: RunScope): Promise<TurnBootstrap> {
    const owner = Object.freeze({ ...scope }); await this.ready()
    return this.transaction('read', async tx => {
      const row = (await tx.execute({ sql: 'SELECT stream_id,generation,checkpoint_id FROM parent_turn_bootstrap_run_heads WHERE tenant_id=? AND parent_session_id=? AND root_run_id=? AND attempt_id=?',
        args: [owner.tenantId,owner.parentSessionId,owner.rootRunId,owner.attemptId] })).rows[0]
      if (!row) requireChildRecovery('bootstrap_unavailable')
      const checkpoint = await this.loadAt(tx, { ...owner,streamId: String(row.stream_id) }, String(row.checkpoint_id))
      if (checkpoint.fence.generation !== row.generation) requireChildRecovery('bootstrap_corrupt')
      return checkpoint
    })
  }
  /** Restore archived positions with exact admitted identities only. This does
   * not materialize child transcripts or discover newer children from a store. */
  async projectionSeed(scope: PublicationScope, checkpointId: string) {
    const owner = Object.freeze({ ...scope }); await this.ready()
    return this.transaction('read', async tx => {
      const checkpoint = await this.loadAt(tx, owner, checkpointId)
      const full = await readBootstrapBody(tx,checkpointId,JSON.stringify(checkpoint.snapshot),true)
      const projection = new Array<StreamSnapshot['projection'][number]>(checkpoint.originalProjectionCount)
      full.projection.forEach((frame,index) => { projection[full.projectionIndices[index]] = structuredClone(frame) })
      const watermarks = new Map<string,number>(); let after = -1
      for (;;) {
        const rows = (await tx.execute({ sql: 'SELECT entry_json FROM parent_turn_bootstrap_refs WHERE checkpoint_id=? AND projection_index>? ORDER BY projection_index LIMIT 128', args: [checkpointId,after] })).rows
        for (const row of rows) {
          const entry = JSON.parse(String(row.entry_json)) as ChildProjectionReference
          const child = await lookupPublishedChild(tx, checkpoint.fence, entry.runId)
          if (!child || child.atSeq !== entry.atSeq) requireChildRecovery('projection_prefix_mismatch')
          const reference = { schemaVersion: 2,view: 'published-reference',...child.identity,lastSeq: entry.sourceAtSeq ?? entry.atSeq }
          const frame = projection[entry.projectionIndex] ?? {}
          if (entry.field === 'subagentEvent') frame.subagentEvent = { schemaVersion: 2,kind: 'published-reference',runId: entry.runId,seq: reference.lastSeq,view: reference }
          else {
            const tool = frame[entry.field] as Record<string,unknown> | undefined
            if (!tool || entry.toolId && tool.toolCallId !== entry.toolId && tool.id !== entry.toolId) requireChildRecovery('bootstrap_corrupt')
            for (const location of entry.nestedLocations ?? (entry.nested ? [entry.nested] : [])) {
              if (location === 'subagent') tool.subagent = reference
              else { const container = location === 'meta.subagent' ? 'meta' : 'metadata'; tool[container] = { ...(tool[container] as Record<string,unknown> | undefined),subagent: reference } }
            }
          }
          projection[entry.projectionIndex] = frame
          watermarks.set(entry.runId,Math.max(watermarks.get(entry.runId) ?? 0,entry.atSeq)); after = entry.projectionIndex
        }
        if (rows.length < 128) break
      }
      for (let index = 0; index < projection.length; index++) if (!projection[index]) requireChildRecovery('bootstrap_corrupt')
      return { checkpointId,digest: checkpoint.fence.bootstrapDigest!,projection,
        watermarks: [...watermarks].map(([runId,seq]) => ({runId,seq})),projectionTruncated: full.projectionTruncated === true }
    })
  }
  async closeCheckpoint(scope: PublicationScope, checkpointId: string, error?: string): Promise<void> {
    const owner = Object.freeze({ ...scope }), now = this.now()
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid bootstrap clock')
    await this.ready()
    await this.transaction('write', async tx => {
      await this.loadAt(tx, owner, checkpointId)
      const summary = error === undefined ? null : Array.from(error).slice(0,256).join('')
      const prior = (await tx.execute({sql:'SELECT error_summary FROM parent_turn_bootstrap_closures WHERE checkpoint_id=?',args:[checkpointId]})).rows[0]
      if(prior && prior.error_summary!==summary)requireChildRecovery('bootstrap_closure_conflict')
      if(!prior)await tx.execute({sql:'INSERT INTO parent_turn_bootstrap_closures VALUES(?,?,?)',args:[checkpointId,now,summary]})
    })
  }
  async lifecycle(scope: PublicationScope, checkpointId: string): Promise<{ closed: boolean; error?: string }> {
    const owner = Object.freeze({ ...scope }); await this.ready()
    return this.transaction('read', async tx => {
      await this.loadAt(tx,owner,checkpointId)
      const row=(await tx.execute({sql:'SELECT error_summary FROM parent_turn_bootstrap_closures WHERE checkpoint_id=?',args:[checkpointId]})).rows[0]
      return {closed: Boolean(row),...(typeof row?.error_summary==='string'?{error:row.error_summary}:{})}
    })
  }
  async recovery(scope: PublicationScope, checkpointId: string, limit = 64) {
    const checkpoint = await this.load(scope, checkpointId)
    const leases = new PublishedRecoveryLeases(this.db, { now: this.now })
    const recovery = await leases.issueFixed(checkpoint.fence, limit)
    const result = { checkpoint, recovery }
    if (bytes(result) > PUBLISHED_CHILD_PAGE_BYTES) requireChildRecovery('response_budget')
    return result
  }
  /** A durable pin is released deliberately, never by closing a renderer. Signed
   * old selectors then fail; active leases cannot silently substitute latest. */
  async release(scope: PublicationScope, checkpointId: string): Promise<void> {
    const owner = Object.freeze({ ...scope }); await this.ready()
    await this.transaction('write', async tx => {
      await this.loadAt(tx, owner, checkpointId)
      // Activation is a durable deduplication fact, not a checkpoint pin. Removing
      // it here would let a second checkpoint reuse the accepted target attempt.
      for (const table of ['parent_turn_bootstrap_refs','parent_turn_bootstrap_heads','parent_turn_bootstrap_run_heads','parent_turn_bootstrap_closures','parent_turn_bootstrap_body_chunks'])
        await tx.execute({ sql: `DELETE FROM ${table} WHERE checkpoint_id=?`, args: [checkpointId] })
      await tx.execute({ sql: 'DELETE FROM parent_turn_bootstraps WHERE checkpoint_id=?', args: [checkpointId] })
    })
  }
  /** Approval continuation is a new stream owner. Exact admitted source versions,
   * initialization and the one-time handoff marker commit in one physical write. */
  async resume(checkpointId: string, predecessor: PublicationScope, target: PublicationScope): Promise<TurnBootstrap> {
    const from = Object.freeze({ ...predecessor }), to = Object.freeze({ ...target })
    for (const key of ['tenantId','parentSessionId','rootSessionId','parentTurnId','rootRunId'] as const)
      if (from[key] !== to[key]) requireChildRecovery('scope_mismatch')
    if (to.attemptId === from.attemptId || to.streamId === from.streamId) requireChildRecovery('bootstrap_attempt_not_new')
    const encodedScope = JSON.stringify(Object.fromEntries(scopeKeys.map(key => [key,to[key]])))
    await this.ready()
    return this.transaction('write', async tx => {
      const source = await this.loadAt(tx, from, checkpointId)
      await this.assertRootOwner(tx, to)
      const prior = (await tx.execute({ sql: 'SELECT * FROM parent_turn_bootstrap_handoffs WHERE checkpoint_id=?', args: [checkpointId] })).rows[0]
      if (prior) {
        if (prior.scope_json !== encodedScope || prior.target_stream_id !== to.streamId || prior.target_attempt_id !== to.attemptId ||
          prior.source_archive_digest !== source.fence.bootstrapDigest) requireChildRecovery('bootstrap_handoff_conflict')
        const targetFence = await capturePublishedFence(tx, to, 0)
        if (targetFence.revision !== source.fence.revision) requireChildRecovery('bootstrap_handoff_corrupt')
        const targetProof = await publishedVersionProof(tx, to, targetFence.revision)
        if (targetProof.count !== Number(prior.version_count) || targetProof.digest !== prior.version_digest) requireChildRecovery('bootstrap_handoff_corrupt')
        return source
      }
      const another = (await tx.execute({ sql: `SELECT 1 FROM parent_turn_bootstrap_handoffs WHERE target_attempt_id=?
        AND json_extract(scope_json,'$.tenantId')=? AND json_extract(scope_json,'$.parentSessionId')=? AND json_extract(scope_json,'$.rootRunId')=?`,
        args: [to.attemptId,to.tenantId,to.parentSessionId,to.rootRunId] })).rows[0]
      if (another) requireChildRecovery('bootstrap_handoff_conflict')
      const existing = (await tx.execute({ sql: 'SELECT 1 FROM parent_publication_state WHERE tenant_id=? AND parent_session_id=? AND stream_id=?', args: ownerArgs(to) })).rows[0]
      if (existing) requireChildRecovery('bootstrap_target_not_empty')
      await ensurePublicationOwner(tx, to)
      const base = barePublishedFence(source.fence)
      const sourceProof = await publishedVersionProof(tx, from, base.revision)
      // SQL performs the bounded-memory copy; rows after the sealed R are never
      // eligible. Historic sourceAtSeq proofs remain available to old tool slots.
      const rows = await tx.execute({ sql: `INSERT INTO parent_published_child_versions
        SELECT tenant_id,parent_session_id,?,run_id,first_ordinal,valid_from,
          CASE WHEN valid_to<=? THEN valid_to ELSE NULL END,at_seq,identity,tokens,unknown,finished_at
        FROM parent_published_child_versions WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND valid_from<=?`,
        args: [to.streamId,base.revision,...ownerArgs(from),base.revision] })
      await tx.execute({ sql: 'INSERT INTO parent_publication_marks VALUES(?,?,?,?,?,?,?)', args: [...ownerArgs(to),0,base.revision,'',0] })
      const changed = await tx.execute({ sql: 'UPDATE parent_publication_state SET revision=? WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND revision=0 AND event_sequence=0 AND generation=?',
        args: [base.revision,...ownerArgs(to),base.generation] })
      if (changed.rowsAffected !== 1) requireChildRecovery('bootstrap_handoff_race')
      const targetProof = await publishedVersionProof(tx, to, base.revision)
      if (rows.rowsAffected !== sourceProof.count || targetProof.count !== sourceProof.count || targetProof.digest !== sourceProof.digest) requireChildRecovery('bootstrap_handoff_corrupt')
      await tx.execute({ sql: 'INSERT INTO parent_turn_bootstrap_handoffs VALUES(?,?,?,?,?,?,?)', args: [checkpointId,to.streamId,to.attemptId,encodedScope,sourceProof.count,source.fence.bootstrapDigest!,sourceProof.digest] })
      await readLiveChildUsage(tx, await capturePublishedFence(tx, to, 0))
      return source
    })
  }
}

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import { ensureChildRecoverySchema } from './child-recovery-schema.js'
import { requireChildRecovery, recoveryVersion, type ChildUsageScalar } from './child-usage-authority.js'
import { assertPublishedFence, capturePublishedFence, lookupPublishedChild, readLiveChildUsage, readPublishedPage,
  PUBLISHED_CHILD_PAGE_BYTES, type PublicationScope, type PublishedChildRef, type PublishedFence } from './published-store.js'
import { CHILD_RECEIPT_LOCATIONS, type ChildReceiptLocation } from './child-receipt-shapes.js'
import { assertTurnBootstrapArchive, assertTurnBootstrapProof } from './turn-bootstrap-proof.js'
import { resolvePublishedProjectionReferences } from './child-recovery-projection.js'
import type { BootstrapBodyArchive } from './turn-bootstrap-body.js'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
const tenantArgs = (scope: { tenantId: string; parentSessionId: string }) => [scope.tenantId, scope.parentSessionId]
type Position = { firstOrdinal: number; runId: string }
interface Claims {
  v: 1; kind: 'snapshot' | 'children' | 'projection'; budget: 1; lease: string; digest: string
  expiresAt: number; keyId: string; after?: Position
}
interface Lease { id: string; digest: string; expiresAt: number; fence: PublishedFence }
export interface RecoveryReaderScope { tenantId: string; parentSessionId: string }
export interface PublishedRecoveryEnvelope {
  code: 200; message: 'OK'; timestamp: number
  data: { protocolVersion: 1; snapshotId: string; fence: PublishedFence; totalPublishedCount: number
    includedCount: number; residentComplete: boolean; hasMore: boolean; nextCursor: string | null
    refs: PublishedChildRef[]; usage: ChildUsageScalar & { source: 'authoritative-scalar'; revision: string } }
}
export interface RecoveryLeaseOptions {
  now?: () => number; ttlMs?: number; maxLeases?: number; maxParentLeases?: number
}
/** Exact parent projection position with a reference, never a copied child view. */
export interface ChildProjectionReference {
  projectionIndex: number; field: 'subagentEvent' | 'toolEnd' | 'toolResult'
  runId: string; atSeq: number; sourceAtSeq?: number; nested?: ChildReceiptLocation; nestedLocations?: ChildReceiptLocation[]; toolId?: string; toolName?: string
}

/** Token leases freeze R/U/E; they never make an unretained checkpoint become latest. */
export class PublishedRecoveryLeases {
  private readonly now: () => number
  private readonly ttl: number
  private readonly maxLeases: number
  private readonly maxParentLeases: number
  private readyPromise?: Promise<void>
  private key?: { id: string; bytes: Buffer }
  constructor(readonly db: Client, options: RecoveryLeaseOptions = {}) {
    this.now = options.now ?? Date.now
    this.ttl = options.ttlMs ?? 10 * 60_000
    this.maxLeases = options.maxLeases ?? 5000
    this.maxParentLeases = options.maxParentLeases ?? 100
    for (const value of [this.ttl, this.maxLeases, this.maxParentLeases])
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid recovery lease budget')
    if (this.ttl > 60 * 60_000 || this.maxLeases > 100_000 || this.maxParentLeases > this.maxLeases)
      throw new Error('Recovery lease budget is too large')
  }
  private clock(): number { const now = this.now(); if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid recovery clock'); return now }
  private async transaction<T>(mode: 'read' | 'write', action: (tx: Transaction) => Promise<T>): Promise<T> {
    const tx = await this.db.transaction(mode)
    try { const result = await action(tx); if (mode === 'write') await tx.commit(); else await tx.rollback(); return result }
    catch (error) { if (!tx.closed) await tx.rollback(); throw error }
    finally { tx.close() }
  }
  private ready(): Promise<void> {
    return this.readyPromise ??= (async () => {
      await ensureChildRecoverySchema(this.db)
      await this.db.executeMultiple(`
        CREATE TABLE IF NOT EXISTS child_recovery_token_key (singleton INTEGER PRIMARY KEY CHECK(singleton=1), key_id TEXT NOT NULL, key_bytes TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS child_recovery_leases (lease_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, parent_session_id TEXT NOT NULL,
          stream_id TEXT NOT NULL, generation TEXT NOT NULL, revision INTEGER NOT NULL, event_sequence INTEGER NOT NULL,
          usage_revision INTEGER NOT NULL, expires_at INTEGER NOT NULL, digest TEXT NOT NULL, fence TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS child_recovery_lease_expiry ON child_recovery_leases(expires_at);
        CREATE INDEX IF NOT EXISTS child_recovery_lease_parent ON child_recovery_leases(tenant_id,parent_session_id,expires_at);
        CREATE TABLE IF NOT EXISTS child_recovery_projection_refs (
          lease_id TEXT NOT NULL,projection_index INTEGER NOT NULL,run_id TEXT NOT NULL,at_seq INTEGER NOT NULL,entry_json TEXT NOT NULL,entry_digest TEXT NOT NULL,
          PRIMARY KEY(lease_id,projection_index),FOREIGN KEY(lease_id) REFERENCES child_recovery_leases(lease_id) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS child_recovery_projection_archives (
          lease_id TEXT PRIMARY KEY,total_count INTEGER NOT NULL,original_projection_count INTEGER NOT NULL,
          FOREIGN KEY(lease_id) REFERENCES child_recovery_leases(lease_id) ON DELETE CASCADE);
      `)
      await this.transaction('write', async tx => {
        await tx.execute({ sql: 'INSERT OR IGNORE INTO child_recovery_token_key VALUES(1,?,?)', args: [randomUUID(), randomBytes(32).toString('base64')] })
        const row = (await tx.execute('SELECT key_id,key_bytes FROM child_recovery_token_key WHERE singleton=1')).rows[0]
        if (!row || typeof row.key_id !== 'string' || typeof row.key_bytes !== 'string') requireChildRecovery('token_key_unavailable')
        const key = Buffer.from(row.key_bytes, 'base64')
        if (key.length !== 32 || key.toString('base64') !== row.key_bytes) requireChildRecovery('token_key_invalid')
        this.key = { id: row.key_id, bytes: key }
      })
    })().catch(error => { this.readyPromise = undefined; throw error })
  }
  private sign(lease: Lease, kind: Claims['kind'], after?: Position): string {
    const claims: Claims = { v: 1, kind, budget: 1, lease: lease.id, digest: lease.digest,
      expiresAt: lease.expiresAt, keyId: this.key!.id, ...(after ? { after } : {}) }
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    const signature = createHmac('sha256', this.key!.bytes).update(payload).digest('base64url')
    const token = payload + '.' + signature
    if (token.length > 8192) requireChildRecovery('oversized_identity')
    return token
  }
  private decode(token: string, kind: Claims['kind']): Claims {
    if (typeof token !== 'string' || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) requireChildRecovery('invalid_token')
    const [payload, signature] = token.split('.')
    const provided = Buffer.from(signature, 'base64url'), expected = createHmac('sha256', this.key!.bytes).update(payload).digest()
    if (provided.length !== expected.length || provided.toString('base64url') !== signature || !timingSafeEqual(provided, expected)) requireChildRecovery('invalid_token')
    let value: unknown
    try {
      const raw = Buffer.from(payload, 'base64url')
      if (raw.toString('base64url') !== payload) requireChildRecovery('invalid_token')
      value = JSON.parse(raw.toString('utf8'))
    } catch { requireChildRecovery('invalid_token') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) requireChildRecovery('invalid_token')
    const claims = value as Claims
    const fields = ['v', 'kind', 'budget', 'lease', 'digest', 'expiresAt', 'keyId', 'after']
    if (Object.keys(value).some(key => !fields.includes(key)) || claims.v !== 1 || claims.budget !== 1 || claims.kind !== kind ||
      claims.keyId !== this.key!.id || typeof claims.lease !== 'string' || claims.lease.length > 256 || !claims.lease ||
      typeof claims.digest !== 'string' || !/^[a-f0-9]{64}$/.test(claims.digest) || !Number.isSafeInteger(claims.expiresAt)) requireChildRecovery('invalid_token')
    if (kind === 'snapshot' && claims.after !== undefined || kind !== 'snapshot' && !claims.after) requireChildRecovery('invalid_selector')
    if (claims.after && (Object.keys(claims.after).some(key => !['firstOrdinal', 'runId'].includes(key)) ||
      !Number.isSafeInteger(claims.after.firstOrdinal) || claims.after.firstOrdinal < 1 || typeof claims.after.runId !== 'string' || !claims.after.runId)) requireChildRecovery('invalid_token')
    if (kind === 'projection' && claims.after?.runId !== 'projection') requireChildRecovery('invalid_selector')
    if (claims.expiresAt <= this.clock()) requireChildRecovery('snapshot_expired')
    return claims
  }
  private async lease(tx: Transaction, claims: Claims, auth: RecoveryReaderScope): Promise<Lease> {
    const row = (await tx.execute({ sql: 'SELECT * FROM child_recovery_leases WHERE lease_id=? AND tenant_id=? AND parent_session_id=?',
      args: [claims.lease, ...tenantArgs(auth)] })).rows[0]
    if (!row) requireChildRecovery('snapshot_unavailable')
    if (row.digest !== claims.digest || Number(row.expires_at) !== claims.expiresAt || Number(row.expires_at) <= this.clock()) requireChildRecovery('snapshot_unavailable')
    const encoded = String(row.fence)
    if (sha(encoded) !== claims.digest) requireChildRecovery('snapshot_corrupt')
    let fence: PublishedFence
    try { fence = JSON.parse(encoded) as PublishedFence } catch { requireChildRecovery('snapshot_corrupt') }
    if (fence.tenantId !== auth.tenantId || fence.parentSessionId !== auth.parentSessionId || fence.streamId !== row.stream_id || fence.generation !== row.generation ||
      fence.revision !== Number(row.revision) || fence.eventSequence !== Number(row.event_sequence) || fence.usageRevision !== Number(row.usage_revision)) requireChildRecovery('snapshot_corrupt')
    await assertPublishedFence(tx, fence)
    if (fence.recoveryMode !== undefined || fence.bootstrapId !== undefined || fence.bootstrapDigest !== undefined) {
      const proof = await assertTurnBootstrapProof(tx, fence)
      await assertTurnBootstrapArchive(tx, fence, proof)
    }
    return { id: claims.lease, digest: claims.digest, expiresAt: claims.expiresAt, fence }
  }
  private async envelope(tx: Transaction, lease: Lease, limit: number, after?: Position): Promise<PublishedRecoveryEnvelope> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) requireChildRecovery('invalid_limit')
    const page = await readPublishedPage(tx, lease.fence, { limit, after })
    const usage = await readLiveChildUsage(tx, lease.fence)
    const envelope: PublishedRecoveryEnvelope = { code: 200, message: 'OK', timestamp: this.clock(), data: { protocolVersion: 1,
      snapshotId: this.sign(lease, 'snapshot'), fence: lease.fence, totalPublishedCount: page.totalPublishedCount,
      includedCount: 0, residentComplete: false, hasMore: page.hasMore, nextCursor: null, refs: [],
      usage: { ...usage, source: 'authoritative-scalar', revision: sha(JSON.stringify(lease.fence)) } } }
    if (bytes(envelope) > PUBLISHED_CHILD_PAGE_BYTES) requireChildRecovery('oversized_identity')
    for (let index = 0; index < page.items.length; index++) {
      const item = page.items[index], hasMore = index + 1 < page.items.length || page.hasMore
      const cursor = hasMore ? this.sign(lease, 'children', { firstOrdinal: item.firstOrdinal, runId: item.identity.runId }) : null
      const candidate = { ...envelope, data: { ...envelope.data, refs: [...envelope.data.refs, item], includedCount: envelope.data.includedCount + 1,
        hasMore, nextCursor: cursor, residentComplete: !after && !hasMore } }
      if (bytes(candidate) > PUBLISHED_CHILD_PAGE_BYTES) {
        if (!envelope.data.refs.length) requireChildRecovery('oversized_identity')
        const prior = envelope.data.refs.at(-1)!
        envelope.data.hasMore = true; envelope.data.residentComplete = false
        envelope.data.nextCursor = this.sign(lease, 'children', { firstOrdinal: prior.firstOrdinal, runId: prior.identity.runId })
        break
      }
      envelope.data = candidate.data
    }
    if (!page.items.length) envelope.data.residentComplete = !after && !page.hasMore
    if (bytes(envelope) > PUBLISHED_CHILD_PAGE_BYTES) requireChildRecovery('oversized_identity')
    return envelope
  }
  private async releaseInvalidLeases(tx: Transaction, now: number): Promise<void> {
    // Clear/reset may remove a stream before its token expires. Those tokens cannot
    // read any prefix and must not reserve quota or retain unrelated generations.
    await tx.execute({ sql: `DELETE FROM child_recovery_leases
      WHERE expires_at<=? OR NOT EXISTS (
        SELECT 1 FROM subagent_usage_parent_state u WHERE u.tenant_id=child_recovery_leases.tenant_id
          AND u.parent_session_id=child_recovery_leases.parent_session_id AND u.generation=child_recovery_leases.generation
      ) OR NOT EXISTS (
        SELECT 1 FROM parent_publication_state p WHERE p.tenant_id=child_recovery_leases.tenant_id
          AND p.parent_session_id=child_recovery_leases.parent_session_id AND p.stream_id=child_recovery_leases.stream_id
          AND p.generation=child_recovery_leases.generation
      ) OR (json_extract(fence,'$.bootstrapId') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM parent_turn_bootstraps b WHERE b.checkpoint_id=json_extract(child_recovery_leases.fence,'$.bootstrapId')
          AND b.digest=json_extract(child_recovery_leases.fence,'$.bootstrapDigest')
      ))`, args: [now] })
  }
  /** Only the trusted parent publisher supplies the complete scope, never a cursor query. */
  async issue(scope: PublicationScope, limit = 64, atEventSequence?: number): Promise<PublishedRecoveryEnvelope> {
    await this.ready()
    const committed = await this.transaction('write', async tx => {
      const now = this.clock()
      await this.releaseInvalidLeases(tx, now)
      const counts = (await tx.execute({ sql: 'SELECT count(*) AS total,sum(CASE WHEN tenant_id=? AND parent_session_id=? THEN 1 ELSE 0 END) AS parent FROM child_recovery_leases', args: tenantArgs(scope) })).rows[0]
      if (Number(counts.total) >= this.maxLeases || Number(counts.parent) >= this.maxParentLeases) requireChildRecovery('lease_capacity')
      const fence = await capturePublishedFence(tx, scope, atEventSequence), encoded = JSON.stringify(fence)
      const expiresAt = now + this.ttl
      if (!Number.isSafeInteger(expiresAt)) requireChildRecovery('invalid_expiry')
      const lease: Lease = { id: randomUUID(), digest: sha(encoded), expiresAt, fence }
      const result = await this.envelope(tx, lease, limit)
      if (lease.expiresAt <= this.clock()) requireChildRecovery('snapshot_expired')
      await tx.execute({ sql: 'INSERT INTO child_recovery_leases VALUES(?,?,?,?,?,?,?,?,?,?,?)', args: [lease.id, fence.tenantId, fence.parentSessionId,
        fence.streamId, fence.generation, fence.revision, fence.eventSequence, fence.usageRevision, lease.expiresAt, lease.digest, encoded] })
      return { result, expiresAt: lease.expiresAt }
    })
    // Commit/ACK can itself be delayed. This is freshness at service return,
    // not a guarantee that a later network consumer receives an unexpired token.
    if (committed.expiresAt <= this.clock()) requireChildRecovery('snapshot_expired')
    return committed.result
  }
  /** Re-sign the persisted exact checkpoint, including its old U. The ordinary
   * issue path intentionally captures current U and cannot substitute for this. */
  async issueFixed(input: PublishedFence, limit = 64): Promise<PublishedRecoveryEnvelope> {
    const fence = structuredClone(input)
    await this.ready()
    const committed = await this.transaction('write', async tx => {
      const now = this.clock()
      await this.releaseInvalidLeases(tx, now)
      await assertPublishedFence(tx, fence)
      const bootstrap = await assertTurnBootstrapProof(tx, fence)
      await assertTurnBootstrapArchive(tx, fence, bootstrap)
      const counts = (await tx.execute({ sql: 'SELECT count(*) AS total,sum(CASE WHEN tenant_id=? AND parent_session_id=? THEN 1 ELSE 0 END) AS parent FROM child_recovery_leases', args: tenantArgs(fence) })).rows[0]
      if (Number(counts.total) >= this.maxLeases || Number(counts.parent) >= this.maxParentLeases) requireChildRecovery('lease_capacity')
      const encoded = JSON.stringify(fence), expiresAt = now + this.ttl
      if (!Number.isSafeInteger(expiresAt)) requireChildRecovery('invalid_expiry')
      const lease: Lease = { id: randomUUID(), digest: sha(encoded), expiresAt, fence }
      const result = await this.envelope(tx, lease, limit)
      if (lease.expiresAt <= this.clock()) requireChildRecovery('snapshot_expired')
      await tx.execute({ sql: 'INSERT INTO child_recovery_leases VALUES(?,?,?,?,?,?,?,?,?,?,?)', args: [lease.id,fence.tenantId,fence.parentSessionId,
        fence.streamId,fence.generation,fence.revision,fence.eventSequence,fence.usageRevision,expiresAt,lease.digest,encoded] })
      const copied = await tx.execute({ sql: `INSERT INTO child_recovery_projection_refs
        SELECT ?,projection_index,run_id,at_seq,entry_json,entry_digest FROM parent_turn_bootstrap_refs WHERE checkpoint_id=?`, args: [lease.id,fence.bootstrapId!] })
      if (copied.rowsAffected !== Number(bootstrap.refs_count)) requireChildRecovery('bootstrap_corrupt')
      await tx.execute({ sql: 'INSERT INTO child_recovery_projection_archives VALUES(?,?,?)', args: [lease.id,Number(bootstrap.refs_count),Number(bootstrap.original_count)] })
      return { result, expiresAt }
    })
    if (committed.expiresAt <= this.clock()) requireChildRecovery('snapshot_expired')
    return committed.result
  }
  async read(auth: RecoveryReaderScope, snapshotId: string, cursor: string | null = null, limit = 64): Promise<PublishedRecoveryEnvelope> {
    await this.ready()
    const snapshot = this.decode(snapshotId, 'snapshot'), next = cursor === null ? null : this.decode(cursor, 'children')
    if (next && (next.lease !== snapshot.lease || next.digest !== snapshot.digest || next.expiresAt !== snapshot.expiresAt)) requireChildRecovery('cursor_snapshot_mismatch')
    const result = await this.transaction('read', async tx => this.envelope(tx, await this.lease(tx, snapshot, auth), limit, next?.after))
    if (snapshot.expiresAt <= this.clock()) requireChildRecovery('snapshot_expired')
    return result
  }
  async lookup(auth: RecoveryReaderScope, snapshotId: string, runId: string): Promise<{ snapshotId: string; fence: PublishedFence; item: PublishedChildRef | null }> {
    await this.ready()
    const claims = this.decode(snapshotId, 'snapshot')
    const result = await this.transaction('read', async tx => {
      const lease = await this.lease(tx, claims, auth), item = await lookupPublishedChild(tx, lease.fence, runId)
      const response = { snapshotId, fence: lease.fence, item }
      if (bytes(response) > PUBLISHED_CHILD_PAGE_BYTES) requireChildRecovery('oversized_identity')
      return response
    })
    if (claims.expiresAt <= this.clock()) requireChildRecovery('snapshot_expired')
    return result
  }
  /** The trusted captured bus supplies these slots. SQL verifies every exact R/seq
   * before committing; an unavailable prefix never becomes a latest reference. */
  async retainProjection(auth: RecoveryReaderScope, snapshotId: string, input: ChildProjectionReference[], originalProjectionCount: number,
    options?: { childSequenceSource: 'published-store' }): Promise<void> {
    let entries = structuredClone(input)
    const resolvePublished = options?.childSequenceSource === 'published-store'
    await this.ready(); const claims = this.decode(snapshotId, 'snapshot')
    if (entries.length > 4096 || !Number.isSafeInteger(originalProjectionCount) || originalProjectionCount < 0 || originalProjectionCount > 16384) requireChildRecovery('projection_budget')
    await this.transaction('write', async tx => {
      const lease = await this.lease(tx, claims, auth)
      const previous = (await tx.execute({ sql: 'SELECT lease_id FROM child_recovery_projection_archives WHERE lease_id=?', args: [lease.id] })).rows[0]
      if (previous) requireChildRecovery('projection_already_retained')
      if (resolvePublished) entries = await resolvePublishedProjectionReferences(tx, lease.fence, entries)
      for (const entry of entries) {
        const locations = entry.nestedLocations ?? (entry.nested ? [entry.nested] : [])
        if (!Number.isSafeInteger(entry.projectionIndex) || entry.projectionIndex < 0 || entry.projectionIndex >= originalProjectionCount ||
          !['subagentEvent', 'toolEnd', 'toolResult'].includes(entry.field) || typeof entry.runId !== 'string' || !entry.runId || recoveryVersion(entry.atSeq) < 1 || bytes(entry) > PUBLISHED_CHILD_PAGE_BYTES ||
          (entry.field === 'subagentEvent' ? locations.length !== 0 : locations.length < 1 || locations.length > 3 || new Set(locations).size !== locations.length || locations.some(location => !CHILD_RECEIPT_LOCATIONS.includes(location))) ||
          entry.nestedLocations !== undefined && entry.nested !== undefined || entry.sourceAtSeq !== undefined && (!Number.isSafeInteger(entry.sourceAtSeq) || entry.sourceAtSeq < 1 || entry.sourceAtSeq > entry.atSeq)) requireChildRecovery('oversized_identity')
        if (entry.sourceAtSeq !== undefined && entry.sourceAtSeq !== entry.atSeq) {
          const source = (await tx.execute({ sql: `SELECT 1 FROM parent_published_child_versions p WHERE p.tenant_id=? AND p.parent_session_id=? AND p.stream_id=? AND p.run_id=? AND p.at_seq=? AND p.valid_from<=?`, args: [auth.tenantId, auth.parentSessionId, lease.fence.streamId, entry.runId, entry.sourceAtSeq, lease.fence.revision] })).rows[0]
          const checkpoint = (await tx.execute({ sql: `SELECT 1 FROM subagent_checkpoints WHERE tenant_id=? AND run_id=? AND seq=? UNION ALL SELECT 1 FROM subagent_events WHERE tenant_id=? AND run_id=? AND seq=? AND json_extract(event,'$.schemaVersion')=1 LIMIT 1`, args: [auth.tenantId, entry.runId, entry.sourceAtSeq, auth.tenantId, entry.runId, entry.sourceAtSeq] })).rows[0]
          if (!source || !checkpoint) requireChildRecovery('projection_prefix_mismatch')
        }
        const encoded = JSON.stringify(entry)
        await tx.execute({ sql: 'INSERT INTO child_recovery_projection_refs VALUES(?,?,?,?,?,?)', args: [lease.id, entry.projectionIndex, entry.runId, entry.atSeq, encoded, sha(encoded)] })
      }
      const invalid = (await tx.execute({ sql: `SELECT count(*) AS n FROM child_recovery_projection_refs a WHERE a.lease_id=? AND NOT EXISTS(
        SELECT 1 FROM parent_published_child_versions p WHERE p.tenant_id=? AND p.parent_session_id=? AND p.stream_id=? AND p.run_id=a.run_id AND p.at_seq=a.at_seq
          AND p.valid_from<=? AND (p.valid_to IS NULL OR p.valid_to>?))`, args: [lease.id, auth.tenantId, auth.parentSessionId, lease.fence.streamId, lease.fence.revision, lease.fence.revision] })).rows[0]
      if (Number(invalid.n)) requireChildRecovery('projection_prefix_mismatch')
      // The header commits last in this same transaction, including empty
      // archives. A token alone never proves that projection retention finished.
      await tx.execute({ sql: 'INSERT INTO child_recovery_projection_archives VALUES(?,?,?)', args: [lease.id, entries.length, originalProjectionCount] })
    })
    if (claims.expiresAt <= this.clock()) requireChildRecovery('snapshot_expired')
  }
  async projection(auth: RecoveryReaderScope, snapshotId: string, cursor: string | null = null, limit = 64) {
    await this.ready(); const snapshot = this.decode(snapshotId, 'snapshot'), next = cursor === null ? null : this.decode(cursor, 'projection')
    if (next && (next.lease !== snapshot.lease || next.digest !== snapshot.digest || next.expiresAt !== snapshot.expiresAt)) requireChildRecovery('cursor_snapshot_mismatch')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) requireChildRecovery('invalid_limit')
    const result = await this.transaction('read', async tx => {
      const lease = await this.lease(tx, snapshot, auth)
      // The immutable child ledger checks all checkpoint retention, not only the selected page.
      await readLiveChildUsage(tx, lease.fence)
      const after = next ? next.after!.firstOrdinal - 1 : -1
      const header = (await tx.execute({ sql: 'SELECT total_count,original_projection_count FROM child_recovery_projection_archives WHERE lease_id=?', args: [lease.id] })).rows[0]
      if (!header) requireChildRecovery('projection_unavailable')
      const originalCount = Number(header.original_projection_count), retainedCount = Number(header.total_count)
      if (!Number.isSafeInteger(originalCount) || originalCount < 0 || originalCount > 16384 || !Number.isSafeInteger(retainedCount) || retainedCount < 0 || retainedCount > 4096 || retainedCount > originalCount) requireChildRecovery('projection_corrupt')
      const count = Number((await tx.execute({ sql: 'SELECT count(*) AS n FROM child_recovery_projection_refs WHERE lease_id=?', args: [lease.id] })).rows[0].n)
      if (count !== retainedCount) requireChildRecovery('projection_corrupt')
      const rows = (await tx.execute({ sql: 'SELECT projection_index,run_id,at_seq,entry_json,entry_digest FROM child_recovery_projection_refs WHERE lease_id=? AND projection_index>? ORDER BY projection_index LIMIT ?', args: [lease.id, after, limit + 1] })).rows
      const response = { code: 200 as const, message: 'OK', timestamp: this.clock(), data: { protocolVersion: 1 as const, snapshotId, fence: lease.fence,
        totalCount: count, originalProjectionCount: originalCount, entries: [] as ChildProjectionReference[], hasMore: false, nextCursor: null as string | null } }
      for (let index = 0; index < rows.length; index++) {
        if (index === limit) { response.data.hasMore = true; break }
        const row = rows[index], encoded = String(row.entry_json)
        if (sha(encoded) !== row.entry_digest) requireChildRecovery('projection_corrupt')
        const entry = JSON.parse(encoded) as ChildProjectionReference
        if (entry.projectionIndex !== Number(row.projection_index) || entry.runId !== row.run_id || entry.atSeq !== Number(row.at_seq) ||
          entry.projectionIndex < 0 || entry.projectionIndex >= response.data.originalProjectionCount) requireChildRecovery('projection_corrupt')
        const candidate = { ...response, data: { ...response.data, entries: [...response.data.entries, entry], hasMore: index + 1 < rows.length,
          nextCursor: index + 1 < rows.length ? this.sign(lease, 'projection', { firstOrdinal: entry.projectionIndex + 1, runId: 'projection' }) : null } }
        if (bytes(candidate) > PUBLISHED_CHILD_PAGE_BYTES) { if (!response.data.entries.length) requireChildRecovery('oversized_identity'); response.data.hasMore = true; break }
        response.data = candidate.data
      }
      if (!response.data.hasMore) response.data.nextCursor = null
      if (bytes(response) > PUBLISHED_CHILD_PAGE_BYTES) requireChildRecovery('oversized_identity')
      return response
    })
    if (snapshot.expiresAt <= this.clock()) requireChildRecovery('snapshot_expired')
    return result
  }
  /** Ordinary body pages use the same fixed signed checkpoint. The part index
   * selects an immutable row; it never names another stream or a latest body. */
  async body(auth: RecoveryReaderScope, snapshotId: string, part = 0) {
    if (!Number.isSafeInteger(part) || part < 0 || part > 1024) requireChildRecovery('invalid_selector')
    await this.ready(); const claims=this.decode(snapshotId,'snapshot')
    const result=await this.transaction('read',async tx=>{
      const lease=await this.lease(tx,claims,auth),proof=await assertTurnBootstrapProof(tx,lease.fence)
      const snapshot=JSON.parse(String(proof.snapshot_json)) as {bodyArchive?:BootstrapBodyArchive}
      const archive=snapshot.bodyArchive
      if(!archive)requireChildRecovery('bootstrap_body_unavailable')
      if(part>=archive.chunkCount)requireChildRecovery('invalid_selector')
      const row=(await tx.execute({sql:'SELECT chunk,digest FROM parent_turn_bootstrap_body_chunks WHERE checkpoint_id=? AND part_index=?',args:[lease.fence.bootstrapId!,part]})).rows[0]
      if(!row||sha(String(row.chunk))!==row.digest)requireChildRecovery('bootstrap_body_corrupt')
      return {code:200 as const,message:'OK',timestamp:this.clock(),data:{protocolVersion:1 as const,snapshotId,fence:lease.fence,archive,
        part,chunk:String(row.chunk),chunkDigest:String(row.digest),nextPart:part+1<archive.chunkCount?part+1:null}}
    })
    if(claims.expiresAt<=this.clock())requireChildRecovery('snapshot_expired')
    if(bytes(result)>PUBLISHED_CHILD_PAGE_BYTES)requireChildRecovery('response_budget')
    return result
  }
  /** Atomically refuse to advance floors past any live lease; checkpoint GC is a separate owner. */
  async prune(scope: PublicationScope, requested: { revision: number; eventSequence: number; usageRevision: number }): Promise<typeof requested> {
    for (const value of Object.values(requested)) recoveryVersion(value)
    await this.ready()
    return this.transaction('write', async tx => {
      await this.releaseInvalidLeases(tx, this.clock())
      const current = await capturePublishedFence(tx, scope)
      if (requested.revision > current.revision || requested.eventSequence > current.eventSequence || requested.usageRevision > current.usageRevision) requireChildRecovery('invalid_retention_floor')
      const pinScope = [...tenantArgs(scope),scope.streamId,current.generation], usageScope = [...tenantArgs(scope),current.generation]
      const retained = (await tx.execute({ sql: `SELECT min(revision) AS revision,min(event_sequence) AS event_sequence FROM (
        SELECT revision,event_sequence FROM child_recovery_leases WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND generation=?
        UNION ALL SELECT revision,event_sequence FROM parent_turn_bootstraps WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND generation=?
        UNION ALL SELECT p.valid_from,b.event_sequence FROM parent_turn_bootstrap_refs a JOIN parent_turn_bootstraps b ON b.checkpoint_id=a.checkpoint_id
          JOIN parent_published_child_versions p ON p.tenant_id=b.tenant_id AND p.parent_session_id=b.parent_session_id AND p.stream_id=b.stream_id
            AND p.run_id=a.run_id AND p.at_seq=json_extract(a.entry_json,'$.sourceAtSeq') AND p.valid_from<=b.revision
          WHERE b.tenant_id=? AND b.parent_session_id=? AND b.stream_id=? AND b.generation=?)`, args: [...pinScope,...pinScope,...pinScope] })).rows[0]
      const usage = (await tx.execute({ sql: `SELECT min(usage_revision) AS revision FROM (
        SELECT usage_revision FROM child_recovery_leases WHERE tenant_id=? AND parent_session_id=? AND generation=?
        UNION ALL SELECT usage_revision FROM parent_turn_bootstraps WHERE tenant_id=? AND parent_session_id=? AND generation=?)`, args: [...usageScope,...usageScope] })).rows[0]
      const floor = { revision: Math.min(requested.revision, retained.revision === null ? requested.revision : Number(retained.revision)),
        eventSequence: Math.min(requested.eventSequence, retained.event_sequence === null ? requested.eventSequence : Number(retained.event_sequence)),
        usageRevision: Math.min(requested.usageRevision, usage.revision === null ? requested.usageRevision : Number(usage.revision)) }
      await tx.execute({ sql: 'UPDATE parent_publication_state SET floor_revision=max(floor_revision,?),floor_event_sequence=max(floor_event_sequence,?) WHERE tenant_id=? AND parent_session_id=? AND stream_id=?', args: [floor.revision, floor.eventSequence, ...tenantArgs(scope), scope.streamId] })
      await tx.execute({ sql: 'UPDATE subagent_usage_parent_state SET floor_revision=max(floor_revision,?) WHERE tenant_id=? AND parent_session_id=?', args: [floor.usageRevision, ...tenantArgs(scope)] })
      await tx.execute({ sql: 'DELETE FROM parent_published_child_versions WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND valid_to<=?', args: [...tenantArgs(scope), scope.streamId, floor.revision] })
      await tx.execute({ sql: 'DELETE FROM subagent_usage_contributions WHERE tenant_id=? AND parent_session_id=? AND valid_to<=?', args: [...tenantArgs(scope), floor.usageRevision] })
      // Keep the last mark at/before the floor so exact E/R pairs remain reconstructible.
      await tx.execute({ sql: 'DELETE FROM parent_publication_marks WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND event_sequence < (SELECT max(event_sequence) FROM parent_publication_marks WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND event_sequence<=?)', args: [...tenantArgs(scope), scope.streamId, ...tenantArgs(scope), scope.streamId, floor.eventSequence] })
      const actual = (await tx.execute({ sql: 'SELECT floor_revision,floor_event_sequence FROM parent_publication_state WHERE tenant_id=? AND parent_session_id=? AND stream_id=?', args: [...tenantArgs(scope), scope.streamId] })).rows[0]
      const actualUsage = (await tx.execute({ sql: 'SELECT floor_revision FROM subagent_usage_parent_state WHERE tenant_id=? AND parent_session_id=?', args: tenantArgs(scope) })).rows[0]
      return { revision: Number(actual.floor_revision), eventSequence: Number(actual.floor_event_sequence), usageRevision: Number(actualUsage.floor_revision) }
    })
  }
}

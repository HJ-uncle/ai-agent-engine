import type { Client } from '@libsql/client'
import { randomBytes } from 'node:crypto'

const prepared = new WeakMap<Client, Promise<void>>()
/** Preparation has no recovery side effects. Only the explicit startup owner recovers. */
export function ensureCollaborationSchema(db: Client): Promise<void> {
  let pending = prepared.get(db)
  if (!pending) {
    pending = (async () => {
      await db.execute(`CREATE TABLE IF NOT EXISTS collaboration_roots (
        tenant_id TEXT NOT NULL, root_run_id TEXT NOT NULL, root_attempt_id TEXT NOT NULL,
        root_session_id TEXT NOT NULL, turn_id TEXT NOT NULL, generation TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('open','draining','closed','interrupted')),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(tenant_id,root_run_id,root_attempt_id))`)
      await db.execute(`CREATE TABLE IF NOT EXISTS collaboration_participants (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
        root_run_id TEXT NOT NULL, root_attempt_id TEXT NOT NULL,
        participant_id TEXT NOT NULL, parent_participant_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('root','child')), session_id TEXT NOT NULL,
        invocation_run_id TEXT NOT NULL, admitted_at INTEGER NOT NULL,
        UNIQUE(tenant_id,root_run_id,root_attempt_id,participant_id),
        UNIQUE(tenant_id,invocation_run_id))`)
      await db.execute(`CREATE INDEX IF NOT EXISTS collaboration_participants_root
        ON collaboration_participants(tenant_id,root_run_id,root_attempt_id,seq)`)
      await db.execute(`CREATE TABLE IF NOT EXISTS collaboration_invocations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
        root_run_id TEXT NOT NULL, root_attempt_id TEXT NOT NULL,
        participant_id TEXT NOT NULL, invocation_run_id TEXT NOT NULL, admitted_at INTEGER NOT NULL,
        UNIQUE(tenant_id,invocation_run_id))`)
      const columns = await db.execute('PRAGMA table_info(collaboration_invocations)')
      if (!columns.rows.some(row => row.name === 'admission_fingerprint'))
        await db.execute('ALTER TABLE collaboration_invocations ADD COLUMN admission_fingerprint TEXT')
      await db.execute(`CREATE TABLE IF NOT EXISTS collaboration_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
        root_run_id TEXT NOT NULL, root_attempt_id TEXT NOT NULL, message_id TEXT NOT NULL,
        sender_participant_id TEXT NOT NULL, sender_invocation_run_id TEXT NOT NULL,
        recipient_participant_id TEXT NOT NULL, request_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL, payload_bytes INTEGER NOT NULL, body TEXT NOT NULL,
        accepted_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','rejected','interrupted')),
        reason TEXT,
        UNIQUE(tenant_id,root_run_id,root_attempt_id,message_id),
        UNIQUE(tenant_id,root_run_id,root_attempt_id,sender_participant_id,sender_invocation_run_id,request_key))`)
      await db.execute(`CREATE INDEX IF NOT EXISTS collaboration_messages_recipient
        ON collaboration_messages(tenant_id,root_run_id,root_attempt_id,recipient_participant_id,seq)`)
      await db.execute(`CREATE TABLE IF NOT EXISTS collaboration_metadata (
        key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
      await db.execute({ sql: "INSERT OR IGNORE INTO collaboration_metadata(key,value) VALUES ('cursor-signing-key',?)", args: [randomBytes(32).toString('hex')] })
    })().catch(error => { prepared.delete(db); throw error })
    prepared.set(db, pending)
  }
  return pending
}

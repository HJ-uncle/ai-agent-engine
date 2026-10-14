import type { Client } from '@libsql/client'

/** Claims fence late completion and stopped-before-start cleanup to one producer.
 * They are not leases and must never be used to infer that another owner died. */
export async function ensureTaskClaimSchema(db: Client): Promise<void> {
  await db.execute(`CREATE TABLE IF NOT EXISTS job_execution_claims (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    claim_id TEXT NOT NULL UNIQUE
  )`)
}

import type { Client } from '@libsql/client'

export async function up(client: Client): Promise<void> {
  const statements = [
    `ALTER TABLE conversations ADD COLUMN token_usage TEXT`
  ]
  try {
    await client.batch(statements.map((sql) => ({ sql })), 'write')
  } catch (err: any) {
    console.warn('Migration 005: Failed to add token_usage. Error:', err.message)
  }
}

export async function down(client: Client): Promise<void> {
  const statements = [
    `ALTER TABLE conversations DROP COLUMN token_usage`
  ]
  try {
    await client.batch(statements.map((sql) => ({ sql })), 'write')
  } catch (err: any) {
    console.warn('Migration 005 down: Failed. Error:', err.message)
  }
}
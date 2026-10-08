#!/usr/bin/env node

/**
 * Provision the first local default tenant administrator without exposing the
 * API key in process output. This is intentionally offline: it does not start
 * the HTTP server and it never updates an existing user.
 *
 * Usage:
 *   node scripts/provision-default-admin.mjs --out <0600-file> [--data <db>]
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { createClient } from '@libsql/client'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const outputPath = argument('--out')
const databasePath = argument('--data') ?? process.env.DATA_DIR ?? './data/agent.db'
if (!outputPath || outputPath.startsWith('--')) {
  console.error('Usage: node scripts/provision-default-admin.mjs --out <0600-file> [--data <db>]')
  process.exit(2)
}

const output = path.resolve(outputPath)
if (existsSync(output)) {
  console.error(`Refusing to replace existing key file: ${output}`)
  process.exit(2)
}

const db = createClient({ url: `file:${path.resolve(databasePath)}` })
let keyFileWritten = false
try {
  const existing = await db.execute({
    sql: 'SELECT id FROM users WHERE tenant_id = ?',
    args: ['default'],
  })
  if (existing.rows.length > 0) {
    console.error('The default tenant already has an administrator; no key was changed.')
    process.exitCode = 3
  } else {
    const apiKey = randomBytes(32).toString('base64url')
    const hash = createHash('sha256').update(apiKey).digest('hex')
    mkdirSync(path.dirname(output), { recursive: true })
    // Write first so a successful DB insert always has a recoverable key.
    writeFileSync(output, `${apiKey}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    chmodSync(output, 0o600)
    keyFileWritten = true
    const id = randomBytes(16).toString('hex')
    await db.execute({
      sql: `INSERT INTO users (id, tenant_id, api_key_hash, external_id, created_at)
            VALUES (?, ?, ?, ?, unixepoch())`,
      args: [id, 'default', hash, 'default'],
    })
    console.log(`Created default administrator key file: ${output}`)
  }
} catch (error) {
  if (keyFileWritten) {
    try { unlinkSync(output) } catch { /* preserve the original failure */ }
  }
  console.error(error instanceof Error ? error.message : 'Provisioning failed')
  process.exitCode = 1
} finally {
  db.close()
}

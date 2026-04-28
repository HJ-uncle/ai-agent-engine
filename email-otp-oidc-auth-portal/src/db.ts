import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { env } from './config.js'

export type Client = {
  id: string
  name: string
  redirectUris: string[]
  scopes: string[]
  enabled: boolean
}

export type AuthCode = {
  code: string
  clientId: string
  redirectUri: string
  userId: string
  email: string
  scope: string
  codeChallenge: string
  codeChallengeMethod: 'S256'
  nonce?: string
  createdAt: number
  usedAt?: number
}

export type SessionRecord = {
  id: string
  data: unknown
  expiresAt: number
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

export function openDb() {
  ensureDir(env.DATA_DIR)
  const dbPath = path.join(env.DATA_DIR, 'app.sqlite')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      redirect_uris TEXT NOT NULL,
      scopes TEXT NOT NULL,
      enabled INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_codes (
      code TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      scope TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      code_challenge_method TEXT NOT NULL,
      nonce TEXT,
      created_at INTEGER NOT NULL,
      used_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `)

  return db
}

export function getClientById(db: Database.Database, clientId: string): Client | null {
  const row = db
    .prepare('SELECT id, name, redirect_uris, scopes, enabled FROM clients WHERE id = ?')
    .get(clientId) as
    | { id: string; name: string; redirect_uris: string; scopes: string; enabled: number }
    | undefined

  if (!row) return null

  return {
    id: row.id,
    name: row.name,
    redirectUris: JSON.parse(row.redirect_uris) as string[],
    scopes: JSON.parse(row.scopes) as string[],
    enabled: row.enabled === 1
  }
}

export function listClients(db: Database.Database): Client[] {
  const rows = db
    .prepare('SELECT id, name, redirect_uris, scopes, enabled FROM clients ORDER BY id')
    .all() as Array<{ id: string; name: string; redirect_uris: string; scopes: string; enabled: number }>

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    redirectUris: JSON.parse(r.redirect_uris) as string[],
    scopes: JSON.parse(r.scopes) as string[],
    enabled: r.enabled === 1
  }))
}

export function upsertClient(db: Database.Database, client: Client) {
  db.prepare(
    `INSERT INTO clients (id, name, redirect_uris, scopes, enabled)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      redirect_uris = excluded.redirect_uris,
      scopes = excluded.scopes,
      enabled = excluded.enabled`
  ).run(client.id, client.name, JSON.stringify(client.redirectUris), JSON.stringify(client.scopes), client.enabled ? 1 : 0)
}

export function disableClient(db: Database.Database, clientId: string) {
  db.prepare('UPDATE clients SET enabled = 0 WHERE id = ?').run(clientId)
}

export function insertAuthCode(db: Database.Database, code: AuthCode) {
  db.prepare(
    `INSERT INTO auth_codes (
      code, client_id, redirect_uri, user_id, email, scope,
      code_challenge, code_challenge_method, nonce, created_at, used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    code.code,
    code.clientId,
    code.redirectUri,
    code.userId,
    code.email,
    code.scope,
    code.codeChallenge,
    code.codeChallengeMethod,
    code.nonce ?? null,
    code.createdAt,
    code.usedAt ?? null
  )
}

export function getAuthCode(db: Database.Database, code: string): AuthCode | null {
  const row = db
    .prepare(
      `SELECT code, client_id, redirect_uri, user_id, email, scope,
              code_challenge, code_challenge_method, nonce, created_at, used_at
       FROM auth_codes WHERE code = ?`
    )
    .get(code) as
    | {
        code: string
        client_id: string
        redirect_uri: string
        user_id: string
        email: string
        scope: string
        code_challenge: string
        code_challenge_method: string
        nonce: string | null
        created_at: number
        used_at: number | null
      }
    | undefined

  if (!row) return null

  return {
    code: row.code,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    userId: row.user_id,
    email: row.email,
    scope: row.scope,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method as 'S256',
    nonce: row.nonce ?? undefined,
    createdAt: row.created_at,
    usedAt: row.used_at ?? undefined
  }
}

export function markAuthCodeUsed(db: Database.Database, code: string, usedAt: number) {
  db.prepare('UPDATE auth_codes SET used_at = ? WHERE code = ? AND used_at IS NULL').run(usedAt, code)
}

export function pruneExpiredAuthCodes(db: Database.Database, nowMs: number, ttlSeconds: number) {
  const minCreatedAt = nowMs - ttlSeconds * 1000
  db.prepare('DELETE FROM auth_codes WHERE created_at < ?').run(minCreatedAt)
}

export function getSession(db: Database.Database, id: string): SessionRecord | null {
  const row = db.prepare('SELECT id, data, expires_at FROM sessions WHERE id = ?').get(id) as
    | { id: string; data: string; expires_at: number }
    | undefined

  if (!row) return null

  return { id: row.id, data: JSON.parse(row.data), expiresAt: row.expires_at }
}

export function upsertSession(db: Database.Database, session: SessionRecord) {
  db.prepare(
    `INSERT INTO sessions (id, data, expires_at)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
      data = excluded.data,
      expires_at = excluded.expires_at`
  ).run(session.id, JSON.stringify(session.data), session.expiresAt)
}

export function deleteSession(db: Database.Database, id: string) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
}

export function pruneExpiredSessions(db: Database.Database, nowMs: number) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowMs)
}


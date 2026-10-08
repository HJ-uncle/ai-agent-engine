// Real WebSocket handshake/account DB/revocation; PTY side effects are observable mocks, not skipped.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import WebSocket from 'ws'
import { SignJWT } from 'jose'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AccountLoginResult } from '../accounts.js'

const terminals = vi.hoisted(() => ({
  sessions: new Map<string, { tenantId: string; userId?: string; events: EventEmitter }>(),
  calls: [] as string[],
}))
vi.mock('../../terminal/index.js', () => ({ terminalManager: {
  get: (id: string) => terminals.sessions.get(id),
  write: (id: string, data: string) => { terminals.calls.push(`input:${id}:${data}`); return true },
  resize: (id: string, cols: number, rows: number) => { terminals.calls.push(`resize:${id}:${cols}:${rows}`); return true },
  kill: (id: string) => { terminals.calls.push(`kill:${id}`) },
} }))

const fixture = path.resolve('.e2e-tmp', `account-terminal-${randomUUID()}`)
const instanceToken = 'account-terminal-instance-token'
let app: FastifyInstance, baseUrl = ''
let accounts: typeof import('../accounts.js'), database: typeof import('../../storage/sqlite/db.js')
const sockets = new Set<WebSocket>()
const socketHeaders = (accessToken: string) => ({ 'X-Aether-Instance-Token': instanceToken, Authorization: `Bearer ${accessToken}` })
beforeAll(async () => {
  fs.mkdirSync(fixture, { recursive: true })
  vi.stubEnv('DATA_DIR', path.join(fixture, 'accounts.db')); vi.stubEnv('AUTH_ENABLED', 'true')
  vi.stubEnv('AETHER_INSTANCE_TOKEN', instanceToken); vi.stubEnv('JWT_SECRET', 'terminal-jwt-fixture-secret')
  vi.stubEnv('AETHER_ACCOUNT_PROVIDERS_JSON', '[]')
  database = await import('../../storage/sqlite/db.js'); await database.initDb()
  accounts = await import('../accounts.js')
  const { configureRequestAuthentication, authMiddlewareHook } = await import('../../api/http/middleware.js')
  configureRequestAuthentication()
  app = Fastify({ logger: false }); app.addHook('onRequest', authMiddlewareHook)
  await app.register(websocket)
  const { terminalRoutes } = await import('../../api/http/routes/terminal.js')
  await app.register(terminalRoutes)
  baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
})
afterEach(async () => {
  await Promise.all([...sockets].map(async ws => {
    if (ws.readyState === WebSocket.CLOSED) return
    const closed = once(ws, 'close'); ws.terminate(); await closed
  }))
  sockets.clear(); terminals.sessions.clear(); terminals.calls.length = 0
  vi.restoreAllMocks()
})
afterAll(async () => {
  await app?.close(); database?.closeDb(); vi.unstubAllEnvs()
  if (!fixture.startsWith(path.resolve('.e2e-tmp') + path.sep)) throw new Error('Unsafe test fixture path')
  try { fs.rmSync(fixture, { recursive: true, force: true }) }
  catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || !['EPERM', 'EBUSY'].includes(String(error.code))) throw error }
})
async function connect(account?: AccountLoginResult, headers?: Record<string, string>) {
  const login = account ?? await accounts.registerAccount(), id = randomUUID(), events = new EventEmitter()
  terminals.sessions.set(id, { tenantId: login.user.tenantId, userId: login.user.id, events })
  const ws = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/terminal/ws/${id}`, { headers: headers ?? socketHeaders(login.accessToken) })
  sockets.add(ws); ws.on('error', () => {})
  await once(ws, 'open')
  return { account: login, id, events, ws }
}
async function revoke(account: AccountLoginResult): Promise<void> {
  const auth = await accounts.authenticateAccountSession(account.accessToken)
  await accounts.revokeAccountSession(auth, auth.sessionId)
}
describe('account-session terminal WebSocket revocation', () => {
  it('preserves input/resize/kill order while asynchronously checking each command', async () => {
    const { id, ws } = await connect()
    const check = vi.spyOn(accounts, 'revalidateAccountAuth')
    const closed = once(ws, 'close')
    ws.send(JSON.stringify({ type: 'input', data: 'first' }))
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }))
    ws.send(JSON.stringify({ type: 'input', data: 'second' }))
    ws.send(JSON.stringify({ type: 'kill' }))
    expect((await closed)[0]).toBe(1000)
    expect(terminals.calls).toEqual([`input:${id}:first`, `resize:${id}:100:30`, `input:${id}:second`, `kill:${id}`])
    expect(check).toHaveBeenCalledTimes(4)
  })
  it.each(['input', 'resize', 'kill'])('rejects %s after another client revokes the authenticated session', async type => {
    const { account, ws, events } = await connect()
    await revoke(account)
    const closed = once(ws, 'close')
    ws.send(JSON.stringify({ type, data: 'must-not-run', cols: 90, rows: 24 }))
    expect((await closed)[0]).toBe(1008)
    expect(terminals.calls).toEqual([])
    await expect.poll(() => events.listenerCount('data')).toBe(0)
    expect(events.listenerCount('exit')).toBe(0)
  })
  it('keeps a valid connection after normal refresh rotates tokens for the same account session', async () => {
    const { account, ws, id } = await connect()
    const refreshed = await accounts.refreshAccountSession(account.refreshToken, randomUUID())
    expect(refreshed.user.sessionId).toBe(account.user.sessionId)
    expect(refreshed.accessToken).not.toBe(account.accessToken)
    await expect(accounts.authenticateAccountSession(account.accessToken)).rejects.toThrow()
    ws.send(JSON.stringify({ type: 'input', data: 'after-refresh' }))
    await expect.poll(() => terminals.calls).toEqual([`input:${id}:after-refresh`])
    expect(ws.readyState).toBe(WebSocket.OPEN)
    await revoke(refreshed)
    const closed = once(ws, 'close'); ws.send(JSON.stringify({ type: 'kill' }))
    expect((await closed)[0]).toBe(1008)
    expect(terminals.calls).toEqual([`input:${id}:after-refresh`])
  })
  it('periodically closes revoked idle connections and clears the validation timer/listeners', async () => {
    const clear = vi.spyOn(globalThis, 'clearInterval')
    const { account, ws, events } = await connect()
    await revoke(account)
    const closed = once(ws, 'close')
    expect((await closed)[0]).toBe(1008)
    await expect.poll(() => events.listenerCount('data')).toBe(0)
    expect(clear).toHaveBeenCalled()
    expect(terminals.calls).toEqual([])
  }, 10_000)
  it.each(['messages', 'bytes'])('bounds pending %s while validation is delayed without executing queued work', async kind => {
    const { account, ws } = await connect()
    let release!: () => void
    const deferred = new Promise<void>(resolve => { release = resolve })
    const original = accounts.revalidateAccountAuth
    const check = vi.spyOn(accounts, 'revalidateAccountAuth').mockImplementationOnce(async auth => { await deferred; return original(auth) })
    const closed = once(ws, 'close')
    ws.send(JSON.stringify({ type: 'input', data: 'blocked-first' }))
    await expect.poll(() => check.mock.calls.length).toBe(1)
    const data = kind === 'messages' ? 'queued' : '汉'.repeat(60_000)
    try {
      for (let i = 0; i < (kind === 'messages' ? 65 : 8); i++) ws.send(JSON.stringify({ type: 'input', data }))
      expect((await closed)[0]).toBe(1013)
      expect(terminals.calls).toEqual([])
    } finally { release() }
    await original(await accounts.authenticateAccountSession(account.accessToken))
    expect(terminals.calls).toEqual([])
  })
  it('preserves legacy JWT and API-key terminal contracts without applying account-session checks', async () => {
    const account = await accounts.registerAccount()
    const jwt = await new SignJWT({ tenantId: account.user.tenantId }).setProtectedHeader({ alg: 'HS256' }).setSubject(account.user.id)
      .setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode('terminal-jwt-fixture-secret'))
    const apiKey = 'terminal-fixture-legacy-api-key'
    await database.getDb().execute({ sql: 'UPDATE users SET api_key_hash=? WHERE id=?', args: [createHash('sha256').update(apiKey).digest('hex'), account.user.id] })
    const check = vi.spyOn(accounts, 'revalidateAccountAuth')
    for (const headers of [socketHeaders(jwt), { 'X-Aether-Instance-Token': instanceToken, 'X-API-Key': apiKey }]) {
      const { ws, id } = await connect(account, headers)
      ws.send(JSON.stringify({ type: 'input', data: 'legacy-input' }))
      await expect.poll(() => terminals.calls.includes(`input:${id}:legacy-input`)).toBe(true)
    }
    expect(check).not.toHaveBeenCalled()
  })
})

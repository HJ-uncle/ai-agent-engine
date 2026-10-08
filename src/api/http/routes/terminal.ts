/**
 * 终端路由：
 *   POST /terminal/create   — 创建 PTY，返回 terminalId
 *   GET  /terminal/ws/:id   — WebSocket 双向转发 PTY ↔ xterm
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { randomUUID } from 'node:crypto'
import { workspaceManager } from '../../../workspace/index.js'
import { terminalManager } from '../../../terminal/index.js'
import type {} from '@fastify/websocket'
import type { AuthContext } from '../../../auth/types.js'
import { revalidateAccountAuth } from '../../../auth/accounts.js'
import { success, fail } from '../response.js'

// ── Helpers ──────────────────────────────────────────────────────────────────
const authContext = (req: FastifyRequest) => (req as FastifyRequest & { authContext?: AuthContext }).authContext
const getTenantId = (req: FastifyRequest) => authContext(req)?.tenantId ?? 'default'
const getUserId = (req: FastifyRequest) => authContext(req)?.userId
const validId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
const socketCounts = new Map<string, number>()

function owns(session: { tenantId: string; userId?: string }, req: FastifyRequest): boolean {
  const tenantId = getTenantId(req)
  const userId = getUserId(req)
  const authMethod = authContext(req)?.method
  if (session.tenantId !== tenantId) return false
  // In authenticated deployments a terminal must have an owner identity;
  // tenant membership alone is insufficient for read/write/delete access.
  if (authMethod === 'none') return !session.userId || !userId || session.userId === userId
  return Boolean(session.userId && userId && session.userId === userId)
}

export async function terminalRoutes(fastify: FastifyInstance) {
  // ── POST /terminal/create ────────────────────────────────────────────────
  fastify.post<{
    Body: { sessionId: string; cwd?: string; cols?: number; rows?: number }
  }>('/terminal/create', {
    schema: {
      body: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string', minLength: 1 },
          cwd: { type: 'string' },
          cols: { type: 'number', default: 120 },
          rows: { type: 'number', default: 30 },
        },
      },
    },
  }, async (request, reply) => {
    const tenantId = getTenantId(request)
    const userId = getUserId(request)
    const { sessionId, cwd: cwdOverride, cols = 120, rows = 30 } = request.body
    if (!validId(sessionId)) return reply.code(400).send(fail(40001, 'Invalid sessionId'))

    // 默认 cwd 为 workspace 根目录；允许调用方传入子目录（相对路径）
    let workspaceRoot: string
    try { workspaceRoot = workspaceManager.getPath({ tenantId, sessionId }) }
    catch (error) { return reply.code(400).send(fail(40001, error instanceof Error ? error.message : 'Invalid workspace')) }
    let cwd = workspaceRoot
    if (cwdOverride) {
      try {
        cwd = workspaceManager.resolveSafePath({ tenantId, sessionId }, cwdOverride)
      } catch (error) { return reply.code(400).send(fail(40001, error instanceof Error ? error.message : 'Invalid cwd')) }
    }

    // 最终保险：确保 cwd 存在，否则回退到用户主目录
    const { existsSync } = await import('node:fs')
    if (!existsSync(cwd)) {
      return reply.code(400).send(fail(40001, 'Terminal working directory does not exist'))
    }

    // 获取所有绑定的工作空间路径（多工作空间支持）
    const allWorkspacePaths = workspaceManager.getPaths({ tenantId, sessionId })

    const id = randomUUID()
    try {
      console.log(`[Terminal] Creating terminal ${id} in ${cwd}`)
      const session = terminalManager.create(id, cwd, cols, rows, allWorkspacePaths, { tenantId, userId })

      return reply.code(200).send(success({ terminalId: id, cwd }))
    } catch (e: any) {
      console.error('[Terminal] Failed to create terminal:', e)
      const errorMsg = e.message || String(e)
      return reply.code(200).send(fail(50000, `Failed to create terminal: ${errorMsg}`))
    }
  })

  // ── GET /terminal/ws/:id ─────────────────────────────────────────────────
  // @fastify/websocket v11: handler(socket, request)
  // socket 直接就是 ws.WebSocket 实例
  fastify.get<{ Params: { id: string } }>(
    '/terminal/ws/:id',
    { websocket: true },
    (socket, req) => {
      const ws = socket  // v11: 第一个参数直接是 WebSocket 对象
      const { id } = req.params as { id: string }
      const session = terminalManager.get(id)

      if (!session) {
        ws.send(JSON.stringify({ type: 'error', message: `Terminal ${id} not found` }))
        ws.close()
        return
      }
      if (!owns(session, req)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Terminal not found' }))
        ws.close(1008)
        return
      }
      const count = socketCounts.get(id) ?? 0
      if (count >= 4) {
        ws.send(JSON.stringify({ type: 'error', message: 'Too many terminal connections' }))
        ws.close(1013)
        return
      }
      socketCounts.set(id, count + 1)
      const account = authContext(req)
      let stopped = false
      const close = (code: number): void => { stopped = true; ws.close(code) }
      const checkAccount = async (): Promise<boolean> => {
        if (stopped || ws.readyState !== 1) return false
        if (account?.method === 'session') {
          try { await revalidateAccountAuth(account) }
          catch { close(1008); return false }
        }
        return !stopped && ws.readyState === 1
      }

      // A handshake does not grant an irrevocable terminal session. Idle/output-only
      // sockets must also lose access, without mistaking rotated access tokens for logout.
      let checking = false
      const authTimer = account?.method === 'session' ? setInterval(() => {
        if (checking || stopped) return
        checking = true
        void checkAccount().finally(() => { checking = false })
      }, 5_000) : undefined
      authTimer?.unref()

      // PTY → WebSocket
      const onData = (data: string) => {
        if (!stopped && ws.readyState === 1 /* OPEN */ && ws.bufferedAmount < 4 * 1024 * 1024) {
          ws.send(JSON.stringify({ type: 'output', data }))
        } else if (ws.readyState === 1) {
          close(1013)
        }
      }
      const onExit = (code: number) => {
        if (!stopped && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'exit', code }))
          close(1000)
        }
      }
      session.events.on('data', onData)
      session.events.once('exit', onExit)

      // Keep async authorization ordered with terminal input; otherwise a delayed
      // earlier check can execute a write after a later kill/revocation check.
      type Command = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number } | { type: 'kill' }
      const pending: Array<{ command: Command; bytes: number }> = []
      let pendingBytes = 0
      let draining = false
      const drain = async (): Promise<void> => {
        if (draining) return
        draining = true
        try {
          while (pending.length && !stopped) {
            const next = pending[0]
            if (!await checkAccount()) break
            pending.shift(); pendingBytes -= next.bytes
            const msg = next.command
            if (msg.type === 'input') {
              if (!terminalManager.write(id, msg.data)) close(1009)
            } else if (msg.type === 'resize') {
              if (!terminalManager.resize(id, msg.cols, msg.rows)) close(1008)
            } else { terminalManager.kill(id); close(1000) }
          }
        } catch { close(1011) }
        finally {
          draining = false
          if (stopped) { pending.length = 0; pendingBytes = 0 }
        }
      }
      // Bound work waiting behind database validation as well as each individual frame.
      ws.on('message', raw => {
        if (stopped) return
        const bytes = Array.isArray(raw) ? raw.reduce((sum, part) => sum + part.byteLength, 0) : raw.byteLength
        if (bytes > 256 * 1024) { close(1009); return }
        try {
          const payload = Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? Buffer.from(raw) : raw
          const parsed: unknown = JSON.parse(payload.toString())
          if (!parsed || typeof parsed !== 'object') return
          const msg = parsed as Record<string, unknown>
          let command: Command
          if (msg.type === 'input' && typeof msg.data === 'string') command = { type: 'input', data: msg.data }
          else if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') command = { type: 'resize', cols: msg.cols, rows: msg.rows }
          else if (msg.type === 'kill') command = { type: 'kill' }
          else return
          if (pending.length >= 64 || pendingBytes + bytes > 1024 * 1024) { close(1013); return }
          pending.push({ command, bytes }); pendingBytes += bytes
          void drain()
        } catch { /* ignore invalid JSON */ }
      })

      // 清理
      ws.on('close', () => {
        stopped = true
        if (authTimer) clearInterval(authTimer)
        pending.length = 0; pendingBytes = 0
        const remaining = (socketCounts.get(id) ?? 1) - 1
        if (remaining > 0) socketCounts.set(id, remaining); else socketCounts.delete(id)
        session.events.off('data', onData)
        session.events.off('exit', onExit)
      })
    },
  )

  // ── DELETE /terminal/:id — 手动关闭终端 ──────────────────────────────────
  fastify.delete<{ Params: { id: string } }>('/terminal/:id', async (request, reply) => {
    const { id } = request.params
    const session = terminalManager.get(id)
    if (!session || !owns(session, request)) return reply.code(404).send(fail(40400, 'Terminal not found'))
    terminalManager.kill(id)
    return reply.code(200).send(success({ success: true }))
  })
}

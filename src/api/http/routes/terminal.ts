/**
 * 终端路由：
 *   POST /terminal/create   — 创建 PTY，返回 terminalId
 *   GET  /terminal/ws/:id   — WebSocket 双向转发 PTY ↔ xterm
 */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { workspaceManager } from '../../../workspace/index.js'
import { terminalManager } from '../../../terminal/index.js'
import { success, fail } from '../response.js'

export async function terminalRoutes(fastify: FastifyInstance) {
  // ── POST /terminal/create ────────────────────────────────────────────────
  fastify.post<{
    Body: { sessionId: string; cwd?: string; cols?: number; rows?: number }
  }>('/terminal/create', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const { sessionId, cwd: cwdOverride, cols = 120, rows = 30 } = request.body

    if (!sessionId) return reply.code(200).send(fail(40001, 'sessionId is required'))

    // 默认 cwd 为 workspace 根目录；允许调用方传入子目录（相对路径）
    const workspaceRoot = workspaceManager.getPath({ tenantId, sessionId })
    let cwd = workspaceRoot
    if (cwdOverride) {
      try {
        cwd = workspaceManager.resolveSafePath({ tenantId, sessionId }, cwdOverride)
      } catch {
        // 不安全路径回退到 workspace 根目录
      }
    }

    // 最终保险：确保 cwd 存在，否则回退到用户主目录
    const { existsSync } = await import('node:fs')
    const os = await import('node:os')
    if (!existsSync(cwd)) {
      cwd = os.homedir()
    }

    // 获取所有绑定的工作空间路径（多工作空间支持）
    const allWorkspacePaths = workspaceManager.getPaths({ tenantId, sessionId })

    const id = randomUUID()
    try {
      console.log(`[Terminal] Creating terminal ${id} in ${cwd}`)
      const session = terminalManager.create(id, cwd, cols, rows, allWorkspacePaths)

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
    { websocket: true } as any,
    (socket: any, req: any) => {
      const ws = socket  // v11: 第一个参数直接是 WebSocket 对象
      const { id } = req.params as { id: string }
      const session = terminalManager.get(id)

      if (!session) {
        ws.send(JSON.stringify({ type: 'error', message: `Terminal ${id} not found` }))
        ws.close()
        return
      }

      // PTY → WebSocket
      const onData = (data: string) => {
        if (ws.readyState === 1 /* OPEN */) {
          ws.send(JSON.stringify({ type: 'output', data }))
        }
      }
      const onExit = (code: number) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'exit', code }))
          ws.close()
        }
      }
      session.events.on('data', onData)
      session.events.once('exit', onExit)

      // WebSocket → PTY
      ws.on('message', (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString())
          if (msg.type === 'input') {
            terminalManager.write(id, msg.data)
          } else if (msg.type === 'resize') {
            terminalManager.resize(id, msg.cols, msg.rows)
          } else if (msg.type === 'kill') {
            terminalManager.kill(id)
            ws.close()
          }
        } catch { /* ignore invalid JSON */ }
      })

      // 清理
      ws.on('close', () => {
        session.events.off('data', onData)
        session.events.off('exit', onExit)
      })
    },
  )

  // ── DELETE /terminal/:id — 手动关闭终端 ──────────────────────────────────
  fastify.delete<{ Params: { id: string } }>('/terminal/:id', async (request, reply) => {
    const { id } = request.params
    terminalManager.kill(id)
    return reply.code(200).send(success({ success: true }))
  })
}

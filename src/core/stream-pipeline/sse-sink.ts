import type { FastifyReply } from 'fastify'
import type { SseEventPayload } from './stream-bus.js'

/**
 * 默认心跳间隔（毫秒）。
 * - 1Panel 的 OpenResty 默认 proxy_read_timeout = 60s，保守取 15s 发一次。
 * - 若客户端使用原生 EventSource，这也是它"看起来还活着"的最低保障。
 */
const HEARTBEAT_INTERVAL_MS = 15000

export async function sseStream(
  source: AsyncIterable<SseEventPayload | string>,
  reply: FastifyReply,
): Promise<void> {
  console.log('--- sseStream started ---')
  reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  reply.raw.setHeader('Cache-Control', 'no-cache')
  reply.raw.setHeader('Connection', 'keep-alive')
  reply.raw.setHeader('X-Accel-Buffering', 'no')

  // 告诉 Nginx/反代 这条连接上允许长时间无业务数据；
  // 真实的 keep-alive 还是依赖下面的 heartbeat 定时器。
  reply.raw.setTimeout(0)

  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatStopped = false
  let clientGone = false

  const scheduleHeartbeat = () => {
    if (heartbeatStopped || clientGone) return
    heartbeatTimer = setTimeout(() => {
      if (heartbeatStopped || clientGone) return
      try {
        // SSE 注释帧：以 `:` 开头的行会被浏览器忽略，不触发 onmessage；
        // 但会让 TCP/Nginx/反代 认为连接上仍有字节流动，从而不掐断。
        const ok = reply.raw.write(`: ping ${Date.now()}\n\n`)
        if (!ok) {
          // 写缓冲区已满，等 drain 再继续发心跳（不需要 resolve，只是"尽力而为"）
          reply.raw.once('drain', () => {})
        }
      } catch {
        // 写入失败（例如 socket 已经关闭），不再排程
        return
      }
      scheduleHeartbeat()
    }, HEARTBEAT_INTERVAL_MS)
  }

  const stopHeartbeat = () => {
    heartbeatStopped = true
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  const onClientError = () => {
    clientGone = true
    stopHeartbeat()
  }

  reply.raw.once('error', onClientError)
  reply.raw.once('close', onClientError)

  // 在写任何业务数据之前先排好心跳；避免 "LLM 还在第一句生成的 30s 空窗 + Nginx 60s" 临界时被断。
  scheduleHeartbeat()

  try {
    for await (const item of source) {
      if (clientGone) break
      const chunk = typeof item === 'string' ? item : item.chunk
      const idStr = typeof item === 'string' || !item.id ? '' : `id: ${item.id}\n`

      console.log('--- sseStream chunk ---', chunk.slice(0, 50))

      const writeData = async (data: string): Promise<void> => {
        if (clientGone) return
        const result = reply.raw.write(data)
        if (!result) {
          await new Promise<void>((resolve) => {
            const onDrain = () => {
              reply.raw.off('error', onErr)
              resolve()
            }
            const onErr = () => {
              clientGone = true
              reply.raw.off('drain', onDrain)
              resolve()
            }
            reply.raw.once('drain', onDrain)
            reply.raw.once('error', onErr)
          })
        }
      }

      // ── __usage__ frame ──────────────────────────────────────────────────
      if (chunk.startsWith('\x00__usage__')) {
        try {
          const usage = JSON.parse(chunk.slice('\x00__usage__'.length))
          await writeData(`${idStr}data: ${JSON.stringify({ usage })}\n\n`)
        } catch (e) {
          console.error('Failed to parse __usage__ frame:', e, chunk)
        }
        continue
      }
      // ── __thinking__ frame (AI 思考文字，调用工具前) ─────────────────────
      if (chunk.startsWith('\x00__thinking__')) {
        const text = chunk.slice('\x00__thinking__'.length)
        await writeData(`${idStr}data: ${JSON.stringify({ thinking: text })}\n\n`)
        continue
      }
      // ── __tool_start__ frame ─────────────────────────────────────────────
      if (chunk.startsWith('\x00__tool_start__')) {
        try {
          const tool = JSON.parse(chunk.slice('\x00__tool_start__'.length))
          await writeData(`${idStr}data: ${JSON.stringify({ toolStart: tool })}\n\n`)
        } catch (e) {
          console.error('Failed to parse __tool_start__ frame:', e, chunk);
        }
        continue
      }
      // ── __tool_args__ frame ─────────────────────────────────────────────
      if (chunk.startsWith('\x00__tool_args__')) {
        try {
          const jsonStr = chunk.slice('\x00__tool_args__'.length)
          const tool = JSON.parse(jsonStr)
          await writeData(`${idStr}data: ${JSON.stringify({ toolArgs: tool })}\n\n`)
        } catch (e) {
          console.error('Failed to parse __tool_args__ frame:', e, chunk);
        }
        continue
      }
      // ── __tool_end__ frame ───────────────────────────────────────────────
      if (chunk.startsWith('\x00__tool_end__')) {
        try {
          const tool = JSON.parse(chunk.slice('\x00__tool_end__'.length))
          await writeData(`${idStr}data: ${JSON.stringify({ toolEnd: tool })}\n\n`)
        } catch (e) {
          console.error('Failed to parse __tool_end__ frame:', e, chunk);
        }
        continue
      }
      // ── __ask_user__ frame ─────────────────────────────────────────────
      if (chunk.startsWith('\x00__ask_user__')) {
        try {
          const data = JSON.parse(chunk.slice('\x00__ask_user__'.length))
          await writeData(`${idStr}data: ${JSON.stringify({ ask_user: data })}\n\n`)
        } catch (e) {
          console.error('Failed to parse __ask_user__ frame:', e, chunk)
        }
        continue
      }
      // ── __user_msg_id__ frame ──────────────────────────────────────────
      if (chunk.startsWith('\x00__user_msg_id__')) {
        const id = chunk.slice('\x00__user_msg_id__'.length)
        await writeData(`${idStr}data: ${JSON.stringify({ userMsgId: id })}\n\n`)
        continue
      }
      // ── 新版协议别名帧 ────────────────────────────────────────────────
      if (chunk.startsWith('\x00__userMsgId__')) {
        const id = chunk.slice('\x00__userMsgId__'.length)
        await writeData(`${idStr}data: ${JSON.stringify({ userMsgId: id })}\n\n`)
        continue
      }
      if (chunk.startsWith('\x00__tool_call__')) {
        try {
          const tool = JSON.parse(chunk.slice('\x00__tool_call__'.length))
          await writeData(`${idStr}data: ${JSON.stringify({ toolCall: tool })}\n\n`)
        } catch (e) {
          console.error('Failed to parse __tool_call__ frame:', e, chunk)
        }
        continue
      }
      if (chunk.startsWith('\x00__tool_result__')) {
        try {
          const tool = JSON.parse(chunk.slice('\x00__tool_result__'.length))
          await writeData(`${idStr}data: ${JSON.stringify({ toolResult: tool })}\n\n`)
        } catch (e) {
          console.error('Failed to parse __tool_result__ frame:', e, chunk)
        }
        continue
      }
      if (chunk.startsWith('\x00__permission_request__')) {
        try {
          const data = JSON.parse(chunk.slice('\x00__permission_request__'.length))
          await writeData(`${idStr}data: ${JSON.stringify({ permissionRequest: data })}\n\n`)
        } catch (e) {
          console.error('Failed to parse __permission_request__ frame:', e, chunk)
        }
        continue
      }
      if (chunk.startsWith('\x00__message_block__')) {
        try {
          const data = JSON.parse(chunk.slice('\x00__message_block__'.length))
          await writeData(`${idStr}data: ${JSON.stringify({ messageBlock: data })}\n\n`)
        } catch (e) {
          console.error('Failed to parse __message_block__ frame:', e, chunk)
        }
        continue
      }
      // ── __flow__ frame ────────────────────────────────────────────────
      if (chunk.startsWith('\x00__flow__')) {
        try {
          const data = JSON.parse(chunk.slice('\x00__flow__'.length))
          await writeData(`${idStr}data: ${JSON.stringify({ flow: data })}\n\n`)
        } catch (e) {
          console.error('Failed to parse __flow__ frame:', e, chunk)
        }
        continue
      }
      // ── __todo__ frame（会话待办清单，客户端任务托盘）──────────────────
      if (chunk.startsWith('\x00__todo__')) {
        try {
          const data = JSON.parse(chunk.slice('\x00__todo__'.length))
          await writeData(`${idStr}data: ${JSON.stringify({ todo: data })}\n\n`)
        } catch (e) {
          console.error('Failed to parse __todo__ frame:', e, chunk)
        }
        continue
      }
      // ── __file_change__ frame（文件改动记录，diff 视图 + 改动确认面板）──
      if (chunk.startsWith('\x00__file_change__')) {
        try {
          const data = JSON.parse(chunk.slice('\x00__file_change__'.length))
          await writeData(`${idStr}data: ${JSON.stringify({ fileChange: data })}\n\n`)
        } catch (e) {
          console.error('Failed to parse __file_change__ frame:', e, chunk)
        }
        continue
      }
      // ── 普通内容 ─────────────────────────────────────────────────────────
      if (chunk.includes('\x00')) {
        console.warn('Unhandled control frame in sseStream:', chunk);
        continue;
      }
      await writeData(`${idStr}data: ${JSON.stringify({ content: chunk })}\n\n`)
    }
    // Send done event
    if (!clientGone) {
      try { reply.raw.write('event: done\ndata: [DONE]\n\n') } catch { /* noop */ }
    }
  } finally {
    stopHeartbeat()
    reply.raw.off('error', onClientError)
    reply.raw.off('close', onClientError)
    try { reply.raw.end() } catch { /* noop */ }
  }
}

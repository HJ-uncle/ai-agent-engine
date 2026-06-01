import type { FastifyReply } from 'fastify'
import type { SseEventPayload } from './stream-bus.js'

export async function sseStream(
  source: AsyncIterable<SseEventPayload | string>,
  reply: FastifyReply,
): Promise<void> {
  console.log('--- sseStream started ---')
  reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  reply.raw.setHeader('Cache-Control', 'no-cache')
  reply.raw.setHeader('Connection', 'keep-alive')
  reply.raw.setHeader('X-Accel-Buffering', 'no')

  try {
    for await (const item of source) {
      const chunk = typeof item === 'string' ? item : item.chunk
      const idStr = typeof item === 'string' || !item.id ? '' : `id: ${item.id}\n`
      
      console.log('--- sseStream chunk ---', chunk.slice(0, 50))

      const writeData = (data: string) => {
        const result = reply.raw.write(data)
        if (!result) {
          return new Promise<void>((resolve) => reply.raw.once('drain', resolve))
        }
        return Promise.resolve()
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
      // 通知前端：用户消息已落库，携带后端 message_id，前端凭此 ID 做删除/重发
      if (chunk.startsWith('\x00__user_msg_id__')) {
        const id = chunk.slice('\x00__user_msg_id__'.length)
        await writeData(`${idStr}data: ${JSON.stringify({ userMsgId: id })}\n\n`)
        continue
      }
      // ── 新版协议别名帧（不破坏旧消费者，仅供 第三方项目 等下游使用） ──
      //
      // 命名规范：__userMsgId__ / __tool_call__ / __tool_result__ / __permission_request__
      // JSON envelope 字段：userMsgId / toolCall / toolResult / permissionRequest
      // 与上方 __user_msg_id__ / __tool_start__ / __tool_end__ / __ask_user__ 共存。
      if (chunk.startsWith('\x00__userMsgId__')) {
        // alias of __user_msg_id__；envelope 字段相同（userMsgId）
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
      // TODO: __message_block__ 消费端已就绪，生产者（react.ts 等）尚未 yield 该帧
      //       待上游实现后即可启用，当前为前向兼容预留。
      if (chunk.startsWith('\x00__message_block__')) {
        try {
          const data = JSON.parse(chunk.slice('\x00__message_block__'.length))
          await writeData(`${idStr}data: ${JSON.stringify({ messageBlock: data })}\n\n`)
        } catch (e) {
          console.error('Failed to parse __message_block__ frame:', e, chunk)
        }
        continue
      }
      // ── 普通内容 ─────────────────────────────────────────────────────────
      if (chunk.includes('\x00')) {
        // 兜底逻辑：任何包含 \x00 的帧如果走到这里，说明没被上面的处理器识别或处理失败。
        // 我们绝不能将其作为普通内容发送，否则会污染正文。
        console.warn('Unhandled control frame in sseStream:', chunk);
        continue;
      }
      await writeData(`${idStr}data: ${JSON.stringify({ content: chunk })}\n\n`)
    }
    // Send done event
    reply.raw.write('event: done\ndata: [DONE]\n\n')
  } finally {
    reply.raw.end()
  }
}

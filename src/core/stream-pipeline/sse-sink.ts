import type { FastifyReply } from 'fastify'

export async function sseStream(
  source: AsyncIterable<string>,
  reply: FastifyReply,
): Promise<void> {
  console.log('--- sseStream started ---')
  reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  reply.raw.setHeader('Cache-Control', 'no-cache')
  reply.raw.setHeader('Connection', 'keep-alive')
  reply.raw.setHeader('X-Accel-Buffering', 'no')

  try {
    for await (const chunk of source) {
      console.log('--- sseStream chunk ---', chunk.slice(0, 50))
      // ── __usage__ frame ──────────────────────────────────────────────────
      if (chunk.startsWith('\x00__usage__')) {
        try {
          const usage = JSON.parse(chunk.slice('\x00__usage__'.length))
          reply.raw.write(`data: ${JSON.stringify({ usage })}\n\n`)
        } catch { /* ignore */ }
        continue
      }
      // ── __thinking__ frame (AI 思考文字，调用工具前) ─────────────────────
      if (chunk.startsWith('\x00__thinking__')) {
        const text = chunk.slice('\x00__thinking__'.length)
        reply.raw.write(`data: ${JSON.stringify({ thinking: text })}\n\n`)
        continue
      }
      // ── __tool_start__ frame ─────────────────────────────────────────────
      if (chunk.startsWith('\x00__tool_start__')) {
        try {
          const tool = JSON.parse(chunk.slice('\x00__tool_start__'.length))
          reply.raw.write(`data: ${JSON.stringify({ toolStart: tool })}\n\n`)
        } catch { /* ignore */ }
        continue
      }
      // ── __tool_end__ frame ───────────────────────────────────────────────
      if (chunk.startsWith('\x00__tool_end__')) {
        try {
          const tool = JSON.parse(chunk.slice('\x00__tool_end__'.length))
          reply.raw.write(`data: ${JSON.stringify({ toolEnd: tool })}\n\n`)
        } catch { /* ignore */ }
        continue
      }
      // ── __ask_user__ frame ─────────────────────────────────────────────
      if (chunk.startsWith('\x00__ask_user__')) {
        try {
          const data = JSON.parse(chunk.slice('\x00__ask_user__'.length))
          reply.raw.write(`data: ${JSON.stringify({ ask_user: data })}\n\n`)
        } catch { /* ignore */ }
        continue
      }
      // ── __user_msg_id__ frame ──────────────────────────────────────────
      // 通知前端：用户消息已落库，携带后端 message_id，前端凭此 ID 做删除/重发
      if (chunk.startsWith('\x00__user_msg_id__')) {
        const id = chunk.slice('\x00__user_msg_id__'.length)
        reply.raw.write(`data: ${JSON.stringify({ userMsgId: id })}\n\n`)
        continue
      }
      // ── 新版协议别名帧（不破坏旧消费者，仅供 wuzu-client 等下游使用） ──
      //
      // 命名规范：__userMsgId__ / __tool_call__ / __tool_result__ / __permission_request__
      // JSON envelope 字段：userMsgId / toolCall / toolResult / permissionRequest
      // 与上方 __user_msg_id__ / __tool_start__ / __tool_end__ / __ask_user__ 共存。
      if (chunk.startsWith('\x00__userMsgId__')) {
        // alias of __user_msg_id__；envelope 字段相同（userMsgId）
        const id = chunk.slice('\x00__userMsgId__'.length)
        reply.raw.write(`data: ${JSON.stringify({ userMsgId: id })}\n\n`)
        continue
      }
      if (chunk.startsWith('\x00__tool_call__')) {
        try {
          const tool = JSON.parse(chunk.slice('\x00__tool_call__'.length))
          reply.raw.write(`data: ${JSON.stringify({ toolCall: tool })}\n\n`)
        } catch { /* ignore */ }
        continue
      }
      if (chunk.startsWith('\x00__tool_result__')) {
        try {
          const tool = JSON.parse(chunk.slice('\x00__tool_result__'.length))
          reply.raw.write(`data: ${JSON.stringify({ toolResult: tool })}\n\n`)
        } catch { /* ignore */ }
        continue
      }
      if (chunk.startsWith('\x00__permission_request__')) {
        try {
          const data = JSON.parse(chunk.slice('\x00__permission_request__'.length))
          reply.raw.write(`data: ${JSON.stringify({ permissionRequest: data })}\n\n`)
        } catch { /* ignore */ }
        continue
      }
      // TODO: __message_block__ 消费端已就绪，生产者（react.ts 等）尚未 yield 该帧
      //       待上游实现后即可启用，当前为前向兼容预留。
      if (chunk.startsWith('\x00__message_block__')) {
        try {
          const data = JSON.parse(chunk.slice('\x00__message_block__'.length))
          reply.raw.write(`data: ${JSON.stringify({ messageBlock: data })}\n\n`)
        } catch { /* ignore */ }
        continue
      }
      // ── 普通内容 ─────────────────────────────────────────────────────────
      reply.raw.write(`data: ${JSON.stringify({ content: chunk })}\n\n`)
    }
    // Send done event
    reply.raw.write('data: [DONE]\n\n')
  } finally {
    reply.raw.end()
  }
}

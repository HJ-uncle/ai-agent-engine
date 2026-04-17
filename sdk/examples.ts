/**
 * AgentClient 使用示例
 * 运行：npx tsx sdk/examples.ts
 */
import AgentClient from './client.js'

const client = new AgentClient({
  baseUrl: 'http://localhost:3000',
  // apiKey: 'your-key',  // AUTH_ENABLED=true 时启用
})

const SESSION = 'demo-session-001'

async function main() {
  console.log('='.repeat(50))

  // ── 1. 健康检查 ──────────────────────────────────
  console.log('\n[1] 健康检查')
  const health = await client.health()
  console.log('  状态:', health.status, '|', health.timestamp)

  // ── 2. 查看所有工具 ──────────────────────────────
  console.log('\n[2] 已注册工具列表')
  const { tools } = await client.listTools()
  tools.forEach((t) => console.log(`  · ${t.name}：${t.description.slice(0, 50)}...`))

  // ── 3. 流式对话 ──────────────────────────────────
  console.log('\n[3] 流式对话')
  process.stdout.write('  Agent: ')
  for await (const chunk of client.chat({
    message: '用一句话介绍你自己',
    sessionId: SESSION,
  })) {
    process.stdout.write(chunk)
  }
  console.log('\n')

  // ── 4. 非流式对话（完整返回）────────────────────
  console.log('[4] 非流式对话')
  const reply = await client.chatComplete({
    message: '计算 123 * 456',
    sessionId: SESSION,
  })
  console.log('  Agent:', reply.slice(0, 200))

  // ── 5. 存取记忆 ──────────────────────────────────
  console.log('\n[5] 记忆读写')
  await client.remember('favorite_language', 'TypeScript', SESSION)
  console.log('  已存储：favorite_language = TypeScript')

  const { value } = await client.recall('favorite_language', SESSION)
  console.log('  读取：favorite_language =', value)

  const { keys } = await client.listMemories(SESSION)
  console.log('  所有记忆 key:', keys)

  // ── 6. 对话历史 ──────────────────────────────────
  console.log('\n[6] 对话历史')
  const { messages } = await client.getHistory(SESSION)
  console.log(`  共 ${messages.length} 条消息`)
  messages.slice(-2).forEach((m) =>
    console.log(`  [${m.role}]: ${m.content.slice(0, 60)}...`),
  )

  // ── 7. 指标统计 ──────────────────────────────────
  console.log('\n[7] 指标统计')
  const metrics = await client.getMetrics()
  console.log('  总请求数:', metrics.totalRequests)
  console.log('  总 Token:', metrics.totalTokens)
  if (metrics.toolCallStats.length > 0) {
    console.log('  工具调用:')
    metrics.toolCallStats.forEach((s) =>
      console.log(`    ${s.toolName}: ${s.count}次, 均耗时${s.avgDurationMs}ms`),
    )
  }

  // ── 8. 清除历史 ──────────────────────────────────
  console.log('\n[8] 清除对话历史')
  await client.clearHistory(SESSION)
  const { messages: after } = await client.getHistory(SESSION)
  console.log('  清除后消息数:', after.length)

  console.log('\n' + '='.repeat(50))
  console.log('✅ 所有示例运行完成')
}

main().catch(console.error)

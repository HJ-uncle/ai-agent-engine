/**
 * 测试：conversationId 功能
 *
 * 覆盖场景：
 * 1. 发送对话，验证返回 conversationId 和 usage
 * 2. 用 conversationId 查询该轮对话的完整消息
 * 3. 多轮对话：同一 sessionId 下每轮有独立的 conversationId
 * 4. 流式 chat() 只返回内容，chatWithUsage() 返回完整信息
 * 5. 查询不存在的 conversationId 返回 404
 *
 * 运行方式：
 *   npx tsx sdk/test-conversation-id.ts
 */

import AgentClient from './client.js'

const client = new AgentClient({ baseUrl: 'http://localhost:3000' })

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function pass(label: string) {
  console.log(`  ✅  ${label}`)
}

function fail(label: string, detail?: unknown) {
  console.error(`  ❌  ${label}`, detail ?? '')
  process.exitCode = 1
}

function section(title: string) {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`  ${title}`)
  console.log('─'.repeat(60))
}

// ─── 测试 1：chatWithUsage 返回 conversationId + usage ───────────────────────

async function testChatWithUsage() {
  section('Test 1: chatWithUsage — 返回 conversationId 和 token 用量')

  const SESSION = `test-conv-${Date.now()}`
  await client.clearHistory(SESSION)

  const result = await client.chatWithUsage({
    message: '你好，请用一句话介绍你自己',
    sessionId: SESSION,
  })

  console.log('\n  📝 回答内容:')
  console.log(' ', result.content.slice(0, 120), '...')

  if (result.conversationId) {
    pass(`conversationId 已返回: ${result.conversationId}`)
  } else {
    fail('conversationId 未返回')
    return null
  }

  if (result.usage) {
    pass('usage 已返回')
    console.log('\n  📊 Token 分布:')
    const u = result.usage
    const pct = (n: number) => ((n / u.totalTokens) * 100).toFixed(1) + '%'
    console.log(`     System Prompt  : ${u.systemPromptTokens.toLocaleString()} (${pct(u.systemPromptTokens)})`)
    console.log(`     System Tools   : ${u.systemToolsTokens.toLocaleString()} (${pct(u.systemToolsTokens)})`)
    console.log(`     Messages       : ${u.messagesTokens.toLocaleString()} (${pct(u.messagesTokens)})`)
    console.log(`     Skill Tokens   : ${u.skillTokens.toLocaleString()} (${pct(u.skillTokens)})`)
    console.log(`     ─────────────────────────────────────`)
    console.log(`     Prompt Total   : ${u.promptTokens.toLocaleString()}`)
    console.log(`     Completion     : ${u.completionTokens.toLocaleString()}`)
    console.log(`     Grand Total    : ${u.totalTokens.toLocaleString()}`)
  } else {
    fail('usage 未返回')
  }

  return result.conversationId
}

// ─── 测试 2：getConversation 查询单轮对话 ────────────────────────────────────

async function testGetConversation(conversationId: string) {
  section('Test 2: getConversation — 按 conversationId 查询消息')

  const conv = await client.getConversation(conversationId)

  if (conv.conversationId === conversationId) {
    pass(`conversationId 匹配: ${conversationId}`)
  } else {
    fail('conversationId 不匹配', conv)
    return
  }

  if (conv.messageCount >= 2) {
    pass(`消息数量: ${conv.messageCount} 条 (user + assistant)`)
  } else {
    fail(`消息数量不足: ${conv.messageCount}`, conv)
  }

  const user = conv.messages.find((m) => m.role === 'user')
  const assistant = conv.messages.find((m) => m.role === 'assistant')

  if (user) {
    pass(`user 消息存在: "${user.content.slice(0, 40)}..."`)
  } else {
    fail('user 消息缺失')
  }

  if (assistant) {
    pass(`assistant 消息存在: "${assistant.content.slice(0, 40)}..."`)
  } else {
    fail('assistant 消息缺失')
  }

  // 验证每条消息都带有 conversationId
  const allHaveId = conv.messages.every((m) => (m as any).conversationId === conversationId)
  if (allHaveId) {
    pass('所有消息的 conversationId 一致')
  } else {
    fail('部分消息的 conversationId 不一致')
  }

  console.log('\n  📋 消息列表:')
  for (const msg of conv.messages) {
    const icon = msg.role === 'user' ? '👤' : msg.role === 'assistant' ? '🤖' : '🔧'
    const preview = msg.content.slice(0, 60).replace(/\n/g, ' ')
    console.log(`     ${icon} [${msg.role.padEnd(9)}] ${preview}...`)
  }
}

// ─── 测试 3：多轮对话，每轮有独立 conversationId ────────────────────────────

async function testMultiRoundConversationIds() {
  section('Test 3: 多轮对话 — 每轮有独立 conversationId')

  const SESSION = `test-multi-${Date.now()}`
  await client.clearHistory(SESSION)

  const ids: string[] = []

  const questions = [
    '1+1等于几？',
    '刚才我问了什么问题？',
  ]

  for (const [i, message] of questions.entries()) {
    const result = await client.chatWithUsage({ message, sessionId: SESSION })

    if (result.conversationId) {
      ids.push(result.conversationId)
      pass(`第 ${i + 1} 轮 conversationId: ${result.conversationId}`)
    } else {
      fail(`第 ${i + 1} 轮未返回 conversationId`)
    }
  }

  if (ids.length === 2 && ids[0] !== ids[1]) {
    pass('两轮 conversationId 不同（符合预期：每轮独立）')
  } else if (ids.length === 2) {
    fail('两轮 conversationId 相同！（应该是不同的）')
  }

  // 查询第一轮，只应包含第一条 user 消息
  if (ids[0]) {
    const conv1 = await client.getConversation(ids[0])
    const hasQ1 = conv1.messages.some((m) => m.content.includes('1+1'))
    const hasQ2 = conv1.messages.some((m) => m.content.includes('刚才'))
    if (hasQ1 && !hasQ2) {
      pass('第 1 轮记录中只含第 1 轮消息（隔离正确）')
    } else {
      fail('第 1 轮记录污染了第 2 轮消息', { hasQ1, hasQ2 })
    }
  }
}

// ─── 测试 4：流式 chat() 不包含 usage ───────────────────────────────────────

async function testStreamingChatNoUsage() {
  section('Test 4: 流式 chat() — 只返回内容，不混入 usage')

  const chunks: string[] = []
  for await (const chunk of client.chat({ message: '说"你好"两个字', sessionId: `test-stream-${Date.now()}` })) {
    chunks.push(chunk)
  }

  const full = chunks.join('')
  const hasUsageJson = full.includes('"systemPromptTokens"') || full.includes('"conversationId"')

  if (!hasUsageJson) {
    pass('流式输出中不含 usage JSON（正确过滤）')
  } else {
    fail('流式输出中混入了 usage JSON！', full.slice(0, 200))
  }

  if (full.trim().length > 0) {
    pass(`流式内容正常: "${full.trim().slice(0, 60)}"`)
  } else {
    fail('流式内容为空')
  }
}

// ─── 测试 5：查询不存在的 conversationId 返回 404 ───────────────────────────

async function testNotFound() {
  section('Test 5: 查询不存在的 conversationId — 应返回 404')

  try {
    await client.getConversation('00000000-0000-0000-0000-000000000000')
    fail('应该抛出 404 错误，但没有')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('404')) {
      pass(`正确返回 404: ${msg}`)
    } else {
      fail('返回了错误，但不是 404', msg)
    }
  }
}

// ─── 主流程 ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🧪 AI Agent Engine SDK — conversationId 功能测试')
  console.log(`   服务地址: http://localhost:3000`)
  console.log(`   时间: ${new Date().toLocaleString('zh-CN')}`)

  // 健康检查
  try {
    const health = await client.health()
    console.log(`\n  🟢 服务状态: ${health.status}`)
  } catch {
    console.error('\n  🔴 服务未启动，请先运行 npm run dev')
    process.exit(1)
  }

  // 执行各测试
  const conversationId = await testChatWithUsage()
  if (conversationId) {
    await testGetConversation(conversationId)
  }
  await testMultiRoundConversationIds()
  await testStreamingChatNoUsage()
  await testNotFound()

  // 结果汇总
  const exitCode = process.exitCode ?? 0
  console.log(`\n${'═'.repeat(60)}`)
  if (exitCode === 0) {
    console.log('  🎉 所有测试通过！')
  } else {
    console.log('  ⚠️  有测试失败，请检查上方红色 ❌ 项')
  }
  console.log('═'.repeat(60) + '\n')
}

main().catch((err) => {
  console.error('测试运行异常:', err)
  process.exit(1)
})

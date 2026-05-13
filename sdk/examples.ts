/**
 * AgentClient 使用示例（完整版）
 * ============================================================================
 * 运行：npx tsx sdk/examples.ts
 *
 * 覆盖所有 22 个 API 命名空间的基本用法。
 */
import AgentClient from './client.js'
import type {
  CreateAgentInput, CreateModelInput, CreateTodoInput, CreateCronJobInput,
  CreateMcpServerInput, SettingsUpdate,
} from './client.js'

const client = new AgentClient({
  baseUrl: 'http://localhost:12323',
  // apiKey: 'your-key',  // AUTH_ENABLED=true 时启用
})

const SESSION = 'demo-session-001'

async function main() {
  console.log('='.repeat(60))
  console.log('  Agent Engine SDK — 完整示例')
  console.log('='.repeat(60))

  // ─── 1. 健康检查 ───────────────────────────────────────────────────
  console.log('\n[1] 健康检查')
  const health = await client.health()
  console.log('  状态:', health.status, '|', health.timestamp)

  // ─── 2. 系统设置 ───────────────────────────────────────────────────
  console.log('\n[2] 系统设置')
  const settings = await client.settings.get()
  console.log('  LLM Provider:', (settings as any).LLM_PROVIDER)
  console.log('  Model:', (settings as any).LLM_PRIMARY_MODEL)
  console.log('  Superpower:', (settings as any).SUPERPOWER_MODE)
  // 更新设置示例（谨慎操作）：
  // await client.settings.update({ SUPERPOWER_MODE: 'balanced' })

  // ─── 3. Agent 管理 ──────────────────────────────────────────────────
  console.log('\n[3] Agent 管理')
  const agents = await client.agents.list()
  console.log(`  共 ${agents.length} 个 Agent`)
  agents.forEach((a) => console.log(`  · ${a.name} (${a.id})`))

  // 创建示例：
  // const newAgent = await client.agents.create({ name: 'MyAgent', description: '测试' })
  // const detail = await client.agents.get(newAgent.id)
  // await client.agents.update(newAgent.id, { description: '更新后' })
  // await client.agents.delete(newAgent.id)

  // ─── 4. 模型管理 ────────────────────────────────────────────────────
  console.log('\n[4] 模型管理')
  const whitelist = await client.models.getWhitelist()
  console.log(`  白名单模型: ${whitelist.map((m) => m.modelId).join(', ')}`)
  const models = await client.models.list()
  console.log(`  已配置模型: ${models.length} 个`)
  models.forEach((m) => {
    console.log(`  · ${m.displayName || m.modelId} (${m.provider}) — ${m.isEnabled ? '启用' : '禁用'}`)
  })
  // 测试模型连接：
  // const result = await client.models.test(modelId, { apiKey: 'sk-xxx', baseUrl: '...' })
  // console.log('  测试结果:', result.success ? `✅ ${result.latency}ms` : `❌ ${result.error}`)

  // ─── 5. 工具列表 ────────────────────────────────────────────────────
  console.log('\n[5] 工具列表')
  const tools = await client.tools.list()
  console.log(`  全部工具: ${tools.length} 个`)
  const systemTools = await client.tools.listSystem()
  console.log(`  系统工具: ${systemTools.length} 个`)
  const skills = await client.tools.listExternalSkills()
  console.log(`  自定义技能: ${skills.length} 个`)
  tools.slice(0, 5).forEach((t) => console.log(`  · ${t.name}: ${t.description?.slice(0, 50)}...`))

  // ─── 6. 流式对话 ────────────────────────────────────────────────────
  console.log('\n[6] 流式对话')
  process.stdout.write('  Agent: ')
  for await (const chunk of client.chat({
    message: '用一句话介绍你自己',
    sessionId: SESSION,
  })) {
    process.stdout.write(chunk)
  }
  console.log('\n')

  // ─── 7. 非流式 / 带用量对话 ────────────────────────────────────────
  console.log('[7] 带用量对话')
  const { content, usage, conversationId } = await client.chatWithUsage({
    message: '1+1=? 只回答数字',
    sessionId: SESSION,
  })
  console.log('  Agent:', content.trim())
  console.log('  Token 用量:', usage?.totalTokens)
  console.log('  Conversation ID:', conversationId)

  // ─── 8. 消息管理 ────────────────────────────────────────────────────
  console.log('\n[8] 消息管理')
  const historyMessages = await client.conversation.getHistory(SESSION)
  console.log(`  历史消息: ${historyMessages.length} 条`)
  const lastUserMsg = historyMessages.filter((m) => m.role === 'user').pop()
  if (lastUserMsg && lastUserMsg.conversationId) {
    const sessionTokens = await client.messages.getSessionTokens(SESSION)
    console.log(`  会话总 Token: ${sessionTokens.totalTokens}`)
  }
  // 编辑/重新生成（SSE 流）：
  // for await (const chunk of client.messages.edit(msgId, '修改后的问题')) { ... }
  // for await (const chunk of client.messages.regenerate(msgId)) { ... }

  // ─── 9. 对话压缩 ────────────────────────────────────────────────────
  console.log('\n[9] 对话压缩')
  try {
    const compressResult = await client.conversation.compress(SESSION)
    console.log(`  压缩比例: ${compressResult.stats.ratio}`)
    console.log(`  原始 Token: ${compressResult.stats.originalTokens} → 压缩后: ${compressResult.stats.compressedTokens}`)
  } catch (e: any) {
    console.log('  跳过:', e.message)
  }

  // ─── 10. 会话管理 ────────────────────────────────────────────────────
  console.log('\n[10] 会话管理')
  const sessions = await client.conversation.getSessions()
  console.log(`  活跃会话: ${sessions.length} 个`)
  const binding = await client.sessions.getBinding(SESSION)
  console.log('  绑定状态:', binding.started ? `已锁定 → ${binding.agent?.name || binding.agentId}` : '未锁定')
  // await client.sessions.delete('obsolete-session', true)  // 保留工作区

  // ─── 11. 记忆读写 ────────────────────────────────────────────────────
  console.log('\n[11] 记忆管理')
  await client.memory.remember('favorite_language', 'TypeScript', SESSION)
  const { value } = await client.memory.recall('favorite_language', SESSION)
  console.log('  读取 favorite_language =', value)
  const memories = await client.memory.list({ sessionId: SESSION })
  console.log(`  本会话记忆: ${memories.length} 条`)
  memories.forEach((m) => console.log(`  · ${m.key} = ${m.value}`))

  // ─── 12. 待办管理 ────────────────────────────────────────────────────
  console.log('\n[12] 待办管理')
  // await client.todos.create({ title: 'Review code', priority: 'high', sessionId: SESSION })
  const todos = await client.todos.list({ sessionId: SESSION })
  console.log(`  待办数量: ${todos.length}`)
  todos.forEach((t) => console.log(`  · [${t.priority}] ${t.title} — ${t.status}`))

  // ─── 13. 定时任务 ────────────────────────────────────────────────────
  console.log('\n[13] 定时任务')
  const cronJobs = await client.cron.list()
  console.log(`  定时任务: ${cronJobs.length} 个`)
  cronJobs.forEach((j) => console.log(`  · ${j.name} (${j.cronExpr}) — ${j.enabled ? '启用' : '禁用'}`))

  // ─── 14. 安全策略 ────────────────────────────────────────────────────
  console.log('\n[14] 安全策略')
  const policies = await client.security.policies.list()
  console.log(`  命令策略: ${policies.length} 条`)
  const netPolicy = await client.security.networkPolicy.get()
  console.log(`  网络策略: ${netPolicy.enabled ? '启用' : '禁用'}, blockPrivateIPs=${netPolicy.blockPrivateIPs}`)
  // const auditLogs = await client.security.auditLog.query({ current: 1, pageSize: 10 })
  // console.log(`  审计日志: ${auditLogs.length} 条`)

  // ─── 15. LSP 诊断 ────────────────────────────────────────────────────
  console.log('\n[15] LSP 诊断')
  const adapters = await client.lsp.adapters()
  console.log(`  可用适配器: ${adapters.map((a) => `${a.name}(${a.languages.join(',')})`).join(' | ')}`)

  // ─── 16. 性能统计 ────────────────────────────────────────────────────
  console.log('\n[16] 性能统计')
  const stats = await client.performance.stats()
  console.log(`  SQLite journal: ${stats.sqlite.journal_mode}`)
  console.log(`  工具线程池: size=${stats.toolPool.size} active=${stats.toolPool.active} pending=${stats.toolPool.pending}`)

  // ─── 17. DeepSeek 通道 ────────────────────────────────────────────────
  console.log('\n[17] DeepSeek 通道')
  try {
    const dsStatus = await client.deepseek.status()
    console.log(`  状态: ${dsStatus.enabled ? '✅ 已启用' : '❌ 未启用'}`)
    if (dsStatus.enabled) {
      console.log(`  模型: ${dsStatus.currentModel}`)
      // 余额查询：
      // const balance = await client.deepseek.balance()
      // console.log(`  余额: ${balance.balance} ${balance.currency}`)
      // FIM 补全：
      // const fimResult = await client.deepseek.fim('def hello(', '\n  print(msg)')
      // console.log(`  FIM: ${fimResult.content}`)
    }
  } catch (e: any) {
    console.log('  跳过:', e.message)
  }

  // ─── 18. 知识库 ──────────────────────────────────────────────────────
  console.log('\n[18] 知识库')
  const docs = await client.knowledge.list()
  console.log(`  文档数量: ${docs.length}`)
  docs.forEach((d) => console.log(`  · ${d.filename} (${d.chunkCount} chunks)`))
  if (docs.length > 0) {
    const results = await client.knowledge.search('test', 3)
    console.log(`  搜索结果: ${results.length} 条`)
  }

  // ─── 19. MCP 服务器 ──────────────────────────────────────────────────
  console.log('\n[19] MCP 服务器')
  const mcpServers = await client.mcp.list()
  console.log(`  MCP 服务器: ${mcpServers.length} 个`)
  mcpServers.forEach((s) => {
    console.log(`  · ${s.name} (${s.transportType}) — ${s.enabled ? '✅' : '❌'}`)
  })

  // ─── 20. 工作区 ──────────────────────────────────────────────────────
  console.log('\n[20] 工作区')
  const workspaceTree = await client.workspace.files(SESSION)
  console.log(`  目录树根节点: ${workspaceTree.name} (${workspaceTree.children?.length ?? 0} 个子项)`)
  const recent = await client.workspace.recent()
  console.log(`  最近工作区: ${recent.length} 个`)
  recent.forEach((r) => console.log(`  · ${r.name} ${r.hasSession ? '(活跃)' : ''}`))

  // ─── 21. 终端 ────────────────────────────────────────────────────────
  console.log('\n[21] 终端')
  // const term = await client.terminal.create(SESSION, { cols: 120, rows: 30 })
  // console.log(`  终端已创建: ${term.terminalId} (cwd: ${term.cwd})`)
  // const wsUrl = client.terminal.wsUrl(term.terminalId)
  // console.log(`  WebSocket: ${wsUrl}`)
  console.log('  (终端功能需要 WebSocket，跳过 HTTP 示例)')

  // ─── 22. 任务管理 ────────────────────────────────────────────────────
  console.log('\n[22] 异步任务')
  const taskList = await client.tasks.list()
  console.log(`  任务数量: ${taskList.length}`)
  const { jobId } = await client.tasks.submit('test', { example: true })
  console.log(`  已提交测试任务: ${jobId}`)
  const job = await client.tasks.get(jobId)
  console.log(`  状态: ${job.status ?? 'pending'}`)

  // ─── 23. 指标统计 ────────────────────────────────────────────────────
  console.log('\n[23] Prometheus 指标')
  const metrics = await client.getMetrics()
  const metricsLines = metrics.split('\n').filter((l) => l && !l.startsWith('#'))
  console.log(`  指标行数: ${metricsLines.length}`)
  metricsLines.slice(0, 5).forEach((l) => console.log(`  ${l.slice(0, 80)}`))

  // ─── 完成 ────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60))
  console.log('✅ SDK 完整示例运行完成（22 个 API 命名空间）')
  console.log('='.repeat(60))
}

main().catch(console.error)

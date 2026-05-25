import { SQLiteMemoryManager } from '../src/storage/memory/memory-manager.js'
import { initMemoryDb } from '../src/storage/memory/db.js'
import { MEMORY_SCHEMA } from '../src/storage/memory/schema.js'

async function runTests() {
  console.log("初始化数据库...")
  await initMemoryDb(MEMORY_SCHEMA)
  const manager = new SQLiteMemoryManager()
  const ctx = { tenantId: 'perf-test', sessionId: 'test-session-1' }
  
  // 1. 海量数据写入测试 (并发写入)
  console.log("\n=== 1. 记忆功能写入效率与大容量承载测试 ===")
  const numNodes = 200
  const batchSize = 50
  console.log(`开始并发写入 ${numNodes} 个记忆节点...`)
  const startWrite = Date.now()
  
  const nodes = []
  for (let i = 0; i < numNodes; i++) {
    nodes.push({
      type: 'fact' as const,
      summary: `Test memory node ${i} for performance testing`,
      tags: ['perf', `tag_${i % 10}`],
      embedding: Array(1536).fill(0).map(() => Math.random()) // 模拟 1536 维向量
    })
  }

  // 分批并发写入
  let createdNodeIds: string[] = []
  for (let i = 0; i < numNodes; i += batchSize) {
    const batch = nodes.slice(i, i + batchSize)
    const results = await Promise.all(batch.map(n => manager.createNode(n, ctx)))
    createdNodeIds.push(...results.map(r => r.id))
  }
  const endWrite = Date.now()
  console.log(`写入完成! 耗时: ${endWrite - startWrite}ms, 平均每节点: ${((endWrite - startWrite) / numNodes).toFixed(2)}ms`)

  // 2. 三层架构 - 关系型检索测试
  console.log("\n=== 2. 三层架构 - 关系型检索测试 ===")
  const startRel = Date.now()
  const relNodes = await manager.listNodes({ limit: 100, orderBy: 'timestamp', orderDir: 'DESC' }, ctx)
  const endRel = Date.now()
  console.log(`关系型列表查询 (取前100条) 耗时: ${endRel - startRel}ms, 数量: ${relNodes.length}`)
  
  // 3. 三层架构 - 向量检索测试
  console.log("\n=== 3. 三层架构 - 向量检索 (海马体) 测试 ===")
  const queryEmbedding = Array(1536).fill(0).map(() => Math.random())
  const startVec = Date.now()
  const vecNodes = await manager.recallSimilar(queryEmbedding, 10, ctx)
  const endVec = Date.now()
  console.log(`向量相似度查询 (取Top 10) 耗时: ${endVec - startVec}ms, 找到: ${vecNodes.length}个`)

  // 4. 三层架构 - 图模拟检索测试
  console.log("\n=== 4. 三层架构 - 图模拟检索 (联络图) 测试 ===")
  // 先创建一些边
  const edges = []
  for (let i = 0; i < 50; i++) {
    edges.push({
      sourceNodeId: createdNodeIds[i],
      targetNodeId: createdNodeIds[i + 1],
      type: 'similar_to' as const,
      strength: 0.9
    })
  }
  await Promise.all(edges.map(e => manager.createEdge(e, ctx)))
  
  const startGraph = Date.now()
  const graphNodes = await manager.traversePath(createdNodeIds[0], 5, ['similar_to'], ctx)
  const endGraph = Date.now()
  console.log(`图遍历 (深度 5跳) 耗时: ${endGraph - startGraph}ms, 找到节点: ${graphNodes.length}个`)
  
  // 5. 并发一致性测试
  console.log("\n=== 5. 多请求并发下的一致性测试 ===")
  const startConcurrency = Date.now()
  const promises = []
  for (let i = 0; i < 50; i++) {
    promises.push(manager.updateNode(createdNodeIds[i], { strength: 0.99 }, ctx))
  }
  await Promise.all(promises)
  const endConcurrency = Date.now()
  console.log(`并发更新 50 个节点耗时: ${endConcurrency - startConcurrency}ms`)
  
  console.log("\n✅ 测试全部完成！")
}

runTests().catch(console.error)

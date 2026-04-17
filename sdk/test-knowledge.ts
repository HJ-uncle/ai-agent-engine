/**
 * 知识库 SDK 测试
 */
import AgentClient from '../sdk/client.ts'

const client = new AgentClient()

async function main() {
  console.log('=== 知识库 SDK 测试 ===\n')

  // 1. 上传文档
  console.log('[1] 上传文档...')
  const doc = await client.knowledge.upload(
    'typescript-tips.txt',
    'TypeScript 类型系统非常强大，支持泛型、条件类型、映射类型等高级特性。' +
    '接口 interface 可以被扩展和实现，type 别名支持联合类型和交叉类型。' +
    '使用 as const 可以保持字面量类型不被自动拓宽。' +
    'Fastify 是一个高性能 Node.js Web 框架，支持 TypeScript 开箱即用。',
  )
  console.log('  ✓ 已上传:', doc.filename, '| chunks:', doc.chunkCount, '| id:', doc.id)

  // 2. 列出所有文档
  console.log('\n[2] 文档列表...')
  const docs = await client.knowledge.list()
  docs.forEach((d) => console.log(`  - ${d.filename}（${d.chunkCount} chunks）`))

  // 3. 英文搜索（FTS5）
  console.log('\n[3] 搜索: TypeScript interface...')
  const r1 = await client.knowledge.search('TypeScript interface', 3)
  r1.forEach((r, i) => {
    console.log(`  ${i + 1}. [${r.filename}] score: ${r.score}`)
    console.log(`     ${r.content.slice(0, 80)}...`)
  })

  // 4. 中文搜索（LIKE fallback）
  console.log('\n[4] 搜索: 泛型 联合类型...')
  const r2 = await client.knowledge.search('泛型 联合类型', 3)
  r2.forEach((r, i) => {
    console.log(`  ${i + 1}. [${r.filename}] score: ${r.score}`)
    console.log(`     ${r.content.slice(0, 80)}...`)
  })

  // 5. 删除文档
  console.log('\n[5] 删除刚才上传的文档...')
  await client.knowledge.delete(doc.id)
  console.log('  ✓ 已删除:', doc.id)

  // 6. 确认删除
  const after = await client.knowledge.list()
  console.log('\n[6] 删除后文档数:', after.length)

  console.log('\n=== 测试完成 ✅ ===')
}

main().catch(console.error)

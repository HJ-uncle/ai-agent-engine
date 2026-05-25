import { createMemoryTools } from '../src/tools/memory/memory-tool.js'
import { initMemoryDb } from '../src/storage/memory/db.js'
import { MEMORY_SCHEMA } from '../src/storage/memory/schema.js'

async function run() {
  await initMemoryDb(MEMORY_SCHEMA)
  
  const tools = createMemoryTools()
  const remember = tools.find(t => t.name === 'remember')!
  const link = tools.find(t => t.name === 'link_memories')!
  
  const ctx = {
    tenantId: 'default',
    sessionId: 'simulate-api-123',
    workspaceDir: process.cwd(),
    tokenBudget: 100000,
    logger: console as any,
    history: {} as any,
    tools: {} as any,
    memory: {} as any,
  }

  console.log('1. 测试维度: 记录用户基础信息与偏好...')
  const r1 = await remember.execute({
    content: '用户叫谢霖，是高级全栈开发工程师',
    type: 'fact',
    tags: ['用户信息', '职业'],
    emotionalValence: 0.1
  }, ctx)
  const id1 = (r1 as any).output.match(/ID: (MEM-[A-Za-z0-9-]+)\)/)?.[1]
  
  const r2 = await remember.execute({
    content: '偏好热血逆袭的故事调性，从底层崛起变强破敌',
    type: 'preference',
    tags: ['故事调性', '偏好'],
    emotionalValence: 0.8,
    emotionalTrigger: '讨论到主角从被欺压到反杀的情节时非常激动'
  }, ctx)
  const id2 = (r2 as any).output.match(/ID: (MEM-[A-Za-z0-9-]+)\)/)?.[1]

  console.log('2. 测试维度: 记录废土小说复杂世界观与逻辑...')
  const r3 = await remember.execute({
    content: '核心怪物为死灵，是世界规则出Bug的具象化，而非生物',
    type: 'fact',
    tags: ['世界观', '死灵', '设定'],
    emotionalValence: 0.5
  }, ctx)
  const id3 = (r3 as any).output.match(/ID: (MEM-[A-Za-z0-9-]+)\)/)?.[1]

  const r4 = await remember.execute({
    content: '主角陆尘是末日后出生，拥有「死灵同频体」能力，可感知死灵',
    type: 'fact',
    tags: ['主角设定', '陆尘', '能力'],
    emotionalValence: 0.6
  }, ctx)
  const id4 = (r4 as any).output.match(/ID: (MEM-[A-Za-z0-9-]+)\)/)?.[1]
  
  const r5 = await remember.execute({
    content: '主角能力太弱，面对高阶死灵只能逃跑',
    type: 'narrative',
    tags: ['战斗体系', '弱点'],
    emotionalValence: -0.2
  }, ctx)
  const id5 = (r5 as any).output.match(/ID: (MEM-[A-Za-z0-9-]+)\)/)?.[1]

  console.log('3. 测试维度: API连线建立认知图谱 (强化与矛盾)...')
  if (id1 && id2) {
    await link.execute({
      sourceId: id2,
      targetId: id1,
      type: 'part_of',
      description: '谢霖作为开发工程师，偏好逻辑清晰但富有激情的逆袭故事',
      strength: 0.7
    }, ctx)
  }
  
  if (id3 && id4) {
    await link.execute({
      sourceId: id4,
      targetId: id3,
      type: 'reinforces',
      description: '主角的同频体能力正是建立在死灵是规则Bug的底层设定之上',
      strength: 0.9
    }, ctx)
  }

  if (id4 && id5) {
    await link.execute({
      sourceId: id5,
      targetId: id4,
      type: 'contradicts',
      description: '同频体理论上可以控制死灵，但目前设定遇到高阶只能逃跑，后续需要给主角设计能力觉醒的契机',
      strength: 0.8
    }, ctx)
  }
  
  if (id2 && id4) {
    await link.execute({
      sourceId: id4,
      targetId: id2,
      type: 'similar_to',
      description: '主角设定完全契合用户的热血逆袭偏好',
      strength: 0.9
    }, ctx)
  }

  console.log('API 测试与数据填充完成！节点与边已成功注入 default 租户。')
}

run().catch(console.error)
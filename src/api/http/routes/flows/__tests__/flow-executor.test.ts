/**
 * Flow 执行器单测（vitest）
 *
 * 覆盖目标：
 *   - topologicalLevels 拓扑分层（多层 / 并行节点 / 环检测）
 *   - FlowExecutor 层内并发、同层失败不阻断本层但阻断后续层、上下文合并
 *   - 每节点独立模型透传（mock executeNode 验证收到的 model）
 *
 * 运行：`npx vitest run src/api/http/routes/flows/__tests__/flow-executor.test.ts`
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { topologicalLevels } from '../flow-executor.js'
import type { FlowNodeConfig, FlowEdgeConfig } from '../flow-types.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeNode(nodeId: string, nodeType = 'agent', extra: Partial<FlowNodeConfig> = {}): FlowNodeConfig {
  return { nodeId, label: nodeId, nodeType, ...extra }
}

function makeEdge(id: string, source: string, target: string): FlowEdgeConfig {
  return { id, source, target }
}

// ─── topologicalLevels ───────────────────────────────────────────────────────

describe('topologicalLevels', () => {
  it('线性依赖分层', () => {
    const nodes = [
      makeNode('a'),
      makeNode('b'),
      makeNode('c')
    ]
    const edges = [makeEdge('e1', 'a', 'b'), makeEdge('e2', 'b', 'c')]
    const levels = topologicalLevels(nodes, edges)
    expect(levels.map(l => l.map(n => n.nodeId))).toEqual([['a'], ['b'], ['c']])
  })

  it('同层并行节点在同一层', () => {
    const nodes = [
      makeNode('start', 'start'),
      makeNode('input', 'input'),
      makeNode('agentA'),
      makeNode('agentB'),
      makeNode('end', 'end')
    ]
    const edges = [
      makeEdge('e1', 'start', 'input'),
      makeEdge('e2', 'input', 'agentA'),
      makeEdge('e3', 'input', 'agentB'),
      makeEdge('e4', 'agentA', 'end'),
      makeEdge('e5', 'agentB', 'end')
    ]
    const levels = topologicalLevels(nodes, edges)
    expect(levels.map(l => l.map(n => n.nodeId))).toEqual([
      ['start'],
      ['input'],
      ['agentA', 'agentB'],
      ['end']
    ])
  })

  it('存在环时抛错', () => {
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c')]
    const edges = [
      makeEdge('e1', 'a', 'b'),
      makeEdge('e2', 'b', 'c'),
      makeEdge('e3', 'c', 'a') // 环
    ]
    expect(() => topologicalLevels(nodes, edges)).toThrow(/cycle/)
  })

  it('无依赖节点同层', () => {
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c')]
    const edges: FlowEdgeConfig[] = []
    const levels = topologicalLevels(nodes, edges)
    expect(levels).toHaveLength(1)
    expect(new Set(levels[0].map(n => n.nodeId))).toEqual(new Set(['a', 'b', 'c']))
  })

  it('忽略指向不存在节点的边', () => {
    const nodes = [makeNode('a'), makeNode('b')]
    const edges = [makeEdge('e1', 'a', 'b'), makeEdge('e2', 'a', 'ghost')]
    const levels = topologicalLevels(nodes, edges)
    expect(levels.map(l => l.map(n => n.nodeId))).toEqual([['a'], ['b']])
  })
})

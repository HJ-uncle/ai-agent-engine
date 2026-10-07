/**
 * Flow DAG 执行器
 *
 * 确定性调度：拓扑分层 → 逐层推进 → 层内 Promise.all 并发。
 * 每节点起一个 ephemeral 子会话（复用 ReAct + 工具注册表），子会话 ID 前缀
 * `flow-<runId>-<nodeId>`，不进入可见会话列表。
 *
 * 失败语义：同层失败不阻断本层兄弟节点；本层结算后存在失败则阻断后续层并标记 flow 失败。
 *
 * 设计借鉴 ViMax：确定性 DAG 调度而非 LLM 自主 subagent 调用，
 * 以保证「同层并行」硬约束与可视化图边的严格遵循。
 */
import type { ToolProfile } from '../../../../tools/tool-profile.js'
import { logger } from '../../../../observability/index.js'
import { createLLMAdapter } from '../../../../core/llm-adapter/index.js'
import { ReActStrategy } from '../../../../core/agent-loop/react.js'
import { createToolRegistry } from '../../../../tools/registry-factory.js'
import { createAgentContext } from '../../../../core/agent-context/factory.js'
import { createConversationHistory } from '../../../../storage/conversation/factory.js'
import type {
  FlowNodeConfig,
  FlowEdgeConfig,
  RunFlowOptions,
  FlowEvent
} from './flow-types.js'
import type { FlowEventBus } from './flow-event-bus.js'

// ==================== 拓扑分层 ====================

/**
 * 将节点按依赖边分层（Kahn 算法变体）。
 * 同层节点彼此无依赖；返回层顺序保证上游层在前。
 * 存在环时抛出 'Flow graph contains a cycle'。
 */
export function topologicalLevels(
  nodes: FlowNodeConfig[],
  edges: FlowEdgeConfig[]
): FlowNodeConfig[][] {
  const nodeMap = new Map(nodes.map((n) => [n.nodeId, n]))
  // 入度（指向该节点的边数）
  const indegree = new Map<string, number>()
  // 反向邻接表：source -> [targets]
  const adjacency = new Map<string, string[]>()

  for (const n of nodes) {
    indegree.set(n.nodeId, 0)
    adjacency.set(n.nodeId, [])
  }
  for (const e of edges) {
    if (!nodeMap.has(e.source) || !nodeMap.has(e.target)) continue
    adjacency.get(e.source)!.push(e.target)
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1)
  }

  const levels: FlowNodeConfig[][] = []
  const resolved = new Set<string>()
  const remaining = new Set(nodes.map((n) => n.nodeId))

  while (remaining.size > 0) {
    // 当前层：入度为 0（或所有上游已 resolved）的剩余节点
    const layer: FlowNodeConfig[] = []
    for (const id of remaining) {
      const ups = edges.filter((e) => e.target === id).map((e) => e.source)
      if (ups.every((u) => resolved.has(u) || !nodeMap.has(u))) {
        layer.push(nodeMap.get(id)!)
      }
    }
    if (layer.length === 0) {
      throw new Error('Flow graph contains a cycle')
    }
    levels.push(layer)
    for (const n of layer) {
      remaining.delete(n.nodeId)
      resolved.add(n.nodeId)
    }
  }
  return levels
}

// ==================== 节点执行 ====================

/**
 * 执行单个节点：起 ephemeral 子会话跑 ReAct。
 * 子会话 ID 用 `flow-<runId>-<nodeId>` 前缀，不进入可见会话列表。
 */
async function executeNode(
  node: FlowNodeConfig,
  resolvedPrompt: string,
  runId: string,
  bus: FlowEventBus,
  signal: AbortSignal,
  toolProfile: ToolProfile
): Promise<{ output: string; usage?: FlowEvent['usage'] }> {
  const subSessionId = `flow-${runId}-${node.nodeId}`
  const nodeLogger = logger.child({ flowRunId: runId, nodeId: node.nodeId, subSessionId })

  bus.emit({
    type: 'node_start',
    runId: bus.runId,
    flowId: bus.flowId,
    nodeId: node.nodeId,
    timestamp: Date.now()
  })

  try {
    const { registry: subRegistry, externalSkills } = await createToolRegistry({ toolProfile })

    // 系统提示词：节点 > 默认
    const defaultPrompt = '你是一个专业的子代理，专注于完成特定任务。请清晰思考，分步执行，确保任务完成后提供详细的总结。'
    const baseSystemPrompt = node.systemPrompt || defaultPrompt
    const skillsPrompt = buildSkillsSystemPrompt(externalSkills)
    const finalSystemPrompt = [baseSystemPrompt, skillsPrompt].filter(Boolean).join('\n\n')

    const subCtx = createAgentContext({
      toolProfile,
      sessionId: subSessionId,
      tenantId: 'flow-tenant', // ephemeral，不入可见列表
      tools: subRegistry,
      history: createConversationHistory(),
      logger: nodeLogger,
      tokenBudget: undefined,
      signal
    })

    const llm = createLLMAdapter({ model: node.model || 'gpt-4o-mini' })
    const strategy = new ReActStrategy(llm, {
      // Code flows use the same unbounded local policy as interactive Code
      // sessions; general flows keep their explicit workflow safety cap.
      maxIterations: toolProfile === 'code' ? undefined : 10,
      unboundedCode: toolProfile === 'code',
      systemPrompt: finalSystemPrompt
    })

    let output = ''
    for await (const chunk of strategy.run([{ role: 'user', content: resolvedPrompt }], subCtx)) {
      if (signal.aborted) throw new Error('已取消')
      output += chunk
      // 推送内容增量
      bus.emit({
        type: 'node_delta',
        runId: bus.runId,
        flowId: bus.flowId,
        nodeId: node.nodeId,
        content: chunk,
        timestamp: Date.now()
      })
    }

    bus.emit({
      type: 'node_done',
      runId: bus.runId,
      flowId: bus.flowId,
      nodeId: node.nodeId,
      content: output,
      timestamp: Date.now()
    })

    return { output }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    bus.emit({
      type: 'node_error',
      runId: bus.runId,
      flowId: bus.flowId,
      nodeId: node.nodeId,
      error: message,
      timestamp: Date.now()
    })
    throw err
  }
}

function buildSkillsSystemPrompt(externalSkills: any[]): string {
  if (externalSkills.length === 0) return ''
  const skillsList = externalSkills
    .map((s) => {
      const params = Object.entries(s.parameters?.properties || {})
        .map(([key, prop]: any) => `  ${key}: ${prop.description || '无描述'}`)
        .join('\n')
      return `- ${s.name}: ${s.description}\n${params}`
    })
    .join('\n')
  return `## 可用技能\n\n${skillsList}`
}

// ==================== 模板解析 ====================

/** 解析 {{input}} / {{output}} / {{nodeId}} 模板，取上下文字符串表示 */
function resolveTemplate(template: string, context: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return context[key] ?? ''
  })
}

function getUpstreamOutputs(
  nodeId: string,
  edges: FlowEdgeConfig[],
  context: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const e of edges) {
    if (e.target === nodeId && context[e.source] !== undefined) {
      result[e.source] = context[e.source]
    }
  }
  return result
}

function resolveFinalOutput(nodes: FlowNodeConfig[], context: Record<string, string>): string {
  // 取最后一个 end/input 节点的上游输出；否则取全局 output
  const endNodes = nodes.filter((n) => n.nodeType === 'end' || n.nodeType === 'input')
  if (endNodes.length > 0) {
    const last = endNodes[endNodes.length - 1]
    return context[last.nodeId] ?? context['output'] ?? ''
  }
  return context['output'] ?? ''
}

// ==================== Flow 执行器 ====================

export class FlowExecutor {
  constructor(
    private bus: FlowEventBus,
    private signal: AbortSignal,
    private toolProfile: ToolProfile = 'general'
  ) {}

  async run(opts: RunFlowOptions): Promise<void> {
    const { flowId, nodes, edges, userInput = '' } = opts
    logger.info({ flowId, runId: this.bus.runId, nodeCount: nodes.length }, '[Flow] 开始执行')

    this.bus.emit({
      type: 'flow_started',
      runId: this.bus.runId,
      flowId,
      timestamp: Date.now()
    })

    // 校验 + 分层
    let levels: FlowNodeConfig[][]
    try {
      levels = topologicalLevels(nodes, edges)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.bus.emit({
        type: 'flow_error',
        runId: this.bus.runId,
        flowId,
        error: message,
        timestamp: Date.now()
      })
      this.bus.end()
      return
    }

    const context: Record<string, string> = { input: userInput, output: '' }
    let failed = false

    try {
      for (const level of levels) {
        if (this.signal.aborted) break

        // 层内并发执行；失败节点不阻断同层其它分支
        const results = await Promise.all(
          level.map(async (node) => {
            const upstreamOutputs = getUpstreamOutputs(node.nodeId, edges, context)
            const nodeContext = { ...context, ...upstreamOutputs }
            const prompt = node.prompt
              ? resolveTemplate(node.prompt, nodeContext)
              : nodeContext['input'] || ''

            if (!prompt) {
              this.bus.emit({
                type: 'node_error',
                runId: this.bus.runId,
                flowId,
                nodeId: node.nodeId,
                error: '无输入，已跳过',
                timestamp: Date.now()
              })
              return { nodeId: node.nodeId, ok: false, output: '' }
            }

            try {
              const { output } = await executeNode(node, prompt, this.bus.runId, this.bus, this.signal, this.toolProfile)
              // 仅写各自的 node key（互不覆盖）
              context[node.nodeId] = output
              context['output'] = output
              if (node.nodeType === 'input') context['input'] = output
              return { nodeId: node.nodeId, ok: true, output }
            } catch (err) {
              return { nodeId: node.nodeId, ok: false, output: '' }
            }
          })
        )

        if (this.signal.aborted) break
        if (results.some((r) => !r.ok)) {
          failed = true
          break
        }
      }

      if (this.signal.aborted) {
        this.bus.emit({
          type: 'flow_cancelled',
          runId: this.bus.runId,
          flowId,
          timestamp: Date.now()
        })
      } else if (failed) {
        this.bus.emit({
          type: 'flow_error',
          runId: this.bus.runId,
          flowId,
          error: 'Flow 执行失败：存在节点执行错误',
          timestamp: Date.now()
        })
      } else {
        const finalOutput = resolveFinalOutput(nodes, context)
        this.bus.emit({
          type: 'flow_done',
          runId: this.bus.runId,
          flowId,
          finalOutput,
          timestamp: Date.now()
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.bus.emit({
        type: 'flow_error',
        runId: this.bus.runId,
        flowId,
        error: message,
        timestamp: Date.now()
      })
    } finally {
      this.bus.end()
    }
  }
}

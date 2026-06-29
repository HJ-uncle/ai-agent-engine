/**
 * Flow DTO 类型定义
 *
 * agent-engine 引擎级 Flow 执行的请求/事件数据契约。
 * 与 wuzu-client `src/types/engine.d.ts` 的 FlowNodeConfig/FlowEdgeConfig/RunFlowOptions/FlowEvent 对齐，
 * 作为跨进程（HTTP + SSE）单一事实来源的镜像。
 *
 * 设计约束：
 * - 同层节点并行执行（拓扑分层 + Promise.all）
 * - 每节点独立模型（请求级隔离）
 * - ephemeral 子会话（不进入可见会话列表）
 * - 失败语义：同层失败不阻断本层兄弟节点，本层结算后存在失败则阻断后续层
 */

/** Flow 节点级配置（来自客户端） */
export interface FlowNodeConfig {
  nodeId: string
  label: string
  nodeType: string
  prompt?: string
  systemPrompt?: string
  activeSkillIds?: string[]
  activeMcpServerIds?: string[]
  knowledgeBases?: string[]
  /** 每节点独立模型（请求级隔离） */
  model?: string
  agentId?: string
  upstreamNodeIds?: string[]
  config?: Record<string, unknown>
}

/** Flow 边 */
export interface FlowEdgeConfig {
  id: string
  source: string
  target: string
}

/** Flow 执行请求 */
export interface RunFlowOptions {
  flowId: string
  flowName?: string
  nodes: FlowNodeConfig[]
  edges: FlowEdgeConfig[]
  userInput?: string
  cwd?: string
  executionMode?: 'auto' | 'local' | 'sandbox' | 'workspace' | 'fullAccess' | 'yolo'
  securityMode?: 'safe' | 'standard' | 'full-access'
}

/** Flow SSE 事件种类 */
export type FlowEventType =
  | 'flow_started'
  | 'node_start'
  | 'node_delta'
  | 'node_done'
  | 'node_error'
  | 'flow_done'
  | 'flow_error'
  | 'flow_cancelled'

/** Flow SSE 事件载荷 */
export interface FlowEvent {
  type: FlowEventType
  runId: string
  flowId: string
  nodeId?: string
  content?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    costCNY?: number
    costUSD?: number
  }
  error?: string
  finalOutput?: string
  timestamp: number
}

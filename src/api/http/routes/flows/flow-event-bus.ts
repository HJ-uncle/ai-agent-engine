/**
 * Flow 事件总线
 *
 * 复用 StreamBus 模式：Flow 执行器把 FlowEvent 序列化为 `\x00__flow__`
 * 控制帧 push 进 bus，SSE 路由经 sseStream → 客户端。
 *
 * 与 chat 的 StreamBus 同源，但用单一控制帧 `__flow__` 承载全部 flow 事件类型，
 * 客户端按 FlowEvent.type 分发。
 */
import { v4 as uuidv4 } from 'uuid'
import { StreamBus } from '../../../../core/stream-pipeline/stream-bus.js'
import type { FlowEvent } from './flow-types.js'

const FLOW_FRAME_PREFIX = '\x00__flow__'

export class FlowEventBus {
  readonly runId: string
  readonly flowId: string
  private readonly bus: StreamBus

  constructor(flowId: string, abortController: AbortController) {
    this.runId = `flow-run-${Date.now()}-${uuidv4().slice(0, 8)}`
    this.flowId = flowId
    this.bus = new StreamBus(abortController)
  }

  /** 推送一个 flow 事件 */
  emit(event: Omit<FlowEvent, 'runId' | 'flowId'> & { runId?: string; flowId?: string }): void {
    const full: FlowEvent = {
      type: event.type,
      runId: this.runId,
      flowId: this.flowId,
      nodeId: event.nodeId,
      content: event.content,
      usage: event.usage,
      error: event.error,
      finalOutput: event.finalOutput,
      timestamp: event.timestamp
    }
    this.bus.push(`${FLOW_FRAME_PREFIX}${JSON.stringify(full)}`)
  }

  /** 结束事件流 */
  end(): void {
    this.bus.end()
  }

  /** 错误终止 */
  error(err: unknown): void {
    this.bus.error(err)
  }

  /** 暴露底层 StreamBus 供 sseStream 消费 */
  get streamBus(): StreamBus {
    return this.bus
  }

  get signal(): AbortSignal {
    return this.bus.abortController.signal
  }
}

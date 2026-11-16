import { PluginError } from './types.js'

/** Public plugin events deliberately exclude reasoning, tool arguments and tool output. */
export type PluginStreamEvent =
  | { type: 'started'; runId?: string; childSessionId?: string; model?: string }
  | { type: 'text-delta'; text: string; runId?: string }
  | { type: 'tool-start' | 'tool-end'; toolName: string; toolCallId?: string; runId?: string; success?: boolean; durationMs?: number }
  | { type: 'pending'; runId: string; childSessionId: string; pending: ReturnType<typeof import('../core/stream-pipeline/public-pending.js').publicPending> }
  | { type: 'complete'; result: unknown }
  | { type: 'error'; error: { code: string; message: string } }

export type PluginStreamListener = (event: PluginStreamEvent) => void | Promise<void>

export function pluginStreamError(error: unknown, signal?: AbortSignal): PluginError {
  if (signal?.aborted) {
    if (signal.reason instanceof PluginError) return signal.reason
    return new PluginError('PLUGIN_CANCELLED', '调用已取消或超时', 408)
  }
  if (error instanceof PluginError) return error
  return new PluginError('PLUGIN_STREAM_FAILED', '流式调用未完成，请重试', 502)
}

/** Await consumers/provider reads without retaining an unbounded event queue. */
export function awaitPluginStream<T>(promise: PromiseLike<T> | T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(pluginStreamError(undefined, signal))
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(pluginStreamError(undefined, signal)) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

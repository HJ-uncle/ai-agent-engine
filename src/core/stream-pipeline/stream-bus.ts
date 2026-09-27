import { EventEmitter } from 'events'

export interface SseEventPayload {
  id: string
  chunk: string
}

export class StreamBus {
  public events: SseEventPayload[] = []
  public emitter = new EventEmitter()
  public finished = false
  public errorObj: any = null
  public disconnectTimeout: NodeJS.Timeout | null = null

  constructor(public abortController: AbortController) {
    // Increase listener limit to prevent warnings if multiple reconnects happen quickly
    this.emitter.setMaxListeners(20)
  }

  push(chunk: string) {
    const id = `${Date.now()}-${this.events.length}`
    const payload = { id, chunk }
    this.events.push(payload)
    this.emitter.emit('data', payload)
  }

  end() {
    this.finished = true
    this.emitter.emit('end')
  }

  error(err: any) {
    this.finished = true
    this.errorObj = err
    this.emitter.emit('error', err)
  }
}

export const activeStreams = new Map<string, StreamBus>()

export async function* busToIterable(bus: StreamBus, lastEventId?: string): AsyncIterable<SseEventPayload> {
  // 1. Yield cached events after lastEventId
  let startIndex = 0
  if (lastEventId) {
    const idx = bus.events.findIndex(e => e.id === lastEventId)
    if (idx !== -1) {
      startIndex = idx + 1
    }
  }

  for (let i = startIndex; i < bus.events.length; i++) {
    yield bus.events[i]
  }

  if (bus.finished && !bus.errorObj) return
  if (bus.errorObj) throw bus.errorObj

  // 2. Listen for new events
  const queue: SseEventPayload[] = []
  let resolve: (() => void) | null = null
  let reject: ((err: any) => void) | null = null

  const onData = (payload: SseEventPayload) => {
    queue.push(payload)
    if (resolve) {
      resolve()
      resolve = null
    }
  }
  const onEnd = () => {
    if (resolve) {
      resolve()
      resolve = null
    }
  }
  const onError = (err: any) => {
    if (reject) {
      reject(err)
      reject = null
    }
  }

  bus.emitter.on('data', onData)
  bus.emitter.on('end', onEnd)
  bus.emitter.on('error', onError)

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!
      } else if (bus.finished) {
        if (bus.errorObj) throw bus.errorObj
        break
      } else {
        await new Promise<void>((res, rej) => {
          resolve = res
          reject = rej
        })
      }
    }
  } finally {
    bus.emitter.off('data', onData)
    bus.emitter.off('end', onEnd)
    bus.emitter.off('error', onError)
  }
}

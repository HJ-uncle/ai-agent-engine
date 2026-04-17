export interface StreamChunk {
  content: string
  done?: boolean
}

export type NextFn = () => Promise<void>

export interface StreamMiddleware {
  transform(chunk: StreamChunk, next: NextFn): Promise<void>
}

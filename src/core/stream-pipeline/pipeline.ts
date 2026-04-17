import type { StreamChunk, StreamMiddleware } from './types.js'

export class StreamPipeline {
  constructor(private readonly middlewares: StreamMiddleware[] = []) {}

  // Apply middleware chain to a source async iterable.
  // Returns transformed async iterable.
  // Each middleware runs sequentially. Mutating chunk.content is how transformations work.
  // Not calling next() causes the chunk to be filtered out (blocked).
  async *pipe(source: AsyncIterable<string>): AsyncIterable<string> {
    for await (const content of source) {
      const chunk: StreamChunk = { content }
      const transformed = await this.applyMiddlewares(chunk)
      if (transformed.content) {
        yield transformed.content
      }
    }
  }

  private async applyMiddlewares(chunk: StreamChunk): Promise<StreamChunk> {
    // chunk is passed by reference — middlewares can mutate chunk.content directly
    for (const middleware of this.middlewares) {
      let nextCalled = false
      await middleware.transform(chunk, async () => {
        nextCalled = true
      })
      // If next() was not called, this middleware blocked the chunk
      if (!nextCalled) {
        return { content: '' }
      }
    }
    return chunk
  }
}

export function createPipeline(middlewares: StreamMiddleware[] = []): StreamPipeline {
  return new StreamPipeline(middlewares)
}

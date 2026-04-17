import { StreamPipeline, createPipeline } from '../pipeline.js'
import type { StreamChunk, StreamMiddleware, NextFn } from '../types.js'

// ─── Mock source ──────────────────────────────────────────────────────────────

async function* mockSource(chunks: string[]) {
  for (const c of chunks) yield c
}

// ─── Helper to collect all yielded values ─────────────────────────────────────

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const results: string[] = []
  for await (const item of iterable) {
    results.push(item)
  }
  return results
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('StreamPipeline', () => {
  it('passes chunks through unchanged when there are no middlewares', async () => {
    const pipeline = new StreamPipeline()
    const output = await collect(pipeline.pipe(mockSource(['hello', ' world'])))

    expect(output).toEqual(['hello', ' world'])
  })

  it('createPipeline() builds a pipeline with no middlewares by default', async () => {
    const pipeline = createPipeline()
    const output = await collect(pipeline.pipe(mockSource(['a', 'b'])))

    expect(output).toEqual(['a', 'b'])
  })

  it('middleware can transform chunk content (uppercase)', async () => {
    const uppercaseMiddleware: StreamMiddleware = {
      async transform(chunk: StreamChunk, next: NextFn) {
        chunk.content = chunk.content.toUpperCase()
        await next()
      },
    }

    const pipeline = createPipeline([uppercaseMiddleware])
    const output = await collect(pipeline.pipe(mockSource(['hello', 'world'])))

    expect(output).toEqual(['HELLO', 'WORLD'])
  })

  it('middleware that does not call next() filters out the chunk', async () => {
    // Blocks chunks that contain the word "secret"
    const filterMiddleware: StreamMiddleware = {
      async transform(chunk: StreamChunk, next: NextFn) {
        if (chunk.content.includes('secret')) {
          // Do NOT call next() — chunk is dropped
          return
        }
        await next()
      },
    }

    const pipeline = createPipeline([filterMiddleware])
    const output = await collect(
      pipeline.pipe(mockSource(['keep this', 'secret data', 'also keep'])),
    )

    expect(output).toEqual(['keep this', 'also keep'])
  })

  it('multiple middlewares execute in order and transform content sequentially', async () => {
    const order: string[] = []

    const middlewareA: StreamMiddleware = {
      async transform(chunk: StreamChunk, next: NextFn) {
        order.push('A-before')
        chunk.content = `[A]${chunk.content}`
        await next()
        order.push('A-after')
      },
    }

    const middlewareB: StreamMiddleware = {
      async transform(chunk: StreamChunk, next: NextFn) {
        order.push('B-before')
        chunk.content = `[B]${chunk.content}`
        await next()
        order.push('B-after')
      },
    }

    const pipeline = createPipeline([middlewareA, middlewareB])
    const output = await collect(pipeline.pipe(mockSource(['x'])))

    // Middlewares run sequentially: A then B, so content is wrapped A first then B
    expect(output).toEqual(['[B][A]x'])
    // Sequential execution: A-before → A calls next() → A-after; then B-before → B calls next() → B-after
    expect(order).toEqual(['A-before', 'A-after', 'B-before', 'B-after'])
  })

  it('yields nothing for an empty source', async () => {
    const pipeline = createPipeline()
    const output = await collect(pipeline.pipe(mockSource([])))

    expect(output).toEqual([])
  })

  it('handles a single middleware that passes all chunks through', async () => {
    const passthroughMiddleware: StreamMiddleware = {
      async transform(_chunk: StreamChunk, next: NextFn) {
        await next()
      },
    }

    const pipeline = createPipeline([passthroughMiddleware])
    const output = await collect(pipeline.pipe(mockSource(['one', 'two', 'three'])))

    expect(output).toEqual(['one', 'two', 'three'])
  })

  it('first middleware blocking prevents second middleware from running', async () => {
    const secondCalled = vi.fn()

    const blocker: StreamMiddleware = {
      async transform(_chunk: StreamChunk, _next: NextFn) {
        // does not call next — blocks the chunk
      },
    }

    const observer: StreamMiddleware = {
      async transform(_chunk: StreamChunk, next: NextFn) {
        secondCalled()
        await next()
      },
    }

    const pipeline = createPipeline([blocker, observer])
    const output = await collect(pipeline.pipe(mockSource(['blocked'])))

    expect(output).toEqual([])
    expect(secondCalled).not.toHaveBeenCalled()
  })
})

# stream-pipeline Specification

## Purpose
TBD - created by archiving change ai-agent-engine. Update Purpose after archive.
## Requirements
### Requirement: Pipeline Creation

The StreamPipeline SHALL provide a `createPipeline(middlewares[])` factory that assembles an ordered chain of stream middlewares and returns a pipeline instance.

#### Scenario: Pipeline created with middlewares
- **WHEN** `createPipeline([mw1, mw2, mw3])` is called
- **THEN** the returned pipeline instance SHALL apply middlewares in the order `mw1 → mw2 → mw3` when processing each chunk

#### Scenario: Pipeline created with empty middleware list
- **WHEN** `createPipeline([])` is called
- **THEN** the returned pipeline SHALL operate in pass-through mode, emitting each input chunk unchanged

---

### Requirement: Middleware Interface

Each stream middleware SHALL conform to the `StreamMiddleware` interface: `transform(chunk: string, next: (chunk: string) => void) => void`.

#### Scenario: Middleware calls next
- **WHEN** a middleware's `transform` function calls `next(modifiedChunk)`
- **THEN** the pipeline SHALL pass `modifiedChunk` to the subsequent middleware (or to the output if no more middlewares remain)

#### Scenario: Middleware suppresses chunk
- **WHEN** a middleware's `transform` function does NOT call `next`
- **THEN** the chunk SHALL be dropped and SHALL NOT propagate further down the pipeline

#### Scenario: Middleware emits multiple chunks
- **WHEN** a middleware calls `next` more than once within a single `transform` invocation
- **THEN** each call to `next` SHALL independently propagate a chunk through the remaining pipeline

---

### Requirement: SSE Output

The StreamPipeline SHALL support piping its output to a Fastify reply, sending each transformed chunk as a Server-Sent Events (SSE) frame.

#### Scenario: Chunk emitted as SSE frame
- **WHEN** a chunk passes through the full middleware chain
- **THEN** the pipeline SHALL write it to the Fastify reply as `data: <chunk>\n\n` in SSE format

#### Scenario: Stream end signaled
- **WHEN** the upstream LLM stream signals completion
- **THEN** the pipeline SHALL send `data: [DONE]\n\n` and call `reply.raw.end()` to close the SSE connection

#### Scenario: SSE headers set automatically
- **WHEN** the pipeline begins streaming to a Fastify reply
- **THEN** it SHALL set `Content-Type: text/event-stream` and `Cache-Control: no-cache` headers before writing any data

---

### Requirement: P0 Pass-Through Mode

In P0, when no middlewares are configured, chunks SHALL flow directly from the LLM adapter to the SSE output without transformation.

#### Scenario: Direct pass-through
- **WHEN** `createPipeline([])` is used and a stream chunk arrives
- **THEN** the chunk SHALL be written to the SSE output unchanged with no additional processing overhead

---

### Requirement: Middleware Chain Execution Order

Middlewares SHALL be invoked strictly in the order they were provided to `createPipeline`.

#### Scenario: Ordered execution verification
- **WHEN** three middlewares each append a marker to the chunk (e.g., `[A]`, `[B]`, `[C]`) and `createPipeline([mwA, mwB, mwC])` is used
- **THEN** the output chunk SHALL be `original[A][B][C]`, confirming sequential execution in registration order


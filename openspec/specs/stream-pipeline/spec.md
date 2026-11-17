# Stream Pipeline Specification

## Purpose

Separate middleware text transformation from durable event publication, replay and HTTP SSE delivery. Source audit: 2026-11-17.

## Requirements

### Requirement: Mutable sequential transformation

StreamPipeline SHALL accept an AsyncIterable<string>. For each input it SHALL create a mutable StreamChunk and invoke middleware sequentially with transform(chunk, async next()).

#### Scenario: Transform or suppress

- **WHEN** middleware changes chunk.content and calls next()
- **THEN** later middleware SHALL observe the modified chunk.
- **WHEN** middleware does not call next()
- **THEN** that input chunk SHALL be suppressed.
- **WHEN** final content is empty
- **THEN** the pipeline SHALL emit no output for that chunk.

Calling next() more than once is not a multiple-emission API. Middleware receives an object, not a replacement string argument.

### Requirement: Bounded replay and subscribers

The runtime StreamBus SHALL bound replay and subscriber buffering. Current defaults for each are 2048 events and 8 MiB, configurable through bus options.

#### Scenario: Lagging subscriber

- **WHEN** a subscriber can no longer recover within bounded buffers
- **THEN** the system SHALL require snapshot recovery rather than retain unbounded process memory.

Durable state projection/publication barriers SHALL preserve event ordering and prevent UI observation from outrunning required persistence.

### Requirement: SSE connection lifecycle

The HTTP sink SHALL emit valid event-stream frames, apply socket backpressure and send heartbeat comments every 15 seconds while connected.

#### Scenario: Subscriber disconnect

- **WHEN** the client socket closes
- **THEN** the sink SHALL detach its source subscription and clear heartbeat/listeners
- **AND** SHALL NOT infer that the underlying owned producer should be cancelled.

#### Scenario: Normal finish or error

- **WHEN** the source ends while the socket is connected
- **THEN** the sink SHALL send the done frame.
- **WHEN** the source fails
- **THEN** it SHALL attempt an error payload and done frame before closing.

## Source map

[Pipeline](../../../src/core/stream-pipeline/pipeline.ts), [types](../../../src/core/stream-pipeline/types.ts), [bus](../../../src/core/stream-pipeline/stream-bus.ts), [publication queue](../../../src/core/stream-pipeline/publication-queue.ts), [SSE sink](../../../src/core/stream-pipeline/sse-sink.ts), [tests](../../../src/core/stream-pipeline/__tests__/). Middleware behavior is not a guarantee of provider token boundaries.

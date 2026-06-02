# observability Specification

## Purpose
TBD - created by archiving change ai-agent-engine. Update Purpose after archive.
## Requirements
### Requirement: Structured Logging

The system SHALL use Pino as the logging library. Every log entry SHALL include `tenantId`, `sessionId`, and `requestId` as structured fields.

#### Scenario: Log entry includes required fields
- **WHEN** any component emits a log entry during request processing
- **THEN** the log record SHALL contain `tenantId`, `sessionId`, and `requestId` as top-level fields alongside the message and log level

#### Scenario: Log level configuration
- **WHEN** the environment variable `LOG_LEVEL` is set (e.g., `debug`, `info`, `warn`, `error`)
- **THEN** Pino SHALL apply that level, suppressing log entries below the configured threshold

#### Scenario: Structured JSON output
- **WHEN** the application runs in production mode (`NODE_ENV=production`)
- **THEN** all log output SHALL be emitted as newline-delimited JSON (NDJSON) suitable for log aggregation systems

---

### Requirement: Token Usage Statistics

The system SHALL record `promptTokens` and `completionTokens` to SQLite after every LLM call, associated with the `requestId` and `tenantId`.

#### Scenario: Token record written after LLM call
- **WHEN** an LLM `complete()` or `stream()` call finishes successfully
- **THEN** a row SHALL be inserted into the `token_usage` table with columns `requestId`, `tenantId`, `promptTokens`, `completionTokens`, and `timestamp`

#### Scenario: Token record on retry success
- **WHEN** an LLM call succeeds on the second or third retry attempt
- **THEN** only one token usage record SHALL be written, reflecting the successful attempt's token counts

#### Scenario: Aggregate token query
- **WHEN** a query is issued for total token usage by a tenant over a time range
- **THEN** the system SHALL be able to SUM `promptTokens + completionTokens` from the `token_usage` table filtered by `tenantId` and `timestamp` range

---

### Requirement: Tool Call Duration Tracking

The system SHALL record the execution duration of each tool call in milliseconds and store it for observability purposes.

#### Scenario: Duration recorded after tool execution
- **WHEN** a tool call via `ToolRegistry.execute()` completes (success or failure)
- **THEN** the system SHALL compute `durationMs = endTime - startTime` and write a record with `toolName`, `durationMs`, `success`, `requestId`, and `tenantId`

#### Scenario: Duration recorded on tool error
- **WHEN** a tool call results in a `ToolExecutionError`
- **THEN** the duration SHALL still be recorded with `success: false`

---

### Requirement: Request Tracing

Each incoming HTTP request SHALL be assigned a unique `requestId` that is propagated through the entire Agent Loop and included in all logs and observability records for that request.

#### Scenario: requestId assigned at entry point
- **WHEN** an HTTP request arrives at the Fastify server
- **THEN** the request middleware SHALL assign a UUID `requestId` (or read it from `X-Request-ID` header if provided) and attach it to the request context

#### Scenario: requestId propagated through Agent Loop
- **WHEN** the Agent Loop executes LLM calls and tool calls for a given request
- **THEN** all Pino log entries, token usage records, and tool duration records emitted during that request SHALL carry the same `requestId`

#### Scenario: requestId returned in response headers
- **WHEN** an HTTP response is sent
- **THEN** the response SHALL include an `X-Request-ID` header containing the `requestId` for client-side correlation


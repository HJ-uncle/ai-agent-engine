# Observability Specification

## Purpose

Distinguish operational logs, quota aggregates, physical model attempts, tool metrics and optional QA transcripts. Source audit: 2026-11-17.

## Requirements

### Requirement: Contextual structured logging

The logger SHALL default to info level, use pretty development output and structured JSON in production. Request loggers SHALL carry available requestId/tenantId/sessionId fields.

#### Scenario: Non-request log

- **WHEN** a startup or background component logs without request context
- **THEN** the record SHALL NOT be assumed to contain every request/session field.

### Requirement: Explicit metric recording

recordTokenUsage SHALL aggregate token totals and request counts in quotas by tenant and UTC date. recordToolCall SHALL write tool_metrics with tool name, tenant/session, duration and success.

#### Scenario: Aggregate query

- **WHEN** getMetrics is called with a tenant
- **THEN** totals and tool aggregates SHALL be filtered to that tenant
- **AND** totals SHALL reflect recorded data, not a reconstruction of every physical provider request.

Tool instrumentation is an opt-in wrapper; ToolRegistry alone does not guarantee every tool has metrics. There is no universal token_usage table contract in this component.

### Requirement: Preserve accounting uncertainty

Model request instrumentation SHALL distinguish physical attempts and unconfirmed upstream outcomes. Local request projections, provider usage and provider cache fields SHALL not be conflated.

#### Scenario: Retry or transport loss

- **WHEN** more than one physical request occurs or final usage is unavailable
- **THEN** reporting SHALL NOT infer exact billed tokens solely from the final successful response
- **AND** unknown values SHALL not become fabricated cache misses or zero cost.

### Requirement: QA logging is optional sensitive storage

QA logging SHALL require explicit enablement. It can include system text, tools, history, reasoning and usage, and SHALL not be treated as always-on lightweight telemetry.

#### Scenario: Default configuration

- **WHEN** QA_LOG_ENABLED is not true
- **THEN** the optional QA transcript writer SHALL remain disabled.
- **WHEN** enabled
- **THEN** its default output directory SHALL be logs/qa unless configured otherwise.

Current QA truncation is disabled in source; enabled QA files may therefore be large. Storage policy and retention require explicit operator decisions.

## Source map

[Logger](../../../src/observability/logger.ts), [metrics](../../../src/observability/metrics.ts), [QA logger](../../../src/observability/qa-logger.ts), [LLM retry/attempt handling](../../../src/core/llm-adapter/retry.ts), [runtime guide](../../../docs/runtime-guide.md). This audit did not generate QA transcripts or measure live cache/billing metrics.

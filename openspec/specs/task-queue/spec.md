# Task Queue Specification

## Purpose

Describe the legacy persistent background queue, distinct from root chat runs, command jobs and subagent runs. Source audit: 2026-11-17.

## Requirements

### Requirement: Registered handlers and tenant access

enqueue SHALL accept only job types with a registered handler and generate a UUID for the inserted pending record. getStatus(jobId, tenantId) SHALL return the complete matching record or null.

#### Scenario: Unsupported type

- **WHEN** no handler is registered for a requested type
- **THEN** enqueue SHALL reject without admitting a runnable job.
- **WHEN** a tenant queries another tenant's job
- **THEN** it SHALL receive no matching record.

### Requirement: Durable single-owner claim

The queue SHALL poll supported pending work and acquire a persisted pending→running claim before invoking the handler. Only the matching execution claim SHALL commit completion.

#### Scenario: Competing workers

- **WHEN** workers observe the same pending row
- **THEN** only the transaction that wins the pending-state update SHALL perform handler effects.
- **WHEN** a completion acknowledgement is lost
- **THEN** the worker SHALL NOT infer handler failure and replay external effects.

Polling defaults to 1000 ms. One queue instance serializes its own active processing; the persisted claim guards ownership across instances.

### Requirement: Pending-only cancellation

cancel(jobId, tenantId) SHALL change only pending jobs to cancelled and return a boolean indicating a changed row.

#### Scenario: Running job

- **WHEN** cancel is called on a running/done/failed/cancelled or missing record
- **THEN** it SHALL return false
- **AND** SHALL NOT promise termination of a live producer.

### Requirement: Honest startup and shutdown

Constructing a queue SHALL NOT rewrite existing running jobs as failed. Recovery requires authoritative ownership evidence beyond construction.

#### Scenario: Shutdown

- **WHEN** stop is invoked
- **THEN** polling SHALL stop, the active handler's signal SHALL abort, and processing SHALL be awaited
- **AND** failure to acknowledge within 3000 ms SHALL report that external effects remain unknown.
- **WHEN** an earlier execution is still draining
- **THEN** start SHALL reject rather than overlap a new generation.

### Requirement: HTTP service lifecycle and supported executors

The HTTP instance SHALL own its queue lifecycle: start onReady and await stop onClose. The current tasks route does not register production handlers and SHALL reject unsupported submissions with HTTP 501 rather than claim they will execute.

#### Scenario: Default task submission

- **WHEN** POST /tasks names a type absent from the route-owned queue's supportedTypes
- **THEN** the response SHALL indicate no registered executor
- **AND** no runnable job SHALL be admitted.

## Source map

[Queue](../../../src/storage/task-queue/sqlite-queue.ts), [types](../../../src/storage/task-queue/types.ts), [claim schema](../../../src/storage/task-queue/claim-schema.ts), [tests](../../../src/storage/task-queue/__tests__/). This component is not a process-restart replay service and is not guaranteed to be dependency-injected automatically.

# task-queue Specification

## Purpose
TBD - created by archiving change ai-agent-engine. Update Purpose after archive.
## Requirements
### Requirement: Task Enqueueing

The TaskQueue SHALL provide an `enqueue(job)` method that adds a job to the queue and returns a unique `jobId`.

#### Scenario: Successful enqueue
- **WHEN** `enqueue(job)` is called with a valid job payload
- **THEN** the queue SHALL persist the job with status `pending`, assign a unique `jobId` (UUID), and return that `jobId` to the caller

#### Scenario: Enqueue multiple jobs
- **WHEN** `enqueue(job)` is called N times sequentially or concurrently
- **THEN** each call SHALL return a distinct `jobId` and all jobs SHALL appear in the queue with status `pending`

---

### Requirement: Task Status Query

The TaskQueue SHALL provide a `getStatus(jobId)` method that returns the current status of a queued job.

#### Scenario: Query pending job
- **WHEN** `getStatus(jobId)` is called immediately after enqueueing a job that has not yet been picked up
- **THEN** the method SHALL return `pending`

#### Scenario: Query running job
- **WHEN** a worker has started processing a job and `getStatus(jobId)` is called
- **THEN** the method SHALL return `running`

#### Scenario: Query completed job
- **WHEN** a job has finished successfully and `getStatus(jobId)` is called
- **THEN** the method SHALL return `done`

#### Scenario: Query failed job
- **WHEN** a job has terminated with an error and `getStatus(jobId)` is called
- **THEN** the method SHALL return `failed`

#### Scenario: Query unknown jobId
- **WHEN** `getStatus(jobId)` is called with a `jobId` that does not exist
- **THEN** the method SHALL return `null` and SHALL NOT throw an error

---

### Requirement: Task Cancellation

The TaskQueue SHALL provide a `cancel(jobId)` method that attempts to cancel a job before or during execution.

#### Scenario: Cancel pending job
- **WHEN** `cancel(jobId)` is called for a job with status `pending`
- **THEN** the job status SHALL transition to `cancelled` and the job SHALL NOT be executed by any worker

#### Scenario: Cancel running job
- **WHEN** `cancel(jobId)` is called for a job with status `running`
- **THEN** the queue SHALL signal the worker to abort and transition the status to `cancelled`

#### Scenario: Cancel already completed job
- **WHEN** `cancel(jobId)` is called for a job with status `done` or `failed`
- **THEN** the method SHALL return without error and SHALL NOT change the job status

---

### Requirement: Task Persistence

All task state SHALL be stored in SQLite so that job status and payloads survive service restarts.

#### Scenario: Jobs survive restart
- **WHEN** jobs are enqueued and the service is restarted before they are processed
- **THEN** jobs with status `pending` SHALL remain in the queue after restart and SHALL be eligible for processing

#### Scenario: Running jobs on restart
- **WHEN** a job has status `running` at the time of a service restart
- **THEN** the job SHALL be transitioned to `failed` on startup (orphan detection) and the failure reason SHALL note abnormal termination

---

### Requirement: TaskQueue Interface Abstraction

The system SHALL define a `TaskQueue` interface and provide `SQLiteTaskQueue` as the default implementation, allowing alternative implementations to be substituted.

#### Scenario: Interface compliance
- **WHEN** a custom implementation of `TaskQueue` is registered in the dependency injection container
- **THEN** the Agent engine SHALL use the custom implementation for all queue operations without modification to engine code

#### Scenario: Default SQLiteTaskQueue
- **WHEN** no custom `TaskQueue` is configured
- **THEN** the system SHALL use `SQLiteTaskQueue` as the default implementation


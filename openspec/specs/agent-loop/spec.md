# Agent Loop Specification

## Purpose

Describe the implemented ReAct runtime, request budgeting, collaboration and finalization. Audited against current source on 2026-11-17; this specification does not promise a separate JSON-plan/reflection executor.

## Requirements

### Requirement: ReAct execution and admission

The engine SHALL admit a request with trusted tenant/session/workspace identity and execute model/tool iterations through ReAct. A tool result SHALL be recorded before the next model observation. Execution SHALL respect cancellation, pending input/approval and terminal state.

#### Scenario: Ordinary product request

- **WHEN** POST /chat starts a normal root run
- **THEN** it SHALL use an unbounded cumulative RequestBudget and no default iteration cap
- **AND** explicit limits passed to lower-level/internal callers SHALL still be honored
- **AND** legacy MAX_ITERATIONS/TOKEN_BUDGET settings SHALL NOT be described as effective product limits.

### Requirement: Complete request budget

The loop SHALL budget system instructions, tools, history, dynamic request context and output reservation against the effective model window.

#### Scenario: Compaction threshold reached

- **WHEN** the complete estimated request reaches its threshold
- **THEN** the loop SHALL first attempt old tool-output microcompaction, then bounded summary passes if necessary
- **AND** preserve valid tool call/result boundaries and re-read newly admitted messages before sending
- **AND** reject a stale summary commit when the underlying history revision changed.

The default context policy is 268000 tokens, limited by known model capacity and explicit request policy. The default trigger ratio is 0.92 (positive override capped at 0.95); OSM max uses 0.7. Output reservation is not a universal generation-token cap.

### Requirement: Reusable child execution

Built-in research/executor/general roles SHALL share the runtime loop while narrowing capabilities for their assigned purpose. Research SHALL prohibit commands/scripts, mutations and index creation.

#### Scenario: Follow-up to a reusable child

- **WHEN** the directory reports a resumable completed/interrupted child and a valid follow-up is admitted
- **THEN** continuation SHALL use its stored context and current authoritative execution identity
- **AND** a currently active child SHALL receive durable messages instead of a duplicate run.
- **WHEN** the process restarts
- **THEN** stored child runs SHALL NOT automatically replay external effects or be joined as currently owned live producers.

Default parent-session concurrency is 5, capped at 16 by configuration. No implicit 10-minute child deadline is guaranteed. A queued message is not proof of consumption; terminal completion is not proof of success.

### Requirement: Evidence-based final results

The loop SHALL distinguish provisional text, tool outcomes, child reports and published final attachments. Final artifact admission SHALL validate source identity and limits.

#### Scenario: Artifact delivery

- **WHEN** deliver_files publishes root results
- **THEN** at most 16 files, 32 MiB each and 128 MiB total SHALL be admitted by current final-result limits
- **AND** child report_artifacts SHALL remain subordinate evidence for root review.

### Requirement: Auxiliary orchestration boundaries

Cron and Flow SHALL be distinguished from reusable collaboration subagents and the generic task queue. Their source-specific lifecycle and capability limits SHALL not be replaced by an assumption of universal durable execution.

#### Scenario: Authenticated cron deployment

- **WHEN** request authentication is required
- **THEN** cron capabilities SHALL report authenticated dispatch unsupported
- **AND** only explicitly paused configurations can be saved without granting execution.
- **WHEN** startup finds an unadmitted prior cron claim
- **THEN** it SHALL mark the occurrence interrupted rather than replay it.

#### Scenario: Flow DAG execution

- **WHEN** a valid DAG is submitted
- **THEN** nodes SHALL execute by topological level, with siblings settling before a failed level blocks later levels.
- **WHEN** a Flow stop request finds an active entry in the current tenant
- **THEN** it SHALL signal cancellation; the response is not proof that every side effect has stopped.

Current Flow state/stop lookup is in process memory and removed when the SSE handler finishes. There is no durable DAG resume service. Node model/prompt/systemPrompt are consumed, but accepted resource bindings and top-level cwd/security/execution fields are not fully wired by the executor. This limitation must remain visible to callers.

[Runtime scheduling details](../../../docs/runtime-guide.md#调度队列与流程), [cron scheduler](../../../src/scheduler/cron-scheduler.ts), [cron capabilities](../../../src/scheduler/cron-service.ts), [Flow executor](../../../src/api/http/routes/flows/flow-executor.ts), [Flow route](../../../src/api/http/routes/flows/flow-routes.ts).

## Source map

[ReAct](../../../src/core/agent-loop/react.ts), [chat admission](../../../src/api/http/routes/chat.ts), [budget](../../../src/core/context-budget.ts), [child runner](../../../src/core/subagent/runner.ts), [team tools](../../../src/tools/subagent/team-tools.ts), [final result](../../../src/core/final-result.ts). Corresponding tests live beside these modules. This documentation update did not run live model sessions.

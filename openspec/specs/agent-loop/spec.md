# agent-loop Specification

## Purpose
TBD - created by archiving change ai-agent-engine. Update Purpose after archive.
## Requirements
### Requirement: ReAct Loop Execution

The Agent engine SHALL implement the ReAct (Reasoning + Acting) loop pattern, cycling through Think → Act → Observe phases until a terminal condition is reached.

#### Scenario: Successful ReAct iteration within max iterations
- **WHEN** an Agent is invoked with a user message and `maxIterations` is set to N
- **THEN** the engine SHALL execute up to N Think→Act→Observe cycles before returning a final answer

#### Scenario: Max iterations exceeded
- **WHEN** the Agent has completed N iterations without reaching a final answer and `maxIterations` equals N
- **THEN** the engine SHALL stop the loop and return an error response with code `MAX_ITERATIONS_EXCEEDED` and include the last observation in the error payload

#### Scenario: Terminal condition reached before max iterations
- **WHEN** the LLM produces a final answer token (no tool call) during the Think phase
- **THEN** the engine SHALL exit the loop immediately and return the final answer without executing further iterations

#### Scenario: Act phase tool invocation
- **WHEN** the Think phase produces a tool call
- **THEN** the engine SHALL invoke the named tool via ToolRegistry and record the result as the next Observe input

---

### Requirement: Plan Mode Support

The Agent engine SHALL support a Plan Mode in which it first generates a multi-step plan as a JSON structure and then executes each step sequentially.

#### Scenario: Plan generation
- **WHEN** Plan Mode is enabled and the Agent receives a complex task
- **THEN** the engine SHALL call the LLM once to generate a JSON plan containing an ordered array of steps, each with `stepId`, `description`, and `toolName`

#### Scenario: Sequential plan execution
- **WHEN** a plan has been generated with M steps
- **THEN** the engine SHALL execute steps in order from index 0 to M-1, passing the output of step N as context input to step N+1

#### Scenario: Dynamic plan adjustment
- **WHEN** a step execution returns an unexpected result that invalidates subsequent steps
- **THEN** the engine SHALL re-invoke the LLM to regenerate the remaining plan steps and continue execution with the revised plan

#### Scenario: Plan serialization
- **WHEN** Plan Mode generates a plan
- **THEN** the plan JSON MUST be stored in the session context and retrievable via `getSessionPlan(ctx)`

---

### Requirement: Agent Reflection Mechanism

After completing plan execution the Agent SHALL evaluate the overall result and, if the goal is not met, SHALL trigger re-planning.

#### Scenario: Successful reflection — goal achieved
- **WHEN** all plan steps have been executed and the reflection LLM call determines the goal is achieved
- **THEN** the engine SHALL return the final result without re-planning

#### Scenario: Reflection triggers re-planning
- **WHEN** all plan steps have been executed and the reflection LLM call determines the goal is NOT fully achieved
- **THEN** the engine SHALL generate a new plan for the remaining sub-goal and execute it, up to a configurable `maxReflectionRounds` limit

#### Scenario: Max reflection rounds exceeded
- **WHEN** `maxReflectionRounds` re-planning cycles have been completed and the goal is still not achieved
- **THEN** the engine SHALL return a partial result with a `REFLECTION_LIMIT_REACHED` warning flag

---

### Requirement: Token Budget Enforcement

The Agent loop SHALL monitor cumulative token usage and stop execution when the configured `tokenBudget` is exhausted.

#### Scenario: Token budget not exhausted
- **WHEN** cumulative `promptTokens + completionTokens` remains below `tokenBudget` after each LLM call
- **THEN** the engine SHALL continue the loop normally

#### Scenario: Token budget exhausted mid-loop
- **WHEN** cumulative token usage meets or exceeds `tokenBudget` after an LLM call
- **THEN** the engine SHALL immediately stop the loop, return all output produced so far, and include a `truncated: true` flag in the response metadata

#### Scenario: Token budget configured at zero or unlimited
- **WHEN** `tokenBudget` is set to `0` or not provided
- **THEN** the engine SHALL apply no token limit and run until a terminal condition or `maxIterations` is reached


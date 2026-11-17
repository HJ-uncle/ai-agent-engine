# Tool Registry Specification

## Purpose

Describe registration, model-facing definitions, capability filtering and execution preflight. Source audit: 2026-11-17.

## Requirements

### Requirement: Unique registration and capability filter

ToolRegistry SHALL store tools by name. A constructor-supplied canRegister predicate MAY reject a tool before insertion. Duplicate accepted names SHALL throw DuplicateToolError.

#### Scenario: Rejected capability

- **WHEN** canRegister returns false
- **THEN** register SHALL leave the tool absent
- **AND** dynamic registration SHALL NOT bypass the capability ceiling.

The registry itself does not validate a universal tool-name syntax. Specific plugin/MCP factories may impose or normalize names separately.

### Requirement: Safe removal and lookup

unregister SHALL remove the tool, custom model definition and loaded-model state. Removing a missing tool SHALL be harmless.

#### Scenario: Missing execution target

- **WHEN** execute is called for an absent tool
- **THEN** it SHALL throw ToolNotFoundError.
- **WHEN** a handler throws
- **THEN** the registry SHALL propagate that error rather than promise a generic ToolExecutionError wrapper.

### Requirement: Model exposure is distinct from registration

The registry SHALL preserve full executable schemas and optional compact model definitions. listForRequest MAY expose core tools plus loaded/history-required tools rather than every registered definition.

#### Scenario: On-demand loading

- **WHEN** the trusted load_tools implementation selects an eligible registered tool
- **THEN** it SHALL expand model visibility
- **AND** SHALL NOT authorize a tool excluded from registration.
- **WHEN** a tool is removed/replaced
- **THEN** registration identity and invalidated history SHALL prevent stale definitions from being treated as unchanged.

### Requirement: Preflight and concurrency

Execution SHALL perform security preflight before entering ordinary tool concurrency and again after obtaining a pooled slot. Trusted orchestration calls MAY bypass the ordinary pool to avoid child/tool deadlock.

#### Scenario: Permission changed while queued

- **WHEN** a queued tool no longer passes preflight when its slot becomes available
- **THEN** it SHALL return the blocked result without invoking the handler.

Only trusted builtin implementations SHALL qualify for evidence projection, office/screenshot evidence and privileged loading behavior; extension names alone are insufficient.

## Source map

[Registry](../../../src/core/tool-registry/registry.ts), [factory](../../../src/tools/registry-factory.ts), [policy](../../../src/security/tool-policy.ts), [model loading](../../../src/tools/model-tool-loading.ts), [tests](../../../src/core/tool-registry/__tests__/registry.test.ts). Canonical builtin names are indexed in [system tools](../../../docs/docs/system-tools.md).

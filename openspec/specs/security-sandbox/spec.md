# Security Policy Specification

## Purpose

Describe implemented identity, capability, command, network and approval boundaries without claiming an operating-system sandbox for arbitrary host programs. Source audit: 2026-11-17.

## Requirements

### Requirement: Trusted identity and capability ceilings

Authenticated identity, tenant, workspace and tool capability SHALL be resolved by trusted server paths. Chat text SHALL NOT grant roles or management capabilities.

#### Scenario: Child execution

- **WHEN** a subagent is admitted
- **THEN** it SHALL inherit constrained trusted parent identity/resources
- **AND** SHALL NOT obtain root-only management packages through load_tools.

### Requirement: Explicit security-mode semantics

The default mode SHALL be standard. An invalid DEFAULT_SECURITY_MODE SHALL fall back to safe. Runtime session overrides and command approvals currently reside in memory.

#### Scenario: Ordinary policy decision

- **WHEN** an ordinary rule says ask
- **THEN** safe SHALL ask, while standard/full-access SHALL allow.
- **WHEN** an ordinary rule says deny
- **THEN** safe SHALL deny, standard SHALL ask and full-access SHALL bypass that ordinary rule.

#### Scenario: Hard deletion boundary

- **WHEN** a command matches a hard deletion or detected inline deletion pattern
- **THEN** all three modes SHALL reject it and direct execution to the recorded delete_file path
- **AND** previous command approval SHALL NOT bypass the check.

Static command scanning does not identify every possible script side effect. A working directory is not an OS-level filesystem/network sandbox.

### Requirement: Guarded HTTP

Guarded HTTP SHALL check URL targets and redirect hops, bound response size and pin validated DNS destinations.

#### Scenario: Default guarded request

- **WHEN** default network policy applies
- **THEN** only HTTP/HTTPS SHALL be accepted, private addresses and metadata endpoints SHALL be restricted
- **AND** current defaults SHALL be 5 MiB response, 30-second timeout, 300-second DNS cache and at most 5 redirects.

These checks are not a claim that every SDK, browser, MCP server or shell process uses guarded HTTP. Full-access has its own policy behavior.

### Requirement: Frozen approval and honest rollback

Pending approval SHALL bind the original operation and identity. Approval SHALL NOT grant unrelated later changes. File rollback SHALL check recorded ownership and current state.

#### Scenario: Conflicting current file

- **WHEN** a file differs from the recorded revertable state or has later changes
- **THEN** rollback SHALL surface a conflict rather than overwrite it blindly.

## Source map

[Policy engine](../../../src/security/policy-engine.ts), [network policy](../../../src/security/network-policy.ts), [guarded HTTP](../../../src/security/guarded-http.ts), [tool policy](../../../src/security/tool-policy.ts), [security routes](../../../src/api/http/routes/security.ts), [architecture guide](../../../docs/security-architecture.md). This audit is not a penetration-test certification.

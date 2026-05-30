# security-sandbox Specification

## Purpose
TBD - created by archiving change ai-agent-engine. Update Purpose after archive.
## Requirements
### Requirement: CMD Whitelist Enforcement

The SecuritySandbox SHALL maintain a whitelist of permitted commands and SHALL reject any execution request for commands not on the whitelist.

#### Scenario: Whitelisted command allowed
- **WHEN** `execute(cmd, args, ctx)` is called with a command that appears in the configured `allowedCommands` list
- **THEN** the sandbox SHALL proceed with execution

#### Scenario: Non-whitelisted command rejected
- **WHEN** `execute(cmd, args, ctx)` is called with a command that does NOT appear in `allowedCommands`
- **THEN** the sandbox SHALL return a `CommandNotAllowedError` containing the attempted command name and SHALL NOT spawn any process

#### Scenario: Empty whitelist blocks all commands
- **WHEN** `allowedCommands` is configured as an empty array
- **THEN** every `execute` call SHALL be rejected with `CommandNotAllowedError`

---

### Requirement: Execution Timeout

Command execution SHALL be subject to a configurable timeout. Processes exceeding the timeout MUST be forcefully terminated.

#### Scenario: Command completes within timeout
- **WHEN** a whitelisted command completes within `timeoutMs` milliseconds
- **THEN** the sandbox SHALL return the command's stdout and exit code normally

#### Scenario: Command exceeds timeout
- **WHEN** a command's execution time exceeds `timeoutMs` milliseconds
- **THEN** the sandbox SHALL send SIGKILL to the child process, wait for it to terminate, and return an `ExecutionTimeoutError` with the configured timeout value

#### Scenario: Default timeout applied
- **WHEN** no `timeoutMs` is specified per-call
- **THEN** the sandbox SHALL apply the globally configured `defaultTimeoutMs` value

---

### Requirement: Shell Mode Prohibition

The SecuritySandbox MUST NOT spawn processes using `shell: true` to prevent shell injection attacks.

#### Scenario: Direct process spawn
- **WHEN** the sandbox spawns any child process
- **THEN** it SHALL use `child_process.spawn(cmd, args, { shell: false })` or equivalent, ensuring arguments are passed as an array and never interpolated into a shell string

#### Scenario: Shell metacharacters in arguments
- **WHEN** a command argument contains shell metacharacters (e.g., `;`, `|`, `&&`, `` ` ``)
- **THEN** the sandbox SHALL pass these characters as literal argument strings to the spawned process without shell interpretation

---

### Requirement: File Path Isolation

All file path arguments passed to sandboxed commands SHALL be validated to ensure they resolve within the session's `workspaceDir`.

#### Scenario: Path within workspace allowed
- **WHEN** a file path argument resolves to a location inside `workspaceDir`
- **THEN** the sandbox SHALL allow the path to be used

#### Scenario: Path outside workspace rejected
- **WHEN** a file path argument resolves to a location outside `workspaceDir` (including via `..` traversal or absolute paths)
- **THEN** the sandbox SHALL reject the execution with a `PathTraversalError` and SHALL NOT spawn any process

---

### Requirement: Quota Check

Before executing any command, the SecuritySandbox SHALL verify that the requesting tenant has sufficient remaining quota.

#### Scenario: Sufficient quota
- **WHEN** `execute(cmd, args, ctx)` is called and `ctx.tenantId` has remaining quota greater than zero
- **THEN** the sandbox SHALL decrement the quota by one and proceed with execution

#### Scenario: Quota exhausted
- **WHEN** `execute(cmd, args, ctx)` is called and `ctx.tenantId` has zero remaining quota
- **THEN** the sandbox SHALL return a `QuotaExceededError` and SHALL NOT spawn any process

#### Scenario: Quota check before whitelist
- **WHEN** both quota is exhausted and the command is not whitelisted
- **THEN** the sandbox SHALL return `QuotaExceededError` (quota check takes precedence and is evaluated first)


# OSM Mode Specification

## Purpose

Describe the current OpenSpec Methodology configuration that supersedes the old boolean superpower description. Work/Code tool profile and security mode are separate settings. Source audit: 2026-11-17.

## Requirements

### Requirement: Current mode resolution

The engine SHALL support off, balanced, methodology and max through the resolver in osm.ts.

#### Scenario: Configured mode

- **WHEN** OSM_MODE is nonempty, otherwise SUPERPOWER_MODE is nonempty, and the selected value is valid
- **THEN** that mode SHALL be used.
- **WHEN** the selected mode is invalid
- **THEN** the resolver SHALL warn and consult the legacy boolean.
- **WHEN** SUPERPOWER_ENABLED=true and no valid selected mode exists
- **THEN** methodology SHALL be used.
- **OTHERWISE** balanced SHALL be the effective fallback, including legacy false/unset.

Some source comments still mention off as the fallback; the return value is authoritative.

### Requirement: Separate method and capability controls

off SHALL narrow the default tool set. balanced SHALL not inject methodology. methodology/max SHALL enable the methodology bootstrap and artifact directories.

#### Scenario: Capability ceiling remains

- **WHEN** balanced/methodology/max is selected
- **THEN** profile, explicit allowedTools, selected management packages and trusted security checks SHALL still apply
- **AND** allowAllTools metadata SHALL NOT be interpreted as all registered tools being universally authorized.

### Requirement: Budget effects follow actual callers

Documentation SHALL distinguish legacy multiplier helpers from active request limits.

#### Scenario: Normal chat

- **WHEN** a normal chat run starts
- **THEN** its cumulative RequestBudget SHALL remain unbounded by default
- **AND** old multiplier table fields SHALL NOT imply an automatic finite total-token/iteration cap.

Work tool-output defaults are 4000 characters multiplied by 1/2/2/4 for off/balanced/methodology/max. Code uses its independent default of 65536 characters. max uses a 0.7 context-compression trigger, which means earlier compaction than the normal 0.92.

## Source map

[Mode resolution/config](../../../src/core/osm.ts), [tool output limit](../../../src/core/agent-loop/tool-output-limit.ts), [context factory](../../../src/core/agent-context/factory.ts), [chat](../../../src/api/http/routes/chat.ts), [methodology specification](../superpower-methodology/spec.md). Old src/core/superpower.ts and a separate multi-agent-console are not current implementation anchors.

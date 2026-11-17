# OSM Methodology Specification

## Purpose

Describe method-specific skill visibility, bootstrap injection and workspace artifacts. This is prompt guidance rather than a separate deterministic planning/verification engine. Source audit: 2026-11-17.

## Requirements

### Requirement: Mode-gated methodology

Only methodology and max SHALL inject the OSM bootstrap. off/balanced SHALL return no bootstrap block and hide os-* methodology skills.

#### Scenario: Default Work session

- **WHEN** the effective mode is balanced
- **THEN** OSM method prompts SHALL NOT be injected
- **AND** ordinary project/office skills SHALL remain subject to their own binding and permission rules.

Work versus Code alone does not determine OSM status.

### Requirement: Current bootstrap and fallback

The bootstrap SHALL read os-using-superpowers and wrap it in <OSM-ACTIVE> markers. Other method skills SHALL be loaded on demand rather than concatenated into every request.

#### Scenario: Missing entry skill

- **WHEN** methodology/max is active but os-using-superpowers is absent or empty
- **THEN** the engine SHALL warn once and inject the static methodology fallback
- **AND** SHALL NOT claim that injection silently becomes empty.

Skill content is obtained through the registry/read path for each request; reload behavior depends on that registry. The current skill prefix is os-, not superpower-.

### Requirement: Workspace artifacts

Methodology/max context creation SHALL prepare the .ae/openspec/changes workspace structure. Creating that structure SHALL not be described as proof that a specification, plan, review or test has been completed.

#### Scenario: User direction

- **WHEN** user instructions conflict with method guidance
- **THEN** the method's own stated user-priority rule SHALL apply
- **AND** prompt guidance SHALL NOT expand tool, workspace or identity authority.

Method skills describe brainstorming, planning, TDD, debugging, verification and delegation patterns. The engine does not guarantee these outcomes solely because a prompt was injected.

## Source map

[Bootstrap](../../../src/core/osm-bootstrap.ts), [mode/visibility](../../../src/core/osm.ts), [context factory](../../../src/core/agent-context/factory.ts), [skills registry](../../../src/skills/index.ts). Built-in office skill prompts were inspected for integration but were not modified by this documentation refresh.

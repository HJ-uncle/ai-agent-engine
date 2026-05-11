# superpower-mode Specification

## Purpose

Defines the four-tier **Superpower mode enum** (`off` / `balanced` /
`methodology` / `max`) that controls the agent engine's resource budgets,
tool-set exposure, compression thresholds, and methodology injection.

The mode is the single source of truth every downstream consumer (tool
registry, agent loop, agent-context factory, chat/messages routes,
settings API, front-end) branches on. It supersedes the legacy boolean
`SUPERPOWER_ENABLED` switch and is hot-reloadable via `PUT /settings`.

Reference implementation lives in `src/core/superpower.ts`; front-end
integration in `multi-agent-console/src/web/components/settings/GeneralSettings.tsx`.

## Requirements

### Requirement: Superpower mode enum

The system SHALL expose a `SuperpowerMode` enum with exactly four values:
`off`, `balanced`, `methodology`, `max`. This enum SHALL be the single
source of truth for every downstream consumer (tool registry, agent
loop, agent-context factory, chat/messages routes, settings API,
front-end). No consumer SHALL branch on any other string or boolean to
derive superpower behaviour.

#### Scenario: Enum values exported

- **WHEN** a module imports `SuperpowerMode` from `src/core/superpower.ts`
- **THEN** it receives exactly `'off' | 'balanced' | 'methodology' | 'max'`
- **AND** attempting to use any other value SHALL produce a TypeScript
  compile error

#### Scenario: Default mode when nothing configured

- **WHEN** neither `SUPERPOWER_MODE` nor `SUPERPOWER_ENABLED` is set in
  the environment
- **THEN** `resolveSuperpowerMode()` SHALL return `'off'`
- **AND** the agent SHALL behave identically to today's OFF baseline
  (CORE tools only, baseline numeric budgets, no methodology injection)

### Requirement: Mode resolution reads live environment

The function `resolveSuperpowerMode()` SHALL read `process.env` on every
call so that `PUT /settings` (which syncs `process.env` in-process) is
picked up without a restart. It SHALL NOT cache the value in module
state. This mirrors the existing hot-reload contract for
`SUPERPOWER_ENABLED` preserved today in `src/api/http/routes/settings.ts`.

#### Scenario: Hot reload after settings change

- **WHEN** the user updates `SUPERPOWER_MODE` from `off` to `max` via
  `PUT /settings`
- **AND** the settings route writes the value to both the database
  AND `process.env.SUPERPOWER_MODE`
- **THEN** the next call to `resolveSuperpowerMode()` SHALL return
  `'max'` without any code reload

#### Scenario: Legacy switch hot reloads

- **WHEN** the user toggles `SUPERPOWER_ENABLED=true` via `PUT /settings`
- **AND** `SUPERPOWER_MODE` is unset
- **THEN** the next call to `resolveSuperpowerMode()` SHALL return
  `'methodology'` (the legacy ON alias defined below)

### Requirement: Legacy SUPERPOWER_ENABLED alias with deprecation

The system SHALL honour legacy `SUPERPOWER_ENABLED` for one release
cycle (deprecated, removal scheduled in the next minor) according to
the following precedence:

1. If `SUPERPOWER_MODE` is a recognised value (`off`/`balanced`/
   `methodology`/`max`), it wins — legacy env is ignored.
2. Else if `SUPERPOWER_ENABLED=true`, mode SHALL be `methodology`.
3. Else if `SUPERPOWER_ENABLED=false` (or any other string), mode
   SHALL be `off`.
4. Else (both unset) mode SHALL be `off`.

When legacy env is the reason a non-`off` mode was selected, the system
SHALL emit a deprecation warning to the logger **at most once per
process** (guarded by a module-level flag), naming the legacy key and
pointing to `SUPERPOWER_MODE`.

#### Scenario: MODE wins over ENABLED

- **WHEN** `SUPERPOWER_MODE=balanced` and `SUPERPOWER_ENABLED=true` are
  both set
- **THEN** `resolveSuperpowerMode()` SHALL return `'balanced'`
- **AND** no deprecation warning SHALL be emitted

#### Scenario: Legacy true maps to methodology

- **WHEN** only `SUPERPOWER_ENABLED=true` is set
- **THEN** `resolveSuperpowerMode()` SHALL return `'methodology'`
- **AND** the logger SHALL receive a `warn`-level entry once per process
  mentioning that `SUPERPOWER_ENABLED` is deprecated in favour of
  `SUPERPOWER_MODE`

#### Scenario: Invalid MODE value falls back to legacy then off

- **WHEN** `SUPERPOWER_MODE=turbo` (unknown) and `SUPERPOWER_ENABLED`
  is unset
- **THEN** `resolveSuperpowerMode()` SHALL return `'off'`
- **AND** the logger SHALL receive a `warn`-level entry naming the
  unrecognised value

#### Scenario: Deprecation warning fires at most once

- **WHEN** `resolveSuperpowerMode()` is called ten times in the same
  process with legacy-only env (`SUPERPOWER_ENABLED=true`)
- **THEN** the logger SHALL have received exactly one deprecation
  warning

### Requirement: Per-mode numeric multipliers

`applySuperpowerMultiplier(field, base)` SHALL return `Math.floor(base * M)`
where `M` is looked up by the current mode:

| field              | off | balanced | methodology | max |
|--------------------|-----|----------|-------------|-----|
| tokenBudget        | 1   | 2        | 2           | 5   |
| maxIterations      | 1   | 2        | 2           | 4   |
| toolOutputMaxChars | 1   | 2        | 2           | 4   |
| historyMaxTokens   | 1   | 2        | 2           | 4   |

Mode `off` SHALL always return `base` unchanged. No other field name
SHALL be silently accepted; the function's type signature SHALL restrict
`field` to the declared keys.

#### Scenario: Off mode returns base

- **WHEN** mode is `off` and `applySuperpowerMultiplier('tokenBudget', 60000)`
  is called
- **THEN** the return value SHALL be exactly `60000`

#### Scenario: Balanced and methodology share multiplier

- **WHEN** mode is `balanced` or `methodology` and
  `applySuperpowerMultiplier('tokenBudget', 60000)` is called
- **THEN** the return value SHALL be `120000`

#### Scenario: Max applies the largest multiplier

- **WHEN** mode is `max` and `applySuperpowerMultiplier('maxIterations', 50)`
  is called
- **THEN** the return value SHALL be `200`

### Requirement: Per-mode tool-set filtering

`resolveDefaultAllowedTools(explicit)` SHALL produce the effective
allow-list according to the mode:

- `off`: returns `[...SUPERPOWER_CORE_TOOLS]` when `explicit` is
  `undefined`/`null`; returns `explicit ∩ CORE` when `explicit` is a
  non-empty list (falling back to `CORE` if the intersection is empty);
  returns `[]` when `explicit` is an empty array.
- `balanced` / `methodology` / `max`: SHALL fully respect `explicit`
  (including `undefined` meaning "all tools") without any narrowing.

The invariant "`CORE ∩ ONLY = ∅`" SHALL be preserved and checked by
`runSuperpowerSelfCheck` at boot.

#### Scenario: Off narrows missing explicit to CORE

- **WHEN** mode is `off` and caller passes `allowedTools = undefined`
- **THEN** the returned list SHALL equal the `SUPERPOWER_CORE_TOOLS` set

#### Scenario: Balanced leaves explicit untouched

- **WHEN** mode is `balanced` and caller passes
  `allowedTools = ['read_file', 'run_command']`
- **THEN** the returned list SHALL be `['read_file', 'run_command']`
  without any narrowing or expansion

#### Scenario: Max allows everything by default

- **WHEN** mode is `max` and caller passes `allowedTools = undefined`
- **THEN** the returned value SHALL be `undefined` (meaning "register
  all tools" per existing registry-factory contract)

### Requirement: Per-mode compression threshold ratio

`getSuperpowerCompressRatio(baseRatio)` SHALL return:

- `0.7` when mode is `max`
- `baseRatio` unchanged when mode is `off`, `balanced`, or `methodology`

#### Scenario: Max loosens the compression trigger

- **WHEN** mode is `max` and `getSuperpowerCompressRatio(0.5)` is called
- **THEN** the return value SHALL be `0.7`

#### Scenario: Methodology keeps the caller ratio

- **WHEN** mode is `methodology` and `getSuperpowerCompressRatio(0.5)`
  is called
- **THEN** the return value SHALL be `0.5`

### Requirement: Legacy isSuperpowerEnabled preserves existing semantics

`isSuperpowerEnabled()` SHALL remain exported and return `mode !== 'off'`
so existing call sites that only care about coarse ON/OFF continue to
work without modification. It SHALL be annotated `@deprecated` in JSDoc
with a pointer to `resolveSuperpowerMode()`.

#### Scenario: Off returns false

- **WHEN** mode is `off` and `isSuperpowerEnabled()` is called
- **THEN** it SHALL return `false`

#### Scenario: Any non-off returns true

- **WHEN** mode is `balanced`, `methodology`, or `max`
- **THEN** `isSuperpowerEnabled()` SHALL return `true`

### Requirement: Settings API exposes the mode

`GET /settings` SHALL include a `SUPERPOWER_MODE` field whose value is
the resolved mode (legacy env is translated on the way out). `PUT
/settings` SHALL accept either `SUPERPOWER_MODE` (preferred) or legacy
`SUPERPOWER_ENABLED` and SHALL sync the written value back to
`process.env` so hot-reload works. Writing both in the same request
SHALL be rejected with `400` to prevent ambiguity.

#### Scenario: GET returns resolved mode even for legacy envs

- **WHEN** only `SUPERPOWER_ENABLED=true` is stored and `GET /settings`
  is called
- **THEN** the response body SHALL include `SUPERPOWER_MODE: 'methodology'`

#### Scenario: PUT sets mode and hot-reloads

- **WHEN** client sends `PUT /settings { SUPERPOWER_MODE: 'max' }`
- **THEN** the server SHALL persist it, update
  `process.env.SUPERPOWER_MODE = 'max'`, and respond `200`
- **AND** the subsequent request SHALL see mode `max` without restart

#### Scenario: Conflicting keys rejected

- **WHEN** client sends `PUT /settings` with both `SUPERPOWER_MODE` and
  `SUPERPOWER_ENABLED`
- **THEN** the server SHALL respond `400` with an error message naming
  the conflict
- **AND** no value SHALL be persisted

### Requirement: Front-end segmented control replaces Switch

`GeneralSettings.tsx` SHALL render a segmented control with the four
labels `Off / Balanced / Methodology / Max` bound to `SUPERPOWER_MODE`,
replacing the existing boolean `Switch`. Switching INTO `max` SHALL
trigger a confirmation modal listing the risks (×5 multipliers, all
tools, loosened compression). Switching to any other mode SHALL NOT
require confirmation.

#### Scenario: Entering max shows confirmation

- **WHEN** the user clicks the `Max` segment while currently on any
  other mode
- **THEN** a confirmation modal SHALL appear requiring explicit
  acknowledgement before the change is persisted
- **AND** clicking Cancel SHALL leave the previous mode intact

#### Scenario: Leaving max does not prompt

- **WHEN** the user clicks `Balanced` while currently on `Max`
- **THEN** the change SHALL be persisted immediately without a modal

#### Scenario: Methodology indicator visible

- **WHEN** the active mode is `methodology` or `max`
- **THEN** the settings UI SHALL display a small "Methodology active"
  indicator adjacent to the control

### Requirement: Boot-time self-check validates tool classification

`runSuperpowerSelfCheck(registry)` SHALL continue to be invoked at
registry factory time (when `effectiveAllowedTools === undefined`) and
SHALL verify:

- `SUPERPOWER_CORE_TOOLS ∩ SUPERPOWER_ONLY_TOOLS = ∅`
- Every name in `SUPERPOWER_CORE_TOOLS` is present in the live registry
- Any tool in the registry not classified in either set is reported at
  `debug` level

Violations SHALL be logged at `warn` level but SHALL NOT abort startup.

#### Scenario: Disjoint violation logged

- **WHEN** `SUPERPOWER_CORE_TOOLS` and `SUPERPOWER_ONLY_TOOLS` share a
  name (e.g. due to a refactor mistake)
- **THEN** the boot log SHALL contain a `warn` entry listing the
  duplicated names

#### Scenario: Missing core tool logged

- **WHEN** `SUPERPOWER_CORE_TOOLS` names a tool that is not registered
- **THEN** the boot log SHALL contain a `warn` entry listing the
  missing name(s)
- **AND** startup SHALL NOT throw

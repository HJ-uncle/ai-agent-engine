## ADDED Requirements

### Requirement: Methodology skill pack

The system SHALL ship exactly 7 methodology skills under `SKILLs/`,
each with its own directory and `SKILL.md`. Every skill SHALL use
agent-engine's real tool names (`run_command`, `smart_read`,
`read_file`, `write_file`, `grep`, `glob`, `subagent`, `ask_user`,
`todo_create`, `todo_update`, `code_diagnose`, etc.) — never Claude
Code's `Bash`/`Read`/`Task` aliases. The 7 required skills are:

1. `superpower-using-superpowers` — bootstrap + skill-discovery rules
2. `superpower-brainstorming` — Socratic design with `<HARD-GATE>`
3. `superpower-writing-plans` — bite-sized TDD task plans
4. `superpower-tdd` — RED/GREEN/REFACTOR iron-law enforcement
5. `superpower-systematic-debugging` — 4-phase root-cause process
6. `superpower-subagent-driven-dev` — fresh-subagent-per-task with
   spec + code-quality dual review
7. `superpower-verification-before-completion` — evidence-based
   completion gate

Each `SKILL.md` SHALL include YAML frontmatter with at least `name`,
`description`, and `order` fields so the existing external-skills
loader picks it up.

#### Scenario: All seven directories present

- **WHEN** the repository is checked out
- **THEN** `SKILLs/superpower-using-superpowers/SKILL.md`,
  `SKILLs/superpower-brainstorming/SKILL.md`,
  `SKILLs/superpower-writing-plans/SKILL.md`,
  `SKILLs/superpower-tdd/SKILL.md`,
  `SKILLs/superpower-systematic-debugging/SKILL.md`,
  `SKILLs/superpower-subagent-driven-dev/SKILL.md`, and
  `SKILLs/superpower-verification-before-completion/SKILL.md` SHALL
  all exist as regular files

#### Scenario: Skills use agent-engine tool names only

- **WHEN** any `SKILLs/superpower-*/SKILL.md` content is grepped for
  Claude Code tool aliases (`\bBash\b`, `\bRead\b`, `\bTask\b`,
  `\bWrite\b`, `\bGrep\b`, `\bGlob\b`, `\bEdit\b`)
- **THEN** no matches SHALL be found in any of the 7 skill files

#### Scenario: Loader discovers the skill pack

- **WHEN** the engine starts with default `SKILLS_ROOT=./skills`
  containing the 7 superpower-* directories
- **THEN** `skillsRegistry.getSkills()` SHALL return entries whose
  names include all seven `superpower-*` identifiers
- **AND** these entries SHALL be selectable via the existing
  `allowedSkills` request parameter

### Requirement: Bootstrap auto-injection for methodology and max

The system SHALL auto-inject a methodology bootstrap into the outgoing
system prompt whenever the resolved mode is `methodology` or `max`.

When the resolved superpower mode is `methodology` or `max`, the system
SHALL prepend the full content of
`SKILLs/superpower-using-superpowers/SKILL.md` to the outgoing
`baseSystemPrompt` in both `POST /chat` and `POST /messages` routes,
exactly once per request. The bootstrap block SHALL be separated from
the caller's system prompt with a clear delimiter
(`\n\n---\n\n`) to aid model parsing.

When the resolved mode is `off` or `balanced`, NO bootstrap SHALL be
injected (it is the user's opt-in contract that "balanced" unlocks
tools but keeps behaviour unchanged).

The bootstrap content SHALL be read through `skillsRegistry` (same
source of truth as the `get_skill` tool) so that any edits to the
SKILL.md file are hot-reloaded without a server restart.

#### Scenario: Methodology injects bootstrap

- **WHEN** mode is `methodology` and a chat request arrives with
  `baseSystemPrompt = "You are a helpful assistant."`
- **THEN** the actual system prompt sent to the model SHALL start
  with the `superpower-using-superpowers` SKILL.md content followed
  by the delimiter and then `"You are a helpful assistant."`

#### Scenario: Balanced does NOT inject bootstrap

- **WHEN** mode is `balanced` and a chat request arrives
- **THEN** the system prompt sent to the model SHALL be identical to
  `baseSystemPrompt` with no superpower content prepended

#### Scenario: Off does NOT inject bootstrap

- **WHEN** mode is `off` and a chat request arrives
- **THEN** the system prompt SHALL be identical to `baseSystemPrompt`

#### Scenario: Max injects bootstrap

- **WHEN** mode is `max` and a chat request arrives
- **THEN** the system prompt SHALL have the bootstrap prepended
  identically to the methodology case

#### Scenario: Bootstrap hot reloads from SKILL.md

- **WHEN** an operator edits `SKILLs/superpower-using-superpowers/SKILL.md`
  on disk while the server is running
- **AND** the `skillsRegistry` reload is triggered (existing mechanism)
- **THEN** the next request in `methodology`/`max` mode SHALL inject
  the updated content

#### Scenario: Bootstrap missing degrades gracefully

- **WHEN** mode is `methodology` but the `superpower-using-superpowers`
  skill directory is absent from `SKILLS_ROOT`
- **THEN** the route SHALL log a `warn` entry once per process
- **AND** SHALL continue serving the request with an empty bootstrap
  (no prepend, no error to client)

### Requirement: Product-artifact directories created on workspace init

The system SHALL materialise the canonical `docs/superpower/` artifact
triad on workspace initialisation whenever the mode requires
methodology.

When `resolveSuperpowerMode()` returns `methodology` or `max`, the
agent-context factory SHALL ensure the following three directories
exist under the session's workspace root:

```
<workspaceDir>/docs/superpower/specs/
<workspaceDir>/docs/superpower/plans/
<workspaceDir>/docs/superpower/reviews/
```

Creation SHALL be idempotent (existing directories are left untouched)
and SHALL NOT fail the request if the filesystem rejects the write —
a `warn` log is sufficient. When the mode is `off` or `balanced`,
NO directories SHALL be created (to avoid polluting workspaces that
opted out of methodology).

#### Scenario: Methodology creates the triad

- **WHEN** a new agent-context is created in `methodology` mode with
  a fresh workspace
- **THEN** the three directories above SHALL exist after
  context initialization

#### Scenario: Balanced creates no directories

- **WHEN** a new agent-context is created in `balanced` mode
- **THEN** `docs/superpower/` SHALL NOT be created by the factory

#### Scenario: Existing directories untouched

- **WHEN** an agent-context is created in `methodology` mode and the
  three directories already exist with pre-existing files
- **THEN** the pre-existing files SHALL remain intact
- **AND** no exception SHALL be raised

#### Scenario: Filesystem error is non-fatal

- **WHEN** the workspace is read-only in `methodology` mode
- **THEN** the factory SHALL log a `warn` entry naming the failed path
- **AND** SHALL still return a usable agent-context

### Requirement: Subagent tool exposes a role parameter

The `subagent` tool schema SHALL accept an optional
`role: 'implementer' | 'spec-reviewer' | 'code-quality-reviewer'`
field. When `role` is provided, the tool handler SHALL:

1. Load the matching prompt template bundled with the
   `superpower-subagent-driven-dev` skill:
   - `implementer` → `implementer-prompt.md`
   - `spec-reviewer` → `spec-reviewer-prompt.md`
   - `code-quality-reviewer` → `code-quality-reviewer-prompt.md`
2. Prepend the template to the caller's `prompt` argument.
3. Pass the combined prompt to the child agent as its system message.

When `role` is omitted, existing behaviour SHALL be preserved exactly
— no template loaded, no prompt modification. If a provided `role` is
valid but the template file is missing, the handler SHALL fall back to
existing behaviour and emit a `warn` log.

#### Scenario: Role-less call unchanged

- **WHEN** `subagent` is called without a `role` field
- **THEN** the tool SHALL behave identically to today (no template
  loaded, prompt forwarded verbatim)

#### Scenario: Implementer role loads template

- **WHEN** `subagent` is called with `role: 'implementer'` and
  `prompt: 'Implement ticket X'`
- **THEN** the child agent's system prompt SHALL start with the
  content of
  `SKILLs/superpower-subagent-driven-dev/implementer-prompt.md`
- **AND** SHALL be followed by `'Implement ticket X'`

#### Scenario: Unknown role rejected

- **WHEN** `subagent` is called with `role: 'architect'` (not in the
  allowed enum)
- **THEN** the tool SHALL return an input-validation error
- **AND** no child agent SHALL be spawned

#### Scenario: Missing template degrades to default

- **WHEN** `subagent` is called with a valid role whose template file
  has been deleted
- **THEN** the tool SHALL log a `warn` naming the missing file
- **AND** SHALL forward the prompt unchanged (as if `role` were
  omitted)

### Requirement: Tiered budgets respect subagent presets

The system SHALL NOT double-apply superpower multipliers when the
caller has already supplied explicit budget fields.

When a caller constructs an agent-context and already passes an
explicit `tokenBudget` / `maxIterations` (as the `subagent` tool does
to hand a fixed slice to its children), the factory SHALL NOT re-apply
superpower multipliers to those preset values. Multipliers SHALL only
be applied when the field is left unset by the caller and the factory
falls back to the engine defaults.

This preserves the existing Layer-1 bugfix where subagents were being
double-multiplied.

#### Scenario: Preset budget not multiplied

- **WHEN** mode is `max` and caller constructs an agent-context with
  `options.tokenBudget = 30000`
- **THEN** the resulting context's `tokenBudget` SHALL be exactly
  `30000` (not `150000`)

#### Scenario: Unset budget multiplied

- **WHEN** mode is `max` and caller constructs an agent-context without
  specifying `tokenBudget`
- **THEN** the factory SHALL apply the `max` multiplier to the engine
  default (e.g. 60000 → 300000)

### Requirement: Per-request token overhead bounded

The bootstrap injection SHALL target a steady-state per-request
overhead of approximately 1.5 k–2 k tokens. The remaining 6 methodology
skills SHALL be opt-in via `list_skills` / `get_skill` so they only
cost tokens when the agent actively pulls them.

The system SHALL NOT auto-inject more than one skill's content into the
system prompt. Users who want additional skills always-on MUST do so
explicitly via `allowedSkills`.

#### Scenario: Only bootstrap skill is auto-injected

- **WHEN** mode is `methodology` and the request is observed
- **THEN** the prepended system-prompt block SHALL contain the content
  of exactly one SKILL.md (the `superpower-using-superpowers` skill)
- **AND** SHALL NOT contain content from any other `superpower-*`
  skill

#### Scenario: Agent can pull other skills on demand

- **WHEN** the agent calls `get_skill` with
  `name='superpower-tdd'` during a `methodology`-mode session
- **THEN** the tool SHALL return the full TDD SKILL.md content
  (existing skill-tool behaviour, unchanged)

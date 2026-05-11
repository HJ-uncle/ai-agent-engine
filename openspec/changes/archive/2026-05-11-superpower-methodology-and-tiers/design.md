# Design: Superpower Tiered Mode + Methodology Skeleton

## Context

Layer 1 shipped a single boolean `SUPERPOWER_ENABLED` that controls:

- tool white-list via `resolveDefaultAllowedTools()`
- three numeric multipliers (`tokenBudget`, `maxIterations`,
  `toolOutputMaxChars`) via `applySuperpowerMultiplier()`
- compression-threshold ratio override via
  `getSuperpowerCompressRatio()`

All of this is self-contained in `src/core/superpower.ts`. The call
sites are:

| Caller | Usage |
|---|---|
| `src/core/agent-context/factory.ts` | `applySuperpowerMultiplier('tokenBudget', …)` |
| `src/core/agent-loop/react.ts` | `applySuperpowerMultiplier('maxIterations' / 'toolOutputMaxChars', …)`, `getSuperpowerCompressRatio(…)` |
| `src/tools/registry-factory.ts` | `resolveDefaultAllowedTools(…)`, `runSuperpowerSelfCheck(…)` |

System prompt assembly for a chat happens in
`src/api/http/routes/chat.ts` (and a similar path in `messages.ts`).
The current `baseSystemPrompt` is:

```
effectiveSystemPrompt + skillsPrompt + inlineKbBlock + inlineMemoriesBlock
```

External skills are already wired: `skillsRegistry` auto-discovers any
`SKILL.md` under `SKILLS_ROOT` (default `./SKILLs`) and hot-reloads on
change. Built-in tools `list_skills` / `get_skill` / `run_skill_script`
let the Agent pull a specific skill's full content on demand.

The `subagent` tool (`src/tools/subagent/subagent-tool.ts`) currently
takes `task`, `systemPrompt`, `model`, `maxSteps`. It builds a fresh
subagent with an isolated context.

This change lands a 4-tier mode plus a methodology skill pack, and
auto-injects the methodology "bootstrap" SKILL.md into the system
prompt in the two upper tiers.

## Goals / Non-Goals

**Goals:**

1. Replace the boolean switch with an explicit 4-tier enum that cleanly
   separates (a) whether tool access is full, (b) whether multipliers
   apply and at what ratio, (c) whether methodology is injected, (d)
   whether artifact directories get created.
2. Give the word "Superpower" real methodology content so that in
   `methodology` / `max` modes, the Agent actually follows a
   spec-first / TDD / subagent-reviewed workflow instead of just
   behaving like a turbocharged default agent.
3. Keep all the changes additive at the capability level: no existing
   specs need delta files, and `SUPERPOWER_ENABLED=true|false` keeps
   working for at least one minor release.
4. Keep per-request token overhead bounded (~1.5–2 k) by injecting
   only the bootstrap skill, with the other 6 methodology skills
   behind on-demand `get_skill` lookups.
5. Make the new subagent `role` parameter strictly additive so every
   existing caller continues to work unchanged.

**Non-Goals:**

- Do **not** port obra's `using-git-worktrees`,
  `finishing-a-development-branch`,
  `dispatching-parallel-agents`, or `writing-skills`. They are
  platform- or git-centric and would inflate scope.
- Do **not** touch the LLM adapter layer or the streaming pipeline.
- Do **not** add new npm dependencies.
- Do **not** change the public signatures of the Layer 1 exports; only
  their internals.
- Do **not** ship an eval harness for skill-shaped behaviour in this
  change. Manual acceptance transcript ("Let's build a todo app" →
  expected brainstorming auto-trigger) is sufficient for the first
  cut; a proper eval suite is a follow-up.

## Decisions

### D1. Mode representation: `SUPERPOWER_MODE` enum of 4 strings

**Decision:** Introduce `SUPERPOWER_MODE` env with values
`off` | `balanced` | `methodology` | `max`. Resolve with this
priority:

1. If `SUPERPOWER_MODE` is set and valid → use it.
2. Else if `SUPERPOWER_ENABLED=true` → resolve to `methodology`
   (emit one-time deprecation warning).
3. Else if `SUPERPOWER_ENABLED=false` → resolve to `off`
   (no warning; this is the default OFF state).
4. Else → `off`.

**Alternatives considered:**

- **Numeric dial (0 / 1 / 2 / 3).** Rejected — less readable in env
  files, ambiguous when printed in logs.
- **Two booleans (`SUPERPOWER_FULL_TOOLS` + `SUPERPOWER_METHODOLOGY`
  + `SUPERPOWER_MAX_BUDGET`).** Rejected — combinatorial explosion in
  docs and tests; the four tiers are opinionated combinations we want
  to curate centrally.
- **Keep boolean, add secondary env for methodology only.** Rejected
  — doesn't address the "×5 is too aggressive for daily use"
  feedback; still a 2D matrix.

**Rationale:** Enums are discoverable (TS type + runtime whitelist
makes typos loud), they serialize to human-readable strings, and 4
tiers match the natural user mental model (off / daily / serious
project / autonomous long run).

### D2. Per-mode configuration table

**Decision:** Centralize everything in a single
`SUPERPOWER_MODE_CONFIG` object keyed by mode, holding:

```ts
{
  off:          { allowAllTools: false, multipliers: × 1, compressRatio: base,  methodology: false, artifactDirs: false },
  balanced:     { allowAllTools: true,  multipliers: × 2, compressRatio: base,  methodology: false, artifactDirs: false },
  methodology:  { allowAllTools: true,  multipliers: × 2, compressRatio: base,  methodology: true,  artifactDirs: true  },
  max:          { allowAllTools: true,  multipliers: × 5, compressRatio: 0.7,   methodology: true,  artifactDirs: true  },
}
```

All existing helpers (`applySuperpowerMultiplier`,
`getSuperpowerCompressRatio`, `resolveDefaultAllowedTools`) read
through this single source of truth. No helper bakes mode logic
locally.

**Alternatives considered:**

- **Separate constants per aspect.** Rejected — drifts over time;
  central table keeps all knobs visible on one screen during review.
- **Split multiplier map (×2 / ×5) into named fields per tier.**
  Accepted internally — `MULTIPLIERS = { base: 1, ×2: 2, ×5: 5 }`
  referenced by mode; allows an easy "what changed?" diff.

**Rationale:** Whenever we add a future knob (e.g., system-prompt
fragment X), it's one row per mode; no hunting across files.

### D3. Methodology skills live under `SKILLs/superpower-*/`

**Decision:** Put the 7 skills in the existing external-skills root,
each with the standard `SKILL.md` frontmatter
(`name`, `description`). They are therefore picked up by
`skillsRegistry.start()` automatically with zero new infrastructure.

**Alternatives considered:**

- **Bundle them in `src/skills/` as built-in TypeScript skills.**
  Rejected — they are pure prose; compiling them into the bundle
  would make text edits require a rebuild and break hot-reload.
- **Fetch from GitHub at runtime.** Rejected — out of scope; would
  add a dependency and a supply-chain risk.

**Rationale:** Obra's project is also just markdown files; the
existing `skillsRegistry` already handles watching, hot-reload, and
metadata listing.

### D4. Bootstrap injection mechanism

**Decision:** Add a new `src/core/superpower-bootstrap.ts` that:

- At module init, registers a `reload()` listener on
  `skillsRegistry` so the bootstrap text can be refreshed when the
  `SKILL.md` file is edited on disk.
- Exports `getSuperpowerBootstrapBlock(): string` that returns:
  - Empty string when `resolveSuperpowerMode() ∈ {off, balanced}`.
  - The full content of
    `SKILLs/superpower-using-superpowers/SKILL.md` wrapped in a
    `<SUPERPOWER-ACTIVE>…</SUPERPOWER-ACTIVE>` sentinel block, when
    mode is `methodology` or `max`. The sentinel makes it easy to
    grep logs and audit how often the bootstrap was injected.
- Chat and messages routes call `getSuperpowerBootstrapBlock()` and
  prepend its output to `baseSystemPrompt`.

**Alternatives considered:**

- **Inject as an additional "skill" in the Available Skills index.**
  Rejected — the using-superpowers skill is meant to be present in
  the Agent's effective system prompt on every turn, not pulled via
  `get_skill`. Indexing alone would not shape behaviour reliably.
- **Inject all 7 skills' full content.** Rejected — roughly 8–12 k
  extra tokens per turn; wastes budget because most skills are
  conditional.
- **Use the Fastify on-request hook to mutate system prompt.**
  Rejected — chat route is the only consumer that builds the system
  prompt; explicit is better than hooky.

**Rationale:** Matches obra's pattern exactly (their hook injects
`using-superpowers` verbatim). Other skills trigger via the Agent's
own `list_skills` / `get_skill` when they see the "If a skill applies,
invoke it" instruction inside the bootstrap.

### D5. Product-artifact directory triad creation

**Decision:** When mode is `methodology` / `max`, in
`createAgentContext()` ensure:

```
<workspaceDir>/docs/superpower/specs/
<workspaceDir>/docs/superpower/plans/
<workspaceDir>/docs/superpower/reviews/
```

exist via `fs.mkdirSync(..., { recursive: true })`. Silent no-op when
they already exist. Skipped for `off` / `balanced`.

**Alternatives considered:**

- **Create on demand when a tool first writes into them.** Rejected
  — forces the Agent to issue an extra `create_dir` call or skill
  script; unnecessary friction for a fixed known set of paths.
- **Create unconditionally in every mode.** Rejected — leaves
  clutter in workspaces where the feature isn't used.

**Rationale:** The SKILL.md files unconditionally reference these
paths ("Write the validated design to `docs/superpower/specs/…`"); if
the dir is missing the Agent wastes a turn mkdir'ing it.

### D6. `subagent` tool role contract

**Decision:** Extend `subagent-tool.ts` schema with:

```ts
role?: 'implementer' | 'spec-reviewer' | 'code-quality-reviewer'
```

When set, the tool loads the matching
`SKILLs/superpower-subagent-driven-dev/<role>-prompt.md` file (path
discovered via `skillsRegistry`). The loaded text becomes the default
base prompt; any user-supplied `systemPrompt` is **appended** to it
rather than replacing it, so the role's discipline persists.

When `role` is omitted, behaviour is identical to today.

**Alternatives considered:**

- **Build 3 new tools (`subagent_implement`, `subagent_review_spec`,
  `subagent_review_quality`).** Rejected — triples the tool-surface
  the LLM has to reason about; most of the argument schemas are
  identical.
- **Ship the role prompt only when methodology mode is on.** Accepted
  as an enforcement rule: if `mode ∈ {off, balanced}` and
  `role` is passed, the tool logs a warning and falls back to
  default behaviour. This keeps the role mechanic a methodology-only
  feature without breaking calls made in other modes.

**Rationale:** Smallest possible surface change. The Agent can
choose role by string literal; no new tool registration needed.

### D7. Token budget for methodology injection

**Decision:** Accept ~1.5–2 k token/turn overhead in
`methodology` mode. This fits comfortably in the ×2 multiplier window
(`60 000 × 2 = 120 000`). The bootstrap SKILL.md is frozen size
(we review it when authoring); accidentally growing it past 3 k
triggers a warn log at boot via
`superpower-bootstrap.ts`.

**Mitigation:** Boot-time size check emits
`superpower: bootstrap SKILL.md exceeds 3k tokens; consider trimming`
but never blocks startup.

### D8. Skills content sourcing and language

**Decision:** Treat obra/superpowers as reference material (MIT
licensed, compatible). Rewrite each SKILL.md from scratch in our
voice, preserving:

- Iron laws (TDD RED/GREEN, debugging 4-phase, etc.)
- Red-flag tables (high signal-to-token ratio)
- Phrasing conventions that obra has eval-tuned (e.g.,
  `<HARD-GATE>`, `<EXTREMELY-IMPORTANT>`)

Drop:

- Claude-Code-specific tool names (`Bash` / `Read` / `Task`) — replace
  with ours (`run_command` / `smart_read` / `subagent`).
- Cross-references to skills we're not porting.

Content language: **English primary text** (matches obra's
eval-tested phrasing; retains the behaviour-shaping punch). Add a
short Chinese preface paragraph per skill to aid human maintainers.

**Rationale:** obra warns loudly against reflowing their text without
eval evidence (CLAUDE.md L95). We rewrite rather than copy-edit,
which both sidesteps attribution issues and tailors to our tool set.
Keeping the English "iron law" phrasing preserves whatever empirical
tuning obra did, while the Chinese preface makes our team
comfortable.

### D9. Front-end: segmented control, not dropdown

**Decision:** Use AntD `Segmented` with 4 options. Each option shows
a short label + a tooltip with the full mode description. Entering
`max` triggers the existing risk-confirmation modal.

**Alternatives considered:**

- **Radio group:** noisier vertically.
- **Dropdown:** less discoverable; users should see all 4 options at
  a glance.

### D10. Backwards-compat window

**Decision:** Keep `SUPERPOWER_ENABLED` as a soft alias for one minor
release (N + 0.1). At first resolution per process, log a
`warn` once:

```
DEPRECATION: SUPERPOWER_ENABLED is deprecated; use SUPERPOWER_MODE
(off|balanced|methodology|max). Mapping: true→methodology, false→off.
Will be removed in the next minor release.
```

Unit-test asserts the deprecation fires exactly once per process.

## Risks / Trade-offs

**[R1] Tokens:** Methodology bootstrap eats ~1.5–2 k tokens per turn.
→ Mitigated by the ×2 multiplier and the bootstrap-only injection
strategy (6 other skills on demand). Boot-time size alarm guards
regressions.

**[R2] Existing `SUPERPOWER_ENABLED=true` users now get ×2 instead of
×5.** Behaviour-breaking for anyone relying on ×5 specifically.
→ Mitigated by (a) RELEASE-NOTES callout, (b) deprecation warning
telling them exactly what to set, (c) one-release grace window.

**[R3] Agent becomes "too formal" in methodology mode.** Simple
requests ("rename this variable") could trigger brainstorming flow.
→ Mitigated by the mode itself: users who don't want the ceremony set
`balanced`. Additionally, the `using-superpowers` SKILL.md includes a
`<SUBAGENT-STOP>` clause to short-circuit on trivial tasks (obra's
pattern).

**[R4] Skill text drifts out of sync with real tool names.** If a
tool is renamed, SKILL.md may still mention the old name.
→ Mitigated by the Layer 1 `runSuperpowerSelfCheck` + add a new
boot-time pass that greps the 7 SKILL.md files for legacy or
non-existent tool names, logging warnings.

**[R5] Bootstrap hot-reload race with in-flight request.** A user
edit to the SKILL.md during a request could produce a mid-turn
discrepancy.
→ Mitigated by snapshotting the bootstrap block once per request at
`baseSystemPrompt` construction; never re-read within a run.

**[R6] Role prompts stale vs tool set.** Role prompt text may
reference tools that aren't enabled in a given registry.
→ Mitigated by the `role`-filtered subagent tool logging a warn if
any tool name cited in the loaded role prompt is not present in the
subagent's tool registry. Non-blocking.

**[R7] Deprecation warning noise.** Users who deploy many processes
hit the log line many times.
→ Mitigated by the "log once per process" rule; documented with
`DEPRECATION_LOGGED_ONCE` module flag.

**[R8] Self-check at load time hides mode-specific failures.**
Current Layer 1 self-check runs when allowedTools is undefined. In
`off` mode that path is never taken.
→ Run an unconditional self-check on the methodology skill pack at
`skillsRegistry.start()` completion (after bootstrap load), covering
just the 7 superpower skills' on-disk existence.

## Migration Plan

**Phase 1: Ship (this change)**

- Land all code + skill files behind the new `SUPERPOWER_MODE` env.
- `SUPERPOWER_ENABLED` continues to work, with deprecation warning.
- Default unchanged (`off`).
- Acceptance transcript added to QA docs: send "Let's build a react
  todo list" with `SUPERPOWER_MODE=methodology` to a fresh session;
  verify the Agent first invokes brainstorming.

**Phase 2: Communicate (post-merge, release notes)**

- RELEASE-NOTES:
  - `SUPERPOWER_ENABLED` deprecated; `SUPERPOWER_MODE` introduced.
  - Behaviour change: ×5 requires `SUPERPOWER_MODE=max`.
  - Methodology opts-in via `methodology` or `max`.

**Phase 3: Remove (next minor)**

- Drop `SUPERPOWER_ENABLED` env handling.
- Drop the legacy alias and its warning.
- Update README and `.env.example`.

**Rollback:** Revert the change; set `SUPERPOWER_MODE=off` via
`PUT /settings`. No data migrations are required because the mode is
stateless (pure env config).

## Open Questions

- **OQ1.** Should the bootstrap block be tenant-scoped or
  process-scoped? Process-scoped is simpler; tenant-scoped would
  allow per-tenant methodology override but complicates hot-reload.
  *Tentative answer:* process-scoped for this change; defer
  tenant override to a follow-up if demand emerges.
- **OQ2.** Do we want a CLI / HTTP endpoint to list the 7
  methodology skills and their summaries for operators?
  *Tentative answer:* no new endpoint; existing
  `GET /tools` already exposes them via `list_skills`. Operators
  can also `ls SKILLs/superpower-*`.
- **OQ3.** Should we record methodology usage (how often
  `brainstorming` was invoked per session) as observability metrics?
  *Tentative answer:* nice-to-have, out of scope for this change;
  file as a follow-up.

# Proposal: Superpower Tiered Mode + Methodology Skeleton

## Why

The Layer 1 `SUPERPOWER_ENABLED` switch is a single boolean that only scales
numbers (token budget, iteration count, output caps) and unlocks high-risk
tools. It has two shortcomings users have already hit:

1. **"All or nothing" is too coarse.** Users want an intermediate level
   that unlocks the full tool set for daily work but does not apply the
   aggressive ×5 multipliers. Today they must choose "saver" or "firehose"
   with nothing in between.
2. **The name promises methodology, the implementation delivers a turbo
   button.** The obra/superpowers reference project treats Superpower as a
   complete software engineering methodology (brainstorm → plan → TDD →
   subagent review → verification), delivered as skills + auto-injection.
   Our Superpower only delivers the resource layer; the methodology soul
   is missing.

This change fixes both in one coherent step: replace the boolean with a
4-tier mode, and attach the methodology skeleton to the higher tiers so
the word "Superpower" actually means what it says on the tin.

## What Changes

### A. Replace the boolean with a 4-tier mode

- Introduce `SUPERPOWER_MODE` env with values:
  - `off` — today's OFF behaviour (CORE tools only, baseline numbers,
    no methodology)
  - `balanced` — full tool set, multipliers ×2, no methodology
    injection *(default choice for daily use when Superpower is
    "on")*
  - `methodology` — full tool set, multipliers ×2, methodology
    bootstrap injected, artifact directories created
  - `max` — full tool set, multipliers ×5, methodology injected,
    artifact directories, strictest compression/context defaults
    *(for long autonomous runs)*
- **Backwards-compatible legacy alias** for `SUPERPOWER_ENABLED`:
  - `SUPERPOWER_ENABLED=true`  → effectively `methodology`
  - `SUPERPOWER_ENABLED=false` → effectively `off`
  - `SUPERPOWER_MODE` wins if both are set; legacy env triggers a
    one-time deprecation warning in the logger.
- **BREAKING (env semantics, not code API):** The numeric effect of
  "ON" changes from ×5 (Layer 1) to ×2 (new `methodology` default).
  Users who want the old ×5 behaviour must explicitly set
  `SUPERPOWER_MODE=max`. Documented in Impact below.

### B. Ship the methodology skill pack

Ship 7 methodology skills under `SKILLs/superpower-*/`, reusing the
existing external-skills loader (no new registry needed):

- `superpower-using-superpowers` — bootstrap + skill-discovery rules
- `superpower-brainstorming` — Socratic design refinement with
  `<HARD-GATE>` before any implementation
- `superpower-writing-plans` — bite-sized TDD task plans
- `superpower-tdd` — RED / GREEN / REFACTOR iron-law enforcement
- `superpower-systematic-debugging` — 4-phase root-cause process
- `superpower-subagent-driven-dev` — fresh-subagent-per-task with
  spec + code-quality dual review
- `superpower-verification-before-completion` — evidence-based
  completion gate

### C. Auto-inject the methodology bootstrap

When `SUPERPOWER_MODE` is `methodology` or `max`, automatically prepend
`superpower-using-superpowers/SKILL.md` full content to every outgoing
system prompt (the agent-engine analogue of obra's SessionStart hook).
The remaining 6 methodology skills are discovered on demand via the
existing `list_skills` / `get_skill` tools — keeping the per-request
token overhead bounded to ~1.5–2 k.

### D. Create product-artifact directories

When `SUPERPOWER_MODE` is `methodology` or `max`, on session workspace
init create the canonical triad:

```
<workspaceDir>/docs/superpower/specs/
<workspaceDir>/docs/superpower/plans/
<workspaceDir>/docs/superpower/reviews/
```

so the Agent has a well-known place to write brainstorm specs, plans,
and review reports (referenced in every SKILL.md).

### E. Extend the `subagent` tool with a `role` parameter

Add an optional `role` parameter (`implementer` | `spec-reviewer` |
`code-quality-reviewer`) that, when set, auto-loads the corresponding
prompt template bundled with the `superpower-subagent-driven-dev`
skill. Defaults keep existing behaviour (no role → current prompt).

### F. Front-end: replace Switch with 4-option segmented control

Replace the boolean Switch in Settings → General with a labelled
segmented control (Off / Balanced / Methodology / Max) showing:

- Which tools / multipliers / injection each mode implies
- A confirmation modal on entering `max` (as Layer 1 already does for
  the blanket switch)
- A small "Methodology active" indicator when `methodology` or `max`

### G. Non-goals (explicit)

- Git-worktree integration (obra's `using-git-worktrees`) — platform
  dependent, deferred.
- `dispatching-parallel-agents` — superset of current `subagent` tool,
  out of scope.
- `writing-skills` meta-skill — not useful to runtime behaviour, skip.
- `finishing-a-development-branch` — git-merge-centric, skip.

## Capabilities

### New Capabilities
- `superpower-mode`: Defines the 4-tier mode enum, its semantics for
  tool filtering / multipliers / compression ratio / methodology
  injection / artifact directories; the backwards-compat layer for
  legacy `SUPERPOWER_ENABLED`; the contract between the mode resolver
  and downstream consumers (agent-loop, tool-registry, chat route,
  workspace factory).
- `superpower-methodology`: Defines the 7 methodology skills, the
  bootstrap-injection contract (when `mode ∈ {methodology, max}`), the
  product-artifact directory triad, and the `role`-driven subagent
  prompt loading.

### Modified Capabilities
<!-- Intentionally empty. All Layer 1 logic lives in a single
self-contained module (src/core/superpower.ts) which this change
internally rewrites; from the perspective of existing capabilities
(agent-loop, tool-registry, prompt-template, workspace) the change is
additive: they gain new but optional inputs, and continue to satisfy
all prior requirements. Existing specs under openspec/specs/ do not
need delta files. -->

## Impact

### Code changes

- **Rewrite `src/core/superpower.ts`** to:
  - Export `SuperpowerMode` enum and `resolveSuperpowerMode()` that
    handles legacy `SUPERPOWER_ENABLED` aliasing + deprecation warning.
  - Export per-mode multiplier tables, `applySuperpowerMultiplier()`
    keeps its current signature but reads mode instead of boolean.
  - `resolveDefaultAllowedTools()` keeps its 4-quadrant contract;
    internally switches on mode (only `off` narrows to CORE).
  - `getSuperpowerCompressRatio()` keeps its signature; `max` → 0.7,
    `methodology` / `balanced` → caller's base (unchanged), `off` →
    caller's base.
  - Retain `isSuperpowerEnabled()` as deprecated thin alias
    (`mode !== 'off'`) to avoid churn at call sites that don't care
    about granularity.
- **New `src/core/superpower-bootstrap.ts`**: loads
  `SKILLs/superpower-using-superpowers/SKILL.md`, exports
  `getSuperpowerBootstrapBlock()` returning the content or empty string
  per current mode. Hot-reloads via existing `skillsRegistry`.
- **`src/api/http/routes/chat.ts`** and `messages.ts`: prepend
  bootstrap block to `baseSystemPrompt` when applicable. Purely
  additive.
- **`src/core/agent-context/factory.ts`**: when mode is `methodology`
  / `max`, ensure `docs/superpower/{specs,plans,reviews}/` exist.
- **`src/tools/subagent/subagent-tool.ts`**: add optional `role` field
  to schema and handler; default path unchanged.
- **`src/api/http/routes/settings.ts`**: GET returns
  `SUPERPOWER_MODE` (resolved from legacy if needed); PUT accepts
  either key.
- **Front-end `GeneralSettings.tsx`**: replace Switch with
  segmented control; reuse confirmation modal for `max`.
- **Tests**: extend `superpower.test.ts` to cover mode resolution +
  legacy aliasing + per-mode multipliers + bootstrap injection gating;
  add a new `superpower-bootstrap.test.ts`.

### Skill pack

- **7 new directories under `SKILLs/superpower-*/`** with
  `SKILL.md` + supporting prompt templates for the `subagent-driven-dev`
  skill (`implementer-prompt.md`, `spec-reviewer-prompt.md`,
  `code-quality-reviewer-prompt.md`). Content is inspired by
  obra/superpowers (MIT, compatible) but rewritten to match
  agent-engine's skill format and actual tool names
  (`run_command` / `smart_read` / `subagent` / etc. — not Claude
  Code's `Bash` / `Read` / `Task`).

### Behavioural impact

- **Default behaviour unchanged** while env is unset
  (`mode === 'off'`).
- **Existing users with `SUPERPOWER_ENABLED=true`** now land in
  `methodology` mode (methodology ON + multipliers ×2, not ×5).
  - They get the methodology soul they were missing.
  - Their token usage may go up by ~1.5–2k per request for the
    bootstrap, offset by methodology-driven better outcomes.
  - Their multipliers go from ×5 to ×2. If they relied on the raw ×5
    numbers, they need to switch to `SUPERPOWER_MODE=max`. Release
    notes will call this out.
- **Zero new npm dependencies.**
- **Full backward compatibility of the `src/core/superpower.ts` public
  API signatures** (`applySuperpowerMultiplier`,
  `getSuperpowerCompressRatio`, `resolveDefaultAllowedTools`,
  `isSuperpowerEnabled`, `runSuperpowerSelfCheck`).

### Documentation

- `README.md` gets a "Superpower Modes" section with a decision table.
- `.env.example` updated: legacy `SUPERPOWER_ENABLED` marked as
  deprecated but supported; `SUPERPOWER_MODE` as the recommended knob.
- `openspec/project.md` mentions the new capabilities so future
  proposals can reference them.

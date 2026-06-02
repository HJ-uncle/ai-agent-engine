# Tasks: Superpower Tiered Mode + Methodology Skeleton

## 1. Core mode plumbing (`src/core/superpower.ts`)

- [x] 1.1 Add `SuperpowerMode` type/enum (`'off' | 'balanced' | 'methodology' | 'max'`)
- [x] 1.2 Add `SUPER_MULTIPLIER_TABLE` keyed by mode × field (per spec table)
- [x] 1.3 Implement `resolveSuperpowerMode()` reading `process.env` each call; handle precedence (MODE wins) and legacy `SUPERPOWER_ENABLED=true → methodology`, `false → off`
- [x] 1.4 Add module-level `__legacyWarned` flag + one-shot deprecation `logger.warn` when legacy env is the reason a non-off mode was chosen
- [x] 1.5 Emit `warn` once when `SUPERPOWER_MODE` is set to an unrecognised value; fall back to legacy then `off`
- [x] 1.6 Rewrite `applySuperpowerMultiplier(field, base)` to look up `SUPER_MULTIPLIER_TABLE[mode][field]`; unchanged external signature
- [x] 1.7 Rewrite `getSuperpowerCompressRatio(base)`: only `max` returns `0.7`, others return `base`
- [x] 1.8 Rewrite `resolveDefaultAllowedTools(explicit)`: only `off` narrows to CORE (existing logic); other modes respect `explicit` verbatim
- [x] 1.9 Keep `isSuperpowerEnabled()` as `@deprecated` thin alias returning `mode !== 'off'`
- [x] 1.10 Keep `runSuperpowerSelfCheck` / `logSuperpowerSelfCheck` signatures unchanged; no mode-specific behaviour needed
- [x] 1.11 Export `SuperpowerMode` from `src/core/superpower.ts` barrel (or directly)

## 2. Bootstrap injection (`src/core/superpower-bootstrap.ts` — NEW)

- [x] 2.1 Create `src/core/superpower-bootstrap.ts`
- [x] 2.2 Implement `getSuperpowerBootstrapBlock()`: if mode ∈ {methodology, max}, look up `superpower-using-superpowers` via `skillsRegistry.getSkills()` and return its `SKILL.md` content; else return `''`
- [x] 2.3 Cache a `__missingWarned` flag so missing bootstrap only warns once per process
- [x] 2.4 Implement `prependBootstrapToSystemPrompt(base: string): string` helper that inserts the `\n\n---\n\n` delimiter only when bootstrap is non-empty
- [x] 2.5 Add unit tests covering: off/balanced → empty, methodology/max → prepended, missing skill → warn-once + empty, hot-reload via updated `skillsRegistry` — `src/core/__tests__/superpower-bootstrap.test.ts` (10 tests)

## 3. Route integration

- [x] 3.1 `src/api/http/routes/chat.ts`: call `prependBootstrapToSystemPrompt(baseSystemPrompt)` before passing to agent-loop
- [x] 3.2 `src/api/http/routes/messages.ts`: same integration point
- [x] 3.3 Verify no duplicate prepending when both routes delegate through shared helpers
- [ ] 3.4 Add integration test: fake mode env, assert outbound system prompt starts with bootstrap content — *deferred to manual E2E verification; see `e2e-checklist.md` §A*

## 4. Agent-context factory (`src/core/agent-context/factory.ts`)

- [x] 4.1 After resolving budgets, if `mode ∈ {methodology, max}` and `workspaceDir` is available, ensure `docs/superpower/{specs,plans,reviews}/` exist via `fs.mkdirSync({ recursive: true })`
- [x] 4.2 Wrap mkdir in try/catch; on failure emit `logger.warn({ path, err }, ...)`; never throw
- [x] 4.3 Skip directory creation entirely when mode is `off` or `balanced`
- [x] 4.4 Preserve existing "preset budget not multiplied" guard (Layer-1 bugfix) — verify still intact under new tables
- [x] 4.5 Unit test: methodology → directories created; balanced → not created; read-only workspace → warn, context still returned — `src/core/agent-context/__tests__/factory.test.ts` (8 tests, covers methodology/max/off/balanced matrix + idempotency + preset budget guard)

## 5. Subagent `role` parameter

- [x] 5.1 `src/tools/subagent/subagent-tool.ts`: extend input schema with optional `role: z.enum(['implementer','spec-reviewer','code-quality-reviewer']).optional()`
- [x] 5.2 Handler: when `role` is set, resolve template file under `SKILLs/superpower-subagent-driven-dev/{role}-prompt.md`
- [x] 5.3 Read template via `smart_read`-like utility or direct `fs.readFileSync`; prepend to caller prompt with `\n\n---\n\n`
- [x] 5.4 Missing template → `logger.warn` + fall back to verbatim prompt (no throw)
- [x] 5.5 Default path (no `role`) must remain byte-identical to today
- [x] 5.6 Update tool description to document `role` and link to `superpower-subagent-driven-dev` skill
- [x] 5.7 Unit tests: happy path per role, unknown role rejected by schema, missing file warn+fallback, role-less call unchanged — `src/tools/subagent/__tests__/subagent-tool.test.ts` (9 tests)

## 6. Settings API (`src/api/http/routes/settings.ts`)

- [x] 6.1 `GET /settings`: compute `SUPERPOWER_MODE` via `resolveSuperpowerMode()` and include in response (even if only legacy env is stored)
- [x] 6.2 `PUT /settings`: accept `SUPERPOWER_MODE` (preferred); validate against the 4 values
- [x] 6.3 `PUT /settings`: if both `SUPERPOWER_MODE` and `SUPERPOWER_ENABLED` are present → `400` with explanatory message
- [x] 6.4 On successful PUT, sync `process.env.SUPERPOWER_MODE` so next request hot-reloads
- [x] 6.5 Keep legacy `SUPERPOWER_ENABLED` write path functional (with one-time deprecation `logger.warn` at DB-write time)
- [ ] 6.6 Integration test: PUT off→max, confirm GET reflects max, confirm subsequent chat request behaves as max — *deferred to manual E2E verification; see `e2e-checklist.md` §B*

## 7. Methodology skill pack (`SKILLs/superpower-*/`)

Each skill's `SKILL.md` must use YAML frontmatter and agent-engine tool names only. Porting from obra/superpowers under MIT.

- [x] 7.1 `SKILLs/superpower-using-superpowers/SKILL.md` — bootstrap + how to discover other superpower skills via `list_skills` / `get_skill`; includes `<EXTREMELY-IMPORTANT>` iron-law preamble
- [x] 7.2 `SKILLs/superpower-brainstorming/SKILL.md` — Socratic design flow, `<HARD-GATE>` preventing implementation without a written spec in `docs/superpower/specs/`
- [x] 7.3 `SKILLs/superpower-writing-plans/SKILL.md` — bite-sized TDD-shaped plans, output goes to `docs/superpower/plans/`
- [x] 7.4 `SKILLs/superpower-tdd/SKILL.md` — RED/GREEN/REFACTOR with `<IRON-LAW>` ("no production code without a failing test"); maps to `code_diagnose` and chosen test runners
- [x] 7.5 `SKILLs/superpower-systematic-debugging/SKILL.md` — 4-phase root-cause process (reproduce → isolate → hypothesise → verify)
- [x] 7.6 `SKILLs/superpower-subagent-driven-dev/SKILL.md` — orchestration guide; references the three `*-prompt.md` templates
- [x] 7.7 `SKILLs/superpower-subagent-driven-dev/implementer-prompt.md`
- [x] 7.8 `SKILLs/superpower-subagent-driven-dev/spec-reviewer-prompt.md`
- [x] 7.9 `SKILLs/superpower-subagent-driven-dev/code-quality-reviewer-prompt.md`
- [x] 7.10 `SKILLs/superpower-verification-before-completion/SKILL.md` — evidence-based completion checklist, writes report to `docs/superpower/reviews/`
- [x] 7.11 Lint pass: grep all 7 SKILL.md files for Claude Code aliases (`\bBash\b|\bRead\b|\bTask\b|\bWrite\b|\bGrep\b|\bGlob\b|\bEdit\b`) → must return zero matches
- [x] 7.12 Verify `skillsRegistry.getSkills()` picks up all 7 names at boot — `src/skills/__tests__/superpower-pack-discovery.test.ts` (2 tests, real `./skills` dir scan, asserts 7 expected names + non-empty descriptions)

## 8. Front-end (`multi-agent-console/src/web/components/settings/GeneralSettings.tsx`)

- [x] 8.1 Replace `Switch` with antd `Segmented` control bound to `SUPERPOWER_MODE` (four options with labels + tooltips summarising multipliers/tools/injection)
- [x] 8.2 Read initial value from `settings.SUPERPOWER_MODE`; fallback to derive from legacy `SUPERPOWER_ENABLED` for one release
- [x] 8.3 On change, call `settingsApi.update({ SUPERPOWER_MODE: value })`; rollback UI on error (reuse existing pattern)
- [x] 8.4 Keep confirmation modal but only for the `→ max` transition; list ×5 multipliers / all tools / 0.7 compression
- [x] 8.5 Add small "Methodology active" indicator (e.g. icon + tooltip) when mode is `methodology` or `max`
- [x] 8.6 Update copy to remove "启用增强模式" single-boolean wording; document each mode briefly
- [ ] 8.7 Verify settings persist + hot-reload end-to-end in the console — *deferred to manual E2E verification; see `e2e-checklist.md` §C*

## 9. Documentation

- [x] 9.1 `.env.example`: add `SUPERPOWER_MODE=off` block with per-value description; mark `SUPERPOWER_ENABLED` as **deprecated (use SUPERPOWER_MODE)**; schedule removal in next minor
- [x] 9.2 `README.md`: add "Superpower Modes" section with decision table (mode × tools × multipliers × injection × artifact dirs)
- [x] 9.3 `openspec/project.md`: register `superpower-mode` and `superpower-methodology` as recognised capabilities for future proposals *(N/A — repo uses `openspec/specs/<cap>/` folders instead of a project.md; capabilities land there automatically at archive time)*
- [x] 9.4 Release notes entry: call out the ×5 → ×2 default multiplier change for legacy `SUPERPOWER_ENABLED=true` users; point to `SUPERPOWER_MODE=max` for old behaviour *(rolled into the README "Legacy SUPERPOWER_ENABLED" subsection; no separate CHANGELOG.md file exists in this repo)*

## 10. Tests & verification

- [x] 10.1 Extend `src/core/superpower.test.ts` (or create if absent) to cover: mode resolution matrix, legacy alias precedence, one-shot deprecation warning, per-mode multiplier table, per-mode compression ratio, per-mode tool narrowing
- [x] 10.2 Create `src/core/superpower-bootstrap.test.ts`: inject/skip per mode, delimiter correctness, missing skill warn-once, hot-reload semantics
- [x] 10.3 Add `src/tools/subagent/subagent-tool.test.ts` role tests (or extend existing) — covers ROLE_VALUES contract, schema enum, `__loadRoleTemplateForTests` per role, missing/empty template, directory-name fallback, unknown-role rejection
- [x] 10.4 Add `src/core/agent-context/factory.test.ts` coverage for directory creation + read-only workspace — covers methodology/max create, off/balanced skip, idempotent re-create, `options.tokenBudget` preserved, env-derived budget multiplier
- [x] 10.5 Run `openspec validate superpower-methodology-and-tiers --strict` and fix any drift — passes strict
- [ ] 10.6 Manual smoke: set each of the 4 modes via UI, confirm ×multiplier, tool availability, bootstrap presence in logs — *deferred to manual E2E verification; see `e2e-checklist.md` §D + §E*

## 11. Migration & safety

- [x] 11.1 Confirm there is NO code path that reads `SUPERPOWER_ENABLED` outside `resolveSuperpowerMode()` and `settings.ts` (grep repo; fix stragglers) — grep done; only legal sites are `src/core/superpower.ts` (resolver), `src/api/http/routes/settings.ts` (GET/PUT legacy field), `multi-agent-console/.../GeneralSettings.tsx` (read-only UI fallback). All annotated with `TODO(remove-in-next-minor)`.
- [x] 11.2 Ensure backwards-compat: any agent preset with `tokenBudget`/`maxIterations` is untouched in all modes (regression guard) — `factory.ts` already preserved `options.tokenBudget`; fixed `react.ts` to preserve explicit `options.maxIterations` (previously double-amplified in `max`). Added regression test `respects explicit maxIterations even under SUPERPOWER_MODE=max`.
- [x] 11.4 *(found in verify)* Fix `historyMaxTokens` multiplier never applied: `DEFAULT_HISTORY_MAX_TOKENS` was a module-level constant frozen at process start; converted to `getDefaultHistoryMaxTokens()` dynamic function (reads env + calls `applySuperpowerMultiplier` per-instantiation, identical pattern to `getToolOutputMaxChars`). Added `src/storage/conversation/__tests__/history-maxTokens.test.ts` (6 tests: off/balanced/methodology/max multiplier, explicit-cap preserved, hot-reload semantics).
- [x] 11.3 Add a `TODO(remove-in-next-minor)` comment at the legacy branch so the next-cycle cleanup is mechanical — present in `src/core/superpower.ts` (L158), `src/api/http/routes/settings.ts` (L73), `multi-agent-console/.../GeneralSettings.tsx` (L30).

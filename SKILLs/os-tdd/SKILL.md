---
name: os-tdd
description: RED / GREEN / REFACTOR enforcement. Part of OpenSpec Methodology.
order: 30
official: true
version: 1.0.0
---

# Test-Driven Development

<IRON-LAW>

**No production code without a failing test.**

No exceptions. Not "just this once". Not "it's trivial". If you cannot
write a test first, the change is either (a) not a behaviour change
(cosmetic — skip TDD, just do it carefully) or (b) too coupled to test
(STOP, restructure instead).

</IRON-LAW>

## Chinese 预读

先写失败的测试（RED），再写最小实现让它通过（GREEN），最后重构
（REFACTOR）。每个循环一次提交粒度的变更。用 `run_command` 跑测试，
用 `code_diagnose` 做静态检查。

## The Cycle (one task from the plan = one or more cycles)

### RED — write a failing test

1. Open (or `write_file`) the test file next to the production file.
2. Describe one specific behaviour. One assertion is ideal; two is OK;
   more is usually wrong.
3. `run_command` the test — it **MUST** fail with a useful message.
   "Cannot find module" is **not** a valid RED; the test must actually
   run and assert something.
4. If it passes immediately, your test is wrong or the behaviour
   already exists. Stop and investigate.

### GREEN — smallest possible production change

1. Write the minimum code to make the test pass. Literally the minimum
   — hardcode return values if that's what passes one test. More tests
   will force the logic.
2. `run_command` the test — it must pass.
3. Run the **full** test suite — nothing else may have broken.

### REFACTOR — clean under green

1. Rename, extract, de-duplicate — any change that keeps tests green.
2. `code_diagnose` the touched files. Fix any diagnostics.
3. Re-run full suite. Still green? Commit-sized change is done.

## Tool recipes

- **Run one test file**: `run_command("npm test -- path/to/file.test.ts")`
  (adapt to the repo's actual runner; `grep` package.json first).
- **Run all tests**: `run_command("npm test")` or equivalent.
- **Static diagnostics**: `code_diagnose({ files: ["src/foo.ts"] })`.
- **Inspect failure**: `smart_read` the test output if large; do not
  guess from truncated tails.

## Red flags — stop and re-think

| Symptom | Action |
|---|---|
| "I'll write tests after" | STOP. Not TDD. Revert and restart. |
| Test that can't fail | Rewrite. A test that doesn't fail on broken code is useless. |
| Production change >20 LOC for one RED | Split the task smaller. |
| Refactor breaks other tests | Revert, plan a separate refactor task. |
| Keep adding `if` branches to pass | Sign your abstraction is wrong; brainstorm. |

## Handoff

When the task (all RED/GREEN/REFACTOR cycles for that task in the
plan) is done:

- Update the todo to `done`.
- Move to the next task in the plan.
- If the entire plan is complete, switch to
  `superpower-verification-before-completion`.

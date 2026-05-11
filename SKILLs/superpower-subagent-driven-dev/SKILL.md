---
name: superpower-subagent-driven-dev
description: Delegate implementation / spec review / code quality review to fresh subagents with role-specific prompt templates. Dual-review gating before merge.
order: 50
official: true
version: 1.0.0
---

# Subagent-Driven Development

## Chinese 预读

大任务分到干净子代理里做：一个专职 implementer 写代码，一个 spec-reviewer
对照 spec 审，一个 code-quality-reviewer 审代码质量。三者意见一致才算过。
通过 `subagent` 工具的 `role` 参数加载对应模板。

## When to use

- Any task whose plan has **≥ 3 RED/GREEN cycles** or touches
  **≥ 2 production files**.
- Any change that the user marked "important" or that crosses
  trust boundaries (auth, payments, PII, external APIs).

Small fixes / typos → just do them yourself, don't over-ceremony.

## The three roles

| Role | Purpose | Fresh context? |
|---|---|---|
| `implementer` | Execute one task from the plan under TDD | Yes |
| `spec-reviewer` | Compare the diff to the spec/plan | Yes |
| `code-quality-reviewer` | Inspect the diff for smells, duplication, safety | Yes |

Fresh context matters: reviewers must see the diff without the
implementer's internal rationalisations. Use the `subagent` tool with
the appropriate `role` so each gets a clean prompt template.

## Invocation recipes

### Delegate implementation

```
subagent({
  task: "Implement task T3 from docs/superpower/plans/<topic>.md.\n
         Follow RED/GREEN/REFACTOR. Stop when green and full suite passes.",
  role: "implementer",
  maxSteps: 20
})
```

### Delegate spec review

```
subagent({
  task: "Review the changes in <files touched> against the spec at\n
         docs/superpower/specs/<topic>.md and plan at\n
         docs/superpower/plans/<topic>.md. Report gaps, deviations,\n
         and missing acceptance criteria.",
  role: "spec-reviewer",
  maxSteps: 12
})
```

### Delegate code-quality review

```
subagent({
  task: "Review the changes in <files touched> for: naming, duplication,\n
         error handling, test coverage, obvious perf/security smells.\n
         Do not speculate beyond the diff.",
  role: "code-quality-reviewer",
  maxSteps: 12
})
```

## Gating rule

A task is only complete when:

1. implementer subagent reports **GREEN** with full suite passing.
2. spec-reviewer reports **no gaps**.
3. code-quality-reviewer reports **no blocking findings**.

If any reviewer flags something:

- If trivial / requested change → delegate a new `implementer` subagent
  with the reviewer's list as its task.
- If structural → bring it back to `superpower-brainstorming` or
  `superpower-writing-plans`.

## Red flags

- One subagent doing "implement and review" → not valid (lost fresh
  context).
- You (the parent) overruling a reviewer without evidence → STOP;
  either accept the review or produce counter-evidence.
- Reviewer pass-through with no findings on a 300-LOC diff → likely
  rubber-stamp; try a stricter prompt.

## Tool reminder

This skill is a methodology-mode feature. `role` only takes effect when
`SUPERPOWER_MODE ∈ {methodology, max}` — in `off` / `balanced` the
`subagent` tool logs a warning and falls back to default behaviour.

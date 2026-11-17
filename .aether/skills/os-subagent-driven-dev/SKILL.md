---
name: os-subagent-driven-dev
description: Delegate implementation / OpenSpec review / code quality review to fresh subagents.
order: 50
official: true
version: 1.0.0
---

# Subagent-Driven Development (OSM)

## Chinese 预读

大任务分到干净子代理里做：一个专职 implementer 写代码，一个 spec-reviewer
对照 OpenSpec 审，一个 code-quality-reviewer 审代码质量。三者意见一致才算过。
**严禁跳过评审环节。**

## When to use

- **MANDATORY** for any task in a Superpower plan.
- Small fixes / typos → only exception for direct implementation.

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
  task: "Implement task T3 from .ae/openspec/changes/<feature-name>/tasks.md.\nFollow RED/GREEN/REFACTOR. Stop when green and full suite passes.",
  role: "implementer"
})
```

### Delegate spec review

```
subagent({
  task: "Review the changes in <files touched> against the OpenSpec at .ae/openspec/changes/<feature-name>/proposal.md and design.md.\nReport gaps, deviations, and missing acceptance criteria.",
  role: "spec-reviewer"
})
```

### Delegate code-quality review

```
subagent({
  task: "Review the changes in <files touched> for: naming, duplication, error handling, test coverage, obvious perf/security smells.\nDo not speculate beyond the diff.",
  role: "code-quality-reviewer"
})
```

## Gating rule

A task is only complete when:

1. implementer subagent reports **GREEN** with full suite passing.
2. spec-reviewer reports **no gaps** (confirmed against OpenSpec).
3. code-quality-reviewer reports **no blocking findings**.
4. **OpenSpec task status** is updated to `completed` in `.ae/openspec/changes/<feature-name>/tasks.md`.

If any reviewer flags something:

- If trivial / requested change → delegate a new `implementer` subagent
  with the reviewer's list as its task.
- If structural → bring it back to `os-brainstorming` or
  `os-writing-plans`.

## Red flags

- One subagent doing "implement and review" → not valid (lost fresh
  context).
- You (the parent) overruling a reviewer without evidence → STOP;
  either accept the review or produce counter-evidence.
- Reviewer pass-through with no findings on a 300-LOC diff → likely
  rubber-stamp; try a stricter prompt.

## Tool reminder

This skill is a methodology-mode feature. The role prompt template is
loaded when `OSM_MODE ∈ {methodology, max}` (`SUPERPOWER_MODE` remains a
legacy configuration alias). In `off` / `balanced`, the role still passes
validation and reviewer roles still enforce read-only access, but the
methodology prompt template is not injected. `maxSteps` is not a current
tool parameter; legacy values are ignored by the runtime.

# Agent-engine Tool Mapping

Superpowers skills were originally written for Claude Code and still mention Claude Code's tool aliases in some places (`Bash`, `Read`, `Write`, `Task`, `Grep`, `Glob`, `Edit`, `TodoWrite`, `WebFetch`, `WebSearch`, `Skill`). This project (**agent-engine**) uses a different, explicit set of tool names. If a skill file tells you to use a Claude Code alias, translate it through the table below.

## File tools

| Claude Code alias | agent-engine tool | Notes |
|---|---|---|
| `Read` (file reading) | `read_file` | Pass `path`; choose a supported `mode`, using `exact` for raw text before precise edits. |
| `Read` with offset/limit for large files | `read_file` | Use `start_line` / `end_line`; follow returned `nextStartLine` / `nextStartColumn` paging. These are not Claude's offset/limit parameters. |
| `Write` (file creation / overwrite) | `write_file` | Follow the returned version and ownership contract; shared writes and overwrites require the current `expectedHash`. |
| `Edit` (surgical string replace) | `edit_file` | Pass `path`, the latest `expectedHash`, and `edits: [{oldText, newText}]`; match exact source text. |
| `Glob` (file-name pattern match) | `glob` | |
| `Grep` (content search) | `grep` | Use the registered tool schema; CLI flags are not passed through unchanged. |
| `delete_file` | `delete_file` | (no Claude Code equivalent) |

## Shell

| Claude Code alias | agent-engine tool |
|---|---|
| `Bash` (run shell commands) | `execute_cmd` with the program in `command` and separate `args` array; no implicit shell |
| `Bash(run_in_background=true)` | `execute_cmd` with `background: true`; use `command_output` / `cancel_command` with the returned job ID |

## Subagent

| Claude Code alias | agent-engine tool |
|---|---|
| `Task` (dispatch a subagent) | `subagent` |
| `Task` with role templates (`implementer` / `spec-reviewer` / `code-quality-reviewer`) | `subagent` with the same `role`; in methodology/max mode, the matching `*-prompt.md` from [os-subagent-driven-dev](../../os-subagent-driven-dev/SKILL.md) is added when available. Reviewer read-only restrictions apply independently of template injection. |
| Parallel `Task` calls | Multiple parallel `subagent` calls |

## Todos

| Claude Code alias | agent-engine tool |
|---|---|
| `TodoWrite` (create/update a batch of plan steps) | `plan_update` with the full `plan: [{step, status}]` snapshot; new steps omit `id`, existing steps reuse returned IDs. Omitted steps are removed. Status is `pending` / `in_progress` / `completed` / `cancelled`. |
| Legacy single-item todo creation/update | If exposed, `todo_create` accepts one `title` plus optional `description`, `priority`, `dueAt` — no `items` array. `todo_update` takes `id` and changed fields; its completed status is `done`. Prefer `plan_update` for current plans. |

## Web

| Claude Code alias | agent-engine tool |
|---|---|
| `WebFetch` | `web_fetch` |
| `WebSearch` | No universal built-in search alias; use only a search capability actually registered and authorized in the current session. |
| `http_request` | `http_request` (no Claude Code equivalent — raw HTTP for JSON APIs) |

## Skill discovery

| Claude Code alias | agent-engine tool |
|---|---|
| `Skill` (invoke a named skill — Claude auto-injects content) | `get_skill` — pass the skill `name`; the tool returns the SKILL.md body which the model then follows |
| Listing available skills | `list_skills` |

## Interactive

| Claude Code alias | agent-engine tool |
|---|---|
| `AskUserQuestion` (Claude Code's user prompt) | `ask_user` |

## Memory / knowledge

| Claude Code alias | agent-engine tool |
|---|---|
| (no direct Claude equivalent) | `remember` / `recall` / `forget`, subject to the current memory scope and tool availability |
| (no direct Claude equivalent) | `knowledge_search` for authorized, selected knowledge resources when exposed |

## Cheat sheet for skill authors

When adapting a Claude Code skill to agent-engine:

1. Translate `Bash tool` / `Bash` references to `execute_cmd` and adapt arguments to its program/args schema.
2. Replace every `Read tool` / `Write tool` / `Edit tool` / `Grep tool` / `Glob tool` with the lowercase agent-engine name.
3. Replace every `Task tool` with `subagent` and prefer setting `role` when dispatching standard review roles.
4. Translate `TodoWrite` to `plan_update` using the complete current plan snapshot and the status/ID contract above.
5. Replace every mention of the `Skill` tool with `get_skill`, and remind the model to discover skills through `list_skills` first.
6. When the original skill uses CI/heredoc tricks (e.g. `Use cat <<EOF` to create files from the shell), prefer the `write_file` tool instead — it produces cleaner traces and works identically across platforms.

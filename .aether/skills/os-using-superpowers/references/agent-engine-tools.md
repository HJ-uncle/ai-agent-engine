# Agent-engine Tool Mapping

Superpowers skills were originally written for Claude Code and still mention Claude Code's tool aliases in some places (`Bash`, `Read`, `Write`, `Task`, `Grep`, `Glob`, `Edit`, `TodoWrite`, `WebFetch`, `WebSearch`, `Skill`). This project (**agent-engine**) uses a different, explicit set of tool names. If a skill file tells you to use a Claude Code alias, translate it through the table below.

## File tools

| Claude Code alias | agent-engine tool | Notes |
|---|---|---|
| `Read` (file reading) | `read_file` | For small/whole-file reads. |
| `Read` with offset/limit for large files | `smart_read` | Auto-chunks + summarises oversized files; use this when the file might exceed the default window. |
| `Write` (file creation / overwrite) | `write_file` | Always creates or replaces. |
| `Edit` (surgical string replace) | `edit_file` | Same semantics as Claude's `Edit` — requires an exact match of the old string. |
| `Glob` (file-name pattern match) | `glob` | |
| `Grep` (content search) | `grep` | ripgrep-backed, same flags as before. |
| `delete_file` | `delete_file` | (no Claude Code equivalent) |

## Shell

| Claude Code alias | agent-engine tool |
|---|---|
| `Bash` (run shell commands) | `run_command` |
| `Bash(run_in_background=true)` | `run_command` with `background: true` (see tool schema) |

## Subagent

| Claude Code alias | agent-engine tool |
|---|---|
| `Task` (dispatch a subagent) | `subagent` |
| `Task` with role templates (`implementer` / `spec-reviewer` / `code-quality-reviewer`) | `subagent` with the `role` parameter set to the same name — the matching `*-prompt.md` template from `skills/superpower-subagent-driven-dev/` is auto-prepended to the child's system prompt |
| Parallel `Task` calls | Multiple parallel `subagent` calls |

## Todos

| Claude Code alias | agent-engine tool |
|---|---|
| `TodoWrite` (create a batch of todos) | `todo_create` — one call per todo, or batch via the `items` array |
| Updating an existing todo | `todo_update` |

## Web

| Claude Code alias | agent-engine tool |
|---|---|
| `WebFetch` | `web_fetch` |
| `WebSearch` | `web_search` |
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
| (no direct Claude equivalent) | `memory_store` / `memory_recall` / `memory_forget` |
| (no direct Claude equivalent) | `kb_search` (knowledge-base retrieval) |

## Cheat sheet for skill authors

When adapting a Claude Code skill to agent-engine:

1. Replace every `Bash tool` / `Bash` reference with `run_command`.
2. Replace every `Read tool` / `Write tool` / `Edit tool` / `Grep tool` / `Glob tool` with the lowercase agent-engine name.
3. Replace every `Task tool` with `subagent` and prefer setting `role` when dispatching standard review roles.
4. Replace every `TodoWrite` with `todo_create` (and `todo_update` for updates).
5. Replace every mention of the `Skill` tool with `get_skill`, and remind the model to discover skills through `list_skills` first.
6. When the original skill uses CI/heredoc tricks (e.g. `Use cat <<EOF` to create files from the shell), prefer the `write_file` tool instead — it produces cleaner traces and works identically across platforms.

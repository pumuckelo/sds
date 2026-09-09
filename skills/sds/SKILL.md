---
name: sds
description: Install or adopt SDS when requested, and track development work with its CLI.
---

Read [references/setup.md](references/setup.md) **only** when the user requests installation or repository setup, or the CLI is missing. Do not read it for normal usage. A connection error alone does not mean installation is needed.

- Use `sds` from the checkout; `--project PATH` selects another. Run `sds init` if uninitialized. Do not edit task JSON.
- Use todos for small steps and subtasks for independently tracked work. Prefer two levels; deeper nesting is supported. Create with `sds task create "Title" --parent TASK`; inspect with `sds task list --parent TASK --recursive` or `--roots`.
- Store prerequisites as real task links: create JSON accepts `dependencyIds`; update with `{"type":"dependencies.set","dependencyIds":["TASK_REF"]}` (empty array clears). Refs must belong to the same checkout; cycles are rejected. Read `dependencies` and `dependents` in task get. Links do not automatically change statuses.
- Move a task and its subtree with `sds task move CHILD --parent TASK --revision N`, or `--root` to detach. Parent/child statuses are independent; completing a parent does not complete children.
- Reuse tasks via `sds task list` and `sds task get ID`. Prefer working view and short references.
- Use `--help` for flags; `sds schema update` for batch payloads. JSON uses `--json` or `--stdin`; no temporary files.
- Batch completions: `sds todo complete TASK TODO1 TODO2 --revision N`. Use the latest revision; reread and reconcile conflicts.
- Keep stage/status accurate. Blocked requires a reason. Record decisions/checks as notes and review issues as findings; resolve with evidence.
- Mark done after requested work and checks finish. Leave a next-step note at handoff.
- MCP is optional and uses the same core; follow its tool schemas when used.

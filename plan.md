# SDS plan

Harness-agnostic, repository-owned task management for agents, with a local web dashboard.

## Stack
- TypeScript + Bun; Effect for core operations, validation, typed errors, and filesystem access.
- Hono for HTTP; official MCP SDK with Streamable HTTP at `/mcp`.
- React + Vite + Base UI + shadcn + Tailwind, with our own design.
- Shared core used by MCP and the UI API. Defer a task-management CLI; add Pi integration later.

## Repository data
- `.agent-work/project.json`: persistent project ID and schema version.
- `.agent-work/tasks/<id>.json`: one file per task, containing title, Markdown description, stage, status, todos, findings, and substantive progress notes.
- Stages: planning, implementing, reviewing; allow returning to implementation.
- Statuses: queued, active, blocked, done, cancelled.
- Todos and findings have independent IDs and statuses; findings include severity and optional file/line references.
- Default Nano IDs for stored identities; accept unambiguous short references scoped to checkout/task. Reject ambiguous references.
- Atomic writes, per-task locks, revision checks, and atomic batches within a task.
- Separate files avoid conflicts between newly created tasks; editing the same task across worktrees can still conflict. Prefer one owning worktree per task initially.
- Keep heartbeats, live sessions, and other transient state outside tracked task files.

## Local server and UI
- One local Bun server serves MCP, UI HTTP endpoints, live updates, and built frontend assets.
- Local registry outside Git maps checkout IDs to absolute paths and persistent project IDs; discover tasks within registered checkouts.
- Worktrees share a project ID but have separate checkout IDs. Every agent request explicitly identifies its checkout.
- URLs use checkout/task IDs, not arbitrary filesystem paths. UI groups checkouts by project and shows branch/worktree context.
- Watch task files for dashboard updates; distinguish last reported stage from live agent activity.
- Start with a simple server command; later add an open/register launcher and a stdio bridge if needed.

## Agent interface
- Small typed MCP surface: create, get, list, update tasks.
- Batch todo completions, findings, and stage changes in one validated update.
- Semantic operations rather than raw JSON patches; agents never need to edit storage files.
- Focused working views, filters, paginated history, and compact mutation receipts with the new revision.

## Build order
1. Schemas, repository storage, and core operations.
2. Local server, registry, and MCP tools.
3. Read-only dashboard with live updates.
4. UI editing and Pi integration as needed; CLI only when a concrete workflow requires it.

# SDS

Repository-owned task management for agents. TypeScript + Bun + Effect core, Hono HTTP server, Streamable HTTP MCP, and a React/Vite dashboard built with shadcn Base UI and Tailwind.

## Run

```sh
bun install
bun run build
bun run serve
```

Open http://127.0.0.1:4317 and register an existing local project folder. Registration initializes `.agent-work/project.json` and `.agent-work/tasks/`. The dashboard supports task creation, batch todo completion, workflow changes, review findings, resolutions, and progress notes.

For frontend development, keep `bun run serve` running and start `bun run dev` in another terminal. Vite proxies the API and live updates to port 4317.

Environment variables:

- `SDS_PORT`: server port (default `4317`).
- `SDS_STATE_DIR`: local registry and locks (default `~/.local/state/sds`). All server processes accessing the same checkouts must share this directory.
- `SDS_PROJECT`: optionally register a checkout at startup.

The current development preview runs in the `sds-dev` shared terminal, with `SDS_STATE_DIR` set to this repository’s ignored `.sds-local/state`. Its preview project and sample task are disposable and also ignored. Normal startup uses the default state directory above.

## CLI

Run `bun link` in this repository to expose `sds` on your PATH (requires Bun). Without linking, use `bun /absolute/path/to/sds/src/cli/main.ts`.

```sh
sds init                            # initialize/register the current folder
sds task create "Implement reset"
sds task list
sds task get TASK
sds todo add TASK "Endpoint" "Tests" --revision 1
sds todo complete TASK TODO1 TODO2 --revision 2
sds task stage TASK reviewing --revision 3
sds task status TASK blocked --reason "Waiting for credentials" --revision 4
sds note add TASK "Verified token expiry" --revision 5
```

Complex payloads use inline JSON or stdin. There is no file-input option.

```sh
sds task create --json '{"title":"Reset flow","todos":[{"title":"Endpoint"},{"title":"Tests"}]}'
sds task update TASK --revision 6 --stdin <<'JSON'
{"operations":[{"type":"finding.add","severity":"high","description":"Token can be reused","file":"src/reset.ts","line":12}]}
JSON
```

`task update` also accepts `--json '{"operations":[...]}'`. Supply `--revision` or `expectedRevision` inside the JSON. Both must agree if supplied together. Read `sds schema update`, `sds schema create`, or `sds schema operation` for payload definitions; use `--help` for command flags.

The CLI calls the same Effect core as MCP, without requiring the HTTP server. It resolves the nearest `.agent-work/project.json` from the current directory, stopping at Git boundaries. Use `--project /path/to/checkout` to select another checkout. Existing project metadata is automatically registered on this machine; new projects require `sds init`.

Use the same `SDS_STATE_DIR` (or `--state-dir`) as the server so registry and locks are shared. Task mutations appear through the dashboard's file watcher. CLI activity is not a live heartbeat: heartbeat reporting remains available through the persistent MCP server.

Successful commands emit compact JSON to stdout. Failures emit `{ "error": { "code", "message" } }` to stderr with exit 1, or exit 2 for invalid input. Help is plain text. On a revision conflict, reread and reconcile before retrying.

For automatic workflow guidance, add to the target repository's `AGENTS.md`:

```md
Track development work in SDS. Read the sds skill before using it.
```

## Connect an agent

Configure a Streamable HTTP MCP connection to:

```text
http://127.0.0.1:4317/mcp
```

A common configuration shape is below; adapt the enclosing configuration to your harness:

```json
{
  "mcpServers": {
    "sds": { "url": "http://127.0.0.1:4317/mcp" }
  }
}
```

Tools:

| Tool | Purpose |
| --- | --- |
| `checkout_register` | Register an absolute local folder path; returns its checkout ID and dashboard path. |
| `checkout_list` | Discover registered checkouts. |
| `task_create` | Create a task and initial todos together. |
| `task_list` | Compact summaries, filters, and offset pagination. |
| `task_get` | Working view by default; full details or paginated history on request. |
| `task_update` | Apply a batch of semantic operations atomically at an expected revision. |
| `task_heartbeat` | Report live activity without changing tracked files. |

Every task call requires `checkoutId`. Task, todo, and finding references accept full Nano IDs or unambiguous prefixes of at least four characters. Responses provide short references; ambiguous input fails instead of choosing a match.

Example `task_update` arguments:

```json
{
  "checkoutId": "<checkout-id>",
  "taskId": "<task-ref>",
  "expectedRevision": 3,
  "operations": [
    { "type": "todo.complete", "todoIds": ["<todo-ref>", "<todo-ref>"] },
    { "type": "stage.set", "stage": "reviewing" },
    { "type": "note.add", "text": "Implementation complete. Build and checks passed." }
  ]
}
```

Other operations: `title.set`, `description.set`, `status.set`, `todo.add`, `todo.update`, `finding.add`, and `finding.resolve`. Tool schemas describe each payload. A blocked status requires a reason; finding resolution requires an explanation. A conflict returns an actionable error: retrieve the latest task, reconcile changes, and retry with its revision. A batch either succeeds completely or leaves the task unchanged.

Refresh a running heartbeat every 30 seconds; it expires after 60 seconds. Send `running: false` when finished. Activity is held in server memory and resets on restart. An active task status alone does not mean an agent is running.

## Storage and worktrees

```text
.agent-work/
  project.json
  tasks/<21-character-nanoid>.json
```

Commit `.agent-work/project.json` before creating worktrees so they inherit the same project identity. Each registered checkout has its own local checkout ID, and its own task versions. Tasks, todos, and findings retain their IDs when merged.

One file per task avoids a shared task-index merge hotspot. Simultaneous edits to the same task across branches still require Git conflict resolution. Prefer one owning worktree per task. Locks and revision checks coordinate local SDS writers using the same state directory; external editors and Git operations do not participate in those locks. Interrupted-process locks expire after 30 seconds.

The server binds only to loopback and checks Host/Origin. It is intended for trusted local agents, not network deployment or multi-user hosting. It uses stateless MCP requests; stdio forwarding and a native Pi adapter are deferred. Pi can use the CLI through its shell tool.

## Development

```sh
bun test
bun run typecheck
bun run build
```

Core tests cover atomic rollback, simultaneous writers, short references, worktree isolation, schema errors, and transient activity. Transport tests use the official MCP client and exercise the shared HTTP state.

- `src/core/schema.ts`: domain and command schemas; source of MCP JSON schemas.
- `src/core/storage.ts`: filesystem operations, locks, atomic writes, ID resolution.
- `src/core/service.ts`: shared task operations.
- `src/server/`: HTTP/MCP adapters, live events, startup.
- `src/cli/main.ts`: CLI adapter over the shared core.
- `src/App.tsx`, `src/components/`: dashboard.

Effect is pinned by `bun.lock` to a v4 release candidate; read its installed `AGENTS.md` before changing Effect code. This is a standalone Git repository; no initial commit has been created.

## Compact receipts and multi-task commands

Mutation receipts contain IDs, revisions, counts and newly added refs without echoing todo titles. Pass `--verbose` to include update descriptions and created todo titles (API: `verbose: true`). Full descriptions remain in task history.

```sh
sds task get-many TASK1 TASK2
sds schema update-many
sds task update-many --json '{"updates":[{"taskId":"TASK1","expectedRevision":3,"operations":[{"type":"stage.set","stage":"reviewing"}]},{"taskId":"TASK2","expectedRevision":5,"operations":[{"type":"status.set","status":"active"}]}]}'
```

`--stdin` also accepts this JSON. Batches support up to 100 entries. The entire input shape is validated before writes. Entries then execute in input order, each with its own lock and revision check; repeated refs execute sequentially too. Atomicity applies to one task update, not the whole batch. No automatic retries occur. Results contain ordered `items` with `taskId`, `ok` and `data` or `error`, plus `succeeded` and `failed` counts. CLI exit code is 1 for any failed entry, with the complete result on stdout; invalid batch input exits 2 with an error on stderr and no writes. Read batches are not a transactionally consistent snapshot.

MCP exposes `task_get_many` / `task_update_many`; HTTP exposes `/api/tasks/get-many` / `/api/tasks/update-many`. Both add `checkoutId` to the CLI payload. A valid batch returns its per-entry outcomes normally even with failures; callers must inspect `failed` (MCP `isError` remains false, HTTP status 200).

Storage access errors identify the affected path. For an inaccessible global state directory, grant access or configure `--state-dir` / `SDS_STATE_DIR`. Keep the directory consistent across CLI and server processes so they share locks and registrations.

---
title: CLI guide
description: Every memory CLI verb with its flags — init, query, save, sync, status, and the inspection and maintenance commands.
---

The CLI is the default way to use Memory. The day-to-day surface is small:

```bash
memory query "<question>"   # pull product context mid-task
memory save --stdin         # save product-meaningful changes
memory sync                 # reconcile at session end
memory status               # where things stand
```

Everything else is setup, inspection, or maintenance. All commands accept a
global `--json` flag for structured envelopes.

## The loop

### `memory init`

Initialize Memory storage in this project and print the indexing brief.

```bash
memory init
memory init --dry-run
memory init --no-view
memory init --no-agent-guidance
memory init --force
memory init --brief
```

- Creates `.memory/` storage with a starter `project` node.
- Installs the guidance block and generated product map sections into
  `AGENTS.md` and `CLAUDE.md` (skipped with `--no-agent-guidance`).
- Starts the local viewer (skipped with `--no-view`).
- Prints the indexing brief the coding agent follows to build the initial
  graph. `--brief` prints only the brief and touches nothing.
- `--dry-run` previews what init would create or change without writing.
- `--force` discards existing Memory storage and initializes from scratch.

### `memory query <question>`

Query local Memory and print a token-budgeted Markdown subgraph of matching
memory.

```bash
memory query "why do webhook retries run in the worker?"
memory query "state of batch exports" --budget 1200
```

- Seeds on full-text matches, expands one hop along active relations, and
  attaches connected open questions.
- `--budget <number>` overrides the token budget (default comes from
  `.memory/config.json`, initially 2000).

### `memory save --stdin`

Save product memory from intent-first input: create or update
feature/decision/gotcha/question nodes, mark stale, supersede, or delete.

```bash
memory save --stdin
memory save --stdin --dry-run
```

- `--stdin` is required; the input is JSON with the shape
  `{task, nodes, stale, supersede, delete}`. See the
  [Reference](/reference/#save-input) for the exact node fields.
- `--dry-run` validates and plans the write without changing anything.
- Every successful save refreshes the product map in `AGENTS.md`/`CLAUDE.md`.

### `memory sync`

Run the diff-driven staleness pass: report nodes whose anchors changed or died
since the last sync, list coverage gaps, refresh the product map, and advance
the sync marker.

```bash
memory sync
memory sync --dry-run
```

- Diffs the tree since the commit recorded in `.memory/sync-state.json`.
- Reports changed, orphaned, and unanchored nodes plus directories with code
  but no feature coverage, and prints an agent prompt with a pre-filled save
  skeleton when reconciliation is needed.
- Never writes graph nodes itself. `--dry-run` reports without advancing the
  marker or refreshing the map.

### `memory status`

Summarize the product graph: features by stage, open questions, stale anchors,
last activity, and last sync.

```bash
memory status
memory status --all
```

- `--all` prints one row per registered project from the user-level registry
  (`~/.memory/projects.json`) — the cross-project dashboard.

## Inspection

### `memory check`

Validate canonical storage and generated index health. Also warns when anchors
match no files or the product map sections in `AGENTS.md`/`CLAUDE.md` are
missing or out of date.

```bash
memory check
memory check --json
```

### `memory diff`

Show Memory changes, including untracked memory files in Git projects. Plain
`git diff -- .memory/` can miss untracked files before staging.

```bash
memory diff
```

### `memory inspect <id>`

Show one Memory object and its direct relations.

```bash
memory inspect feature.webhook-retry-queue
```

### `memory view`

Start the local viewer: projects dashboard, memory list, node detail, and the
relation graph. Binds to `127.0.0.1` only.

```bash
memory view
memory view --open
memory view --port 4888
memory view --detach
```

- `--open` opens the URL in the default browser.
- `--port <number>` picks the port (random available port by default).
- `--detach` starts the viewer in a background process and prints its URL.

## Maintenance

### `memory rebuild`

Rebuild generated indexes from canonical storage. Does not change canonical
memory.

```bash
memory rebuild
```

### `memory projects`

Manage the user-level project registry behind `memory status --all` and the
viewer's projects dashboard.

```bash
memory projects list
memory projects add            # registers the current directory
memory projects add /path/to/project
memory projects remove <registry-id|project-id|path>
memory projects prune          # drop entries whose storage is gone
```

### `memory reset`

Back up and clear local Memory storage. The backup archive lands under
`.memory/.backup/`.

```bash
memory reset
memory reset --all       # every project in the registry
memory reset --destroy   # delete .memory/ entirely, no backup
```

### `memory upgrade`

Removed as a migration path. Storage created by older schema versions is not
migrated; run `memory reset` then `memory init` and rebuild the graph from the
indexing brief.

### `memory docs`

Read bundled public docs or open the hosted docs site.

```bash
memory docs
memory docs getting-started
memory docs cli --open
memory docs --json
```

## MCP

MCP covers query, save, status, and inspect when the client has launched
`memory-mcp`. Everything else — init, sync, viewer, registry, maintenance —
stays in the CLI. See the [MCP guide](/mcp/).

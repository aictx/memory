---
title: Reference
description: Schema v5 — node kinds, sidecar fields, statuses, predicates, save input, config, storage layout, and the sync marker.
---

Exact names and shapes for storage schema v5.

## Node kinds

Object types are `project`, `feature`, `decision`, `gotcha`, and `question`.

- `project` — one per repo, created by `memory init`; its title and first
  body sentence head the generated product map.
- `feature` — carries an optional `stage` and `anchors`.
- `decision`, `gotcha`, `question` — title plus Markdown body.

`memory save` accepts node kinds `feature`, `decision`, `gotcha`, and
`question`; the `project` node is created by init and updated by id.

## Ids

Object ids are `kind.slug`, matching:

```text
^[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9-]*$
```

Examples: `feature.webhook-retry-queue`, `decision.retries-run-in-worker`.

## Statuses

Object statuses: `active`, `stale`, `superseded`, `open`, `closed`.
Questions use `open`/`closed`; other kinds use `active`/`stale`/`superseded`.

Relation statuses: `active`, `stale`, `rejected`.

## Stages

Feature-only lifecycle stage: `idea`, `building`, `shipped`, `paused`, `dead`.
The product map groups features by stage and excludes `dead` features.

## Relations

Predicates: `affects`, `depends_on`, `supersedes`, `related_to`.
Optional confidence: `low`, `medium`, `high`.

## Sidecar fields

Each node is a JSON sidecar plus a Markdown body file. Sidecar shape:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | `kind.slug` |
| `type` | string | One of the five kinds |
| `status` | string | See statuses above |
| `title` | string | |
| `body_path` | string | Relative path of the Markdown body |
| `stage` | string? | Feature-only |
| `anchors` | string[]? | Repo-relative path globs, e.g. `src/billing/` |
| `tags` | string[]? | Unique non-empty strings |
| `evidence` | object[]? | `{kind, id}`, kind in `memory`, `relation`, `file`, `commit`, `task`, `source` |
| `source` | object? | `{kind, task?, commit?}`, kind in `agent`, `user`, `cli`, `mcp`, `system` |
| `origin` | object? | `{kind, locator, captured_at?, digest?, media_type?}` for external provenance |
| `superseded_by` | string? | Set when status is `superseded` |
| `content_hash` | string | SHA-256 of the body |
| `created_at` / `updated_at` | string | ISO date-times |

## Save input

`memory save --stdin` and the `save_memory` MCP tool take the same intent
JSON:

```json
{
  "task": "Ship retry handling for Stripe webhooks",
  "nodes": [
    {
      "id": "feature.webhook-retry-queue",
      "kind": "feature",
      "title": "Webhook retry queue",
      "body": "Failed Stripe webhooks re-enter a worker-owned retry queue.",
      "stage": "building",
      "anchors": ["services/billing/src/webhooks/"],
      "tags": ["billing"],
      "related": [
        { "predicate": "depends_on", "to": "feature.billing-worker", "confidence": "high" }
      ]
    }
  ],
  "stale": [{ "id": "gotcha.old-retry-loop", "reason": "fixed by the new queue" }],
  "supersede": [
    {
      "id": "decision.inline-retries",
      "superseded_by": "decision.retries-run-in-worker",
      "reason": "moved to worker"
    }
  ],
  "delete": [{ "id": "question.retry-owner", "reason": "answered" }]
}
```

Rules:

- `task` is required; `nodes`, `stale`, `supersede`, and `delete` are
  optional arrays.
- A node with an `id` that resolves to an existing object is an update;
  otherwise it is a create. `kind`, `title`, and `body` are required on
  create.
- `stage` is feature-only. `related` entries create relations from this node.
- `--dry-run` validates and plans without writing. Every successful save
  refreshes the product map and rebuilds the index.

## Config

`.memory/config.json`:

```json
{
  "version": 5,
  "project": { "id": "project.my-repo", "name": "My Repo" },
  "memory": { "defaultTokenBudget": 2000, "autoIndex": true }
}
```

- `version` is the storage schema version. Memory refuses to operate on
  storage with a different version; recovery is `memory reset` then
  `memory init` (there is no migration pre-1.0).
- `defaultTokenBudget` is the `memory query` budget when `--budget` is not
  passed.

## Storage layout

```text
.memory/
  config.json            # schema version, project identity, defaults
  memory/<slug>.json     # node sidecars
  memory/<slug>.md       # node bodies
  relations/<slug>.json  # relations
  schema/                # bundled JSON schemas for validation
  events.jsonl           # append-only event log
  sync-state.json        # committed sync marker
  index/                 # generated SQLite FTS index (gitignored)
  recovery/              # pre-overwrite backups of dirty files (gitignored)
  .backup/               # reset archives (gitignored)
```

Canonical files are meant to be committed and reviewed; everything generated
is gitignored and rebuildable with `memory rebuild`.

## Sync marker

`.memory/sync-state.json`:

```json
{ "version": 1, "last_sync_commit": "<git sha>" }
```

`memory sync` diffs `last_sync_commit..HEAD` plus working-tree changes, and
advances the marker on a non-dry run. A missing or invalid marker triggers a
full anchor verification instead of failing.

## Project registry

`memory status --all`, `memory projects`, and the viewer's projects dashboard
read the user-level registry at `$MEMORY_HOME/projects.json`, defaulting to
`~/.memory/projects.json`. The registry stores project roots and metadata for
discovery; canonical memory stays in each project's own `.memory/` directory.

## Events

Canonical events in `events.jsonl`: `memory.created`, `memory.updated`,
`memory.marked_stale`, `memory.superseded`, `memory.deleted`,
`relation.created`, `relation.updated`, `relation.deleted`, `index.rebuilt`.

---
title: Capabilities
description: What Memory can do, grouped by the jobs users and agents actually need.
---

Memory is built around a small loop: build the product graph once, query it on
demand, save product-meaningful changes, and reconcile at session end. Every
command serves one of those jobs or helps a human inspect and repair storage.

## Build the graph

```bash
memory init
memory init --brief
```

`init` creates `.memory/` storage, installs the guidance block and generated
product map into `AGENTS.md`/`CLAUDE.md`, starts the viewer, and prints the
indexing brief. The brief is the agent's instructions for the initial graph:
explore the repo, interview the user for intent and stage, save once.
`--brief` reprints it any time.

## Query on demand

```bash
memory query "why do webhook retries run in the worker?"
memory query "state of batch exports" --budget 1200
memory inspect feature.batch-exports
```

- `query` returns a token-budgeted Markdown subgraph: full-text matches,
  their one-hop relations, and connected open questions.
- `inspect` opens one node and its direct relations.

There is no per-task loading step. The product map in the agent instruction
files is the always-on overview; everything deeper is a query away.

## Save product changes

```bash
memory save --stdin
memory save --stdin --dry-run
```

`save` takes intent JSON — `{task, nodes, stale, supersede, delete}` — and
validates it into graph writes. Update existing nodes by `id`; retire wrong
memory with `stale`, `supersede`, or `delete` instead of duplicating. Every
save refreshes the product map.

:::tip
When a correction reveals old memory was wrong, update, stale, supersede, or
delete the existing node instead of creating a near-duplicate.
:::

## Keep it honest

```bash
memory sync
memory sync --dry-run
memory status
memory status --all
memory check
```

- `sync` is the session-end ritual: diff-driven anchor verification, a report
  of changed/orphaned/unanchored nodes and coverage gaps, and a pre-filled
  save skeleton when reconciliation is needed.
- `status` summarizes features by stage, open questions, stale anchors, and
  last activity. `status --all` is the cross-project dashboard.
- `check` validates storage and warns about dead anchors and out-of-date
  product map sections.

## Human inspection

```bash
memory view --open
memory diff
memory projects list
memory docs
```

`view` starts the local browser viewer: projects dashboard, memory list, node
detail, and the relation graph. `diff` shows tracked and untracked `.memory/`
changes. `projects` manages the user-level registry behind `status --all` and
the viewer. `docs` prints bundled docs topics or opens the hosted site.

## Repair and recovery

```bash
memory rebuild
memory reset
memory reset --all
```

- `rebuild` recreates the generated index from canonical files.
- `reset` backs up storage to `.memory/.backup/` and clears it; `reset --all`
  does it for every registered project. After a breaking package upgrade, the
  recovery path is `memory reset` then `memory init` — there is no storage
  migration pre-1.0.

## MCP

MCP covers query, save, status, and inspect when your client launches
`memory-mcp`. Init, sync, viewer, registry, and maintenance stay in the CLI.
See the [MCP guide](/mcp/) and [Reference](/reference/).

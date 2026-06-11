# Memory

![Memory keeps the product graph of a codebase: features, decisions, and status, anchored to the code and queryable by agents.](site/public/assets/readme-value-header.png)

<p align="center">
  <a href="https://memory.aictx.dev"><img alt="Website" src="https://img.shields.io/badge/website-memory.aictx.dev-111214?style=for-the-badge"></a>
  <a href="https://docs.aictx.dev"><img alt="Docs" src="https://img.shields.io/badge/docs-read-111214?style=for-the-badge"></a>
  <a href="https://demo.aictx.dev/?token=demo"><img alt="Live demo" src="https://img.shields.io/badge/demo-viewer-111214?style=for-the-badge"></a>
</p>

<p align="center">
  <a href="https://github.com/aictx/memory/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/aictx/memory/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/aictx/memory/actions/workflows/codeql.yml"><img alt="CodeQL" src="https://github.com/aictx/memory/actions/workflows/codeql.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@aictx/memory"><img alt="npm" src="https://img.shields.io/npm/v/@aictx/memory"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
</p>

**Your agent knows your code. It doesn't know your product.**

Memory keeps the product graph of a codebase: features with their lifecycle
stage, decisions with their reasons, gotchas, and open questions — anchored to
the code paths they describe. Agents query it on demand and keep it current as
the product changes.

If you run several projects with AI coding agents, you know the failure mode.
You come back to a repo after three weeks. Neither you nor the agent remembers
what is shipped, what is half-done, why the queue lives in the worker, or what
was decided about storage. The agent can re-derive code structure cheaply; it
cannot re-derive intent, stage, or rationale, because that knowledge is not in
the repo. So you re-explain, or the agent guesses.

Memory stores that product layer as plain local files in `.memory/`: JSON
sidecars with Markdown bodies, indexed with SQLite full-text search. No
embeddings, no cloud account, no model API. Saved memory is reviewable in Git
like any other change. Code-graph tools map what is in the repo; Memory
captures what isn't.

This repository publishes the npm package `@aictx/memory` and the Homebrew
formula `aictx/tap/memory`. It ships the `memory` CLI and the optional
`memory-mcp` server.

## How It Works

![Memory workflow: build the product graph once, query it on demand, keep it synced.](site/public/assets/readme-how-it-works.png)

```text
init once -> query on demand -> save product changes -> sync at session end
```

1. **`memory init`** — once per repo. Creates `.memory/` storage, installs a
   short guidance block plus an auto-generated **product map** into `AGENTS.md`
   and `CLAUDE.md` (marker sections), starts the local viewer, and prints an
   **indexing brief**. Your coding agent follows the brief to build the initial
   graph: explore the repo, interview you for intent, stage, and decisions,
   then save everything in one call.
2. **`memory query "<question>"`** — on demand, mid-task. Returns a
   token-budgeted Markdown subgraph: full-text matches, their one-hop
   relations, and connected open questions. There is no per-task context
   loading; the only always-on context is the roughly one-screen product map.
3. **`memory save --stdin`** — after product-meaningful changes. The input is
   intent JSON: `{task, nodes, stale, supersede, delete}`. The product map in
   `AGENTS.md`/`CLAUDE.md` refreshes automatically on every save.
4. **`memory sync`** — at session end or after merging. Diff-driven: verifies
   anchors against the actual tree, reports nodes whose anchored code changed,
   orphaned anchors, and coverage gaps, then prints an agent prompt with a
   pre-filled save skeleton. Sync is mechanical — it never writes graph nodes
   itself.
5. **`memory status`** — features by stage, open questions, stale anchors,
   last activity and sync. **`memory status --all`** is the cross-project
   dashboard: one row per registered project, for people running many repos
   with agents.

### The product map

The map is the only thing agents carry into every session. It is generated,
capped at roughly one screen, and refreshed by `save` and `sync`:

```markdown
## Product map (generated — do not edit; refresh with memory save or memory sync)
Acme Render — Self-hosted PDF render service for invoice pipelines.

**Building:** webhook-retry-queue — Failed Stripe webhooks re-enter a worker-owned retry queue. — services/billing/src/webhooks/
**Shipped:** pdf-render-api — Renders invoice templates to PDF over HTTP. — services/render/ · template-editor — In-browser template editing with live preview. — apps/editor/
**Paused:** batch-exports — Nightly bulk export of rendered documents. — services/exports/

**Recent decisions:** retries-run-in-worker — Webhook retries run in the queue worker · sqlite-over-postgres — SQLite for single-node deployments

**Open questions:** pdf-storage-location — Where do rendered PDFs live long-term?
```

Everything deeper is pull, not push: `memory query` when the agent needs it.

## Get Started Quickly

Memory requires Node.js `>=22`. The Homebrew formula installs Node through
Homebrew; npm installs require a compatible Node already on `PATH`. Core
commands run locally; no cloud account, model API, embeddings, or hosted sync
are required.

```bash
# macOS/Linux with Homebrew
brew install aictx/tap/memory

# or npm
npm install -g @aictx/memory

cd path/to/your/repo
memory init
```

`memory init` creates local storage, installs the guidance block and product
map sections, starts the viewer, and prints the indexing brief for your agent.
Use `memory init --no-view` to skip the viewer, `memory init --dry-run` to
preview, or `memory init --brief` to reprint the brief later.

Memory writes local files and never commits automatically.

## Ask an Agent to Activate It

Paste this into Claude Code, Codex, OpenCode, Cursor, Cline, or another
CLI-capable coding agent from the project root:

```text
Set up Memory for this repository.

Install Memory with one of:
brew install aictx/tap/memory
npm install -g @aictx/memory

Then run from the project root:
memory init

Follow the printed indexing brief: explore the repo, draft the product graph
(features with stage and anchors, decisions with their reasons, gotchas, open
questions), interview me for what the repo cannot tell you, and save it all in
one `memory save --stdin` call.

When this is done, report:
- what the product map in AGENTS.md/CLAUDE.md now shows
- what `memory status` reports
- how I can inspect the graph with `memory view`
```

After the initial graph exists, the ongoing loop is small:

```bash
memory query "why do webhook retries run in the worker?"
# do the work
memory save --stdin
memory sync   # at session end
```

## What Gets Stored

Five kinds of node, four relation predicates.

| Kind | What it holds |
| --- | --- |
| `project` | One per repo: what this product is. Created by `init`, feeds the map header. |
| `feature` | What the product does for users. Carries a `stage` (`idea`, `building`, `shipped`, `paused`, `dead`) and `anchors` — repo-relative path globs linking it to code. |
| `decision` | A choice and the reason it was made. |
| `gotcha` | A known trap or failure mode. |
| `question` | An open product or technical question that affects future work. |

Nodes connect through `affects`, `depends_on`, `supersedes`, and `related_to`
relations. Anchors are what make staleness mechanical: when anchored files
change or disappear, `sync` and `status` report exactly which nodes need
re-verification.

What this buys you, concretely:

- Pick any project back up cold — the map and graph carry what is shipped,
  half-done, and why.
- Agent answers grounded in product reality instead of guesses from code.
- Decisions that survive sessions, branches, and agent switches.
- Mechanical staleness detection through anchors, not vibes.
- Memory you can review, diff, and fix in Git.

## The Sync Ritual

`memory sync` is how the graph stays honest without re-reading the repo:

```bash
memory sync
```

It diffs the tree since the last sync marker (`.memory/sync-state.json`),
checks every anchor against the current files, and reports four things: nodes
whose anchored code changed, nodes whose anchors match nothing anymore, nodes
with no anchors, and directories with real code but no feature coverage. When
something needs attention it prints an agent prompt with a pre-filled
`memory save --stdin` skeleton, so reconciliation is one save call. Run it at
session end or after merging others' work. `--dry-run` reports without
advancing the marker.

## Inspect the Graph

<p align="center">
  <a href="https://demo.aictx.dev/?token=demo">
    <img
      alt="Memory viewer showing the memory schema graph with relation overview and canonical storage navigation."
      src="site/public/assets/readme-visual-memory.png"
      width="940"
    >
  </a>
  <br>
  <sub>The local viewer: projects dashboard, memory list, node detail, and the relation graph.</sub>
</p>

`memory view` starts a local browser viewer bound to `127.0.0.1`: a projects
dashboard, the memory list, node detail, and an interactive relation graph.
`memory inspect <id>` does the same for one node in the terminal, and
`memory diff` shows tracked and untracked `.memory/` changes.

## Works With Your Agent

| Agent or client | Fastest path |
| --- | --- |
| Claude Code | `memory init` writes the guidance block and product map into `CLAUDE.md`. |
| Codex | `memory init` writes `AGENTS.md`; use the CLI loop by default. |
| OpenCode | Uses the root `AGENTS.md` guidance created by init. |
| Cursor | Copy `integrations/cursor/memory.mdc` into `.cursor/rules/memory.mdc`, then run init. |
| Cline | Copy `integrations/cline/memory.md` into `.clinerules/memory.md`, then run init. |
| MCP-capable clients | Start with the CLI; configure `memory-mcp` for `query_memory`, `save_memory`, `status_memory`, and `inspect_memory` tools. |

Codex users can add this repo's plugin marketplace with one command:

```bash
codex plugin marketplace add aictx/memory
```

Claude Code users can add the marketplace and install the plugin from inside
Claude Code:

```text
/plugin marketplace add aictx/memory
/plugin install memory@aictx
```

For official listing paths and release prep, see
[Publishing agent plugins](https://docs.aictx.dev/plugin-publishing/).

## Project Status and Upgrade Recovery

Memory is pre-1.0. Breaking changes should be expected across package versions
while the schema and local storage format are still evolving. There is no
storage migration: when a new version rejects existing `.memory/` storage,
reset and re-index from the project root:

```bash
memory reset
memory init
```

`memory reset` creates a backup archive under `.memory/.backup/` before
clearing local storage. To rebuild the graph afterwards, ask your coding agent:

```text
Memory was reset after a package upgrade. Run `memory init` and follow the
indexing brief to rebuild the product graph. Inspect the newest archive in
.memory/.backup/ for prior features, decisions, gotchas, and open questions,
and re-save only what is still true in one `memory save --stdin` call. Do not
copy old storage files back; validate the result with `memory check`.
```

## Documentation

- [Getting started](https://docs.aictx.dev/getting-started/)
- [Mental model](https://docs.aictx.dev/mental-model/)
- [Capabilities](https://docs.aictx.dev/capabilities/)
- [CLI reference](https://docs.aictx.dev/cli/)
- [MCP](https://docs.aictx.dev/mcp/)
- [Agent integration](https://docs.aictx.dev/agent-integration/)
- [Reference](https://docs.aictx.dev/reference/)

## Contribute

Memory is MIT-licensed and built in the open. Issues, docs fixes, examples,
and pull requests are welcome.

[Contribute on GitHub](https://github.com/aictx/memory/blob/main/CONTRIBUTING.md)

## Project identity

Memory by Aictx keeps the product graph of a codebase for AI coding agents:
features with stage and code anchors, decisions with their reasons, gotchas,
and open questions, stored as reviewable local files. It is distributed
through the open source npm package `@aictx/memory` and the Homebrew formula
`aictx/tap/memory`, then runs through the `memory` CLI and optional
`memory-mcp` server.

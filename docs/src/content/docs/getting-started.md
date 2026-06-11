---
title: Getting started
description: Install Memory, run init, build the first product graph from the indexing brief, and run the query/save/sync loop.
---

Memory works inside an existing project. This page gets you from install to a
working product graph: local `.memory/` storage, a generated product map in
your agent instruction files, and the ongoing query/save/sync loop.

## What you need

- Homebrew, or Node.js `>=22` when installing with npm
- A repo you work on with AI coding agents

Check Node with:

```bash
node --version
```

## Install

Install with Homebrew on macOS/Linux:

```bash
brew install aictx/tap/memory
```

Or install globally with npm when Node.js `>=22` is already available:

```bash
npm install -g @aictx/memory
```

A project-local dependency is useful when a repo needs to pin its own Memory
version:

```bash
pnpm add -D @aictx/memory
npm install -D @aictx/memory
```

When `memory` is not on `PATH`, run it through the package manager or local
binary:

```bash
pnpm exec memory status
npm exec memory status
./node_modules/.bin/memory status
npx --package @aictx/memory -- memory status
```

## Initialize

From the project root, run:

```bash
memory init
```

`init` does four things:

1. Creates `.memory/` storage with a starter `project` node and empty graph.
2. Installs two marker sections into `AGENTS.md` and `CLAUDE.md`: a short
   guidance block (how agents should use Memory) and a generated **product
   map** (initially a placeholder).
3. Starts the local viewer.
4. Prints the **indexing brief** — the instructions a coding agent follows to
   build the initial product graph.

Useful variants:

```bash
memory init --dry-run             # preview without writing anything
memory init --no-view             # skip viewer startup
memory init --no-agent-guidance   # skip AGENTS.md/CLAUDE.md changes
memory init --brief               # print only the indexing brief, touch nothing
memory init --force               # discard existing storage and start over
```

## Build the first graph

Init itself stays mechanical; building the graph is the agent's job. Give the
printed brief to your coding agent (or paste the [first-time setup
prompt](/)). The brief tells the agent to:

1. Explore the repo: README, package manifests, entrypoints, docs, recent git
   log.
2. Draft 3–10 `feature` nodes — what the product does for its users — each
   with a `stage` (`idea`, `building`, `shipped`, `paused`, `dead`) and
   `anchors` (repo-relative path globs like `src/billing/`); plus key
   `decision` nodes with their reasons, known `gotcha` nodes, and open
   `question` nodes.
3. Interview you for what the repo cannot tell it: product intent, the real
   stage of each feature, decisions and why, what is abandoned versus merely
   paused.
4. Save everything in one call:

```bash
memory save --stdin <<'JSON'
{"task": "initial product graph",
 "nodes": [
   {"kind": "feature", "title": "PDF render API", "body": "Renders invoice templates to PDF over HTTP.", "stage": "shipped", "anchors": ["services/render/"]},
   {"kind": "decision", "title": "Retries run in the worker", "body": "Webhook retries execute in the queue worker, not the HTTP handler, so handler latency stays flat."},
   {"kind": "question", "title": "Where do rendered PDFs live long-term?", "body": "Local disk works for single-node; S3 is unresolved."}
 ]}
JSON
```

5. Verify with `memory status` and `memory check`. The product map in
   `AGENTS.md`/`CLAUDE.md` refreshes automatically on save.

The interview step matters. Stage and rationale are exactly the things the
code cannot answer — that is why they are worth storing.

## The ongoing loop

Mid-task, when an agent (or you) needs product context, query instead of
preloading:

```bash
memory query "why do webhook retries run in the worker?"
memory query "what is the state of batch exports?" --budget 1200
```

After product-meaningful changes — feature behavior added or changed, a
decision taken, a gotcha discovered, a question opened or answered:

```bash
memory save --stdin
```

A task that changed no product reality needs no save.

At session end, or after merging others' work:

```bash
memory sync
```

`sync` diffs the tree since the last sync marker, verifies every anchor, and
reports nodes whose anchored code changed, dead anchors, and coverage gaps —
with a pre-filled save skeleton when something needs reconciling.

Check where things stand any time:

```bash
memory status        # this project: features by stage, open questions, stale anchors
memory status --all  # one row per registered project
memory view          # local browser viewer
memory diff          # tracked and untracked .memory/ changes
```

:::tip
Use `memory diff` for memory review in Git projects. Plain
`git diff -- .memory/` can miss untracked memory files before they are staged.
:::

## Next

- [Mental model](/mental-model/) — how the graph, map, query, and sync fit
  together, and what is worth saving.
- [CLI guide](/cli/) — every verb and flag.
- [MCP guide](/mcp/) — the four MCP tools for clients that run `memory-mcp`.

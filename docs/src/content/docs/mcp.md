---
title: Memory MCP server
description: Configure the Memory MCP server and use the four tools — query_memory, save_memory, status_memory, and inspect_memory.
---

`memory-mcp` is an MCP stdio server. Configure your MCP client to launch the
global binary, or a project-local binary when the project pins Memory.

Use MCP when your agent client already supports MCP tools and you want the
routine Memory actions — query, save, status, inspect — inside that client.
Init, sync, viewer, registry, and maintenance workflows stay in the CLI.

:::tip
`memory init` creates local storage; it does not add MCP tools to a running
agent session. Configure the client to launch `memory-mcp`, then start a new
session.
:::

## Install

A Homebrew or global npm install gives the simplest setup:

```bash
brew install aictx/tap/memory
```

```bash
npm install -g @aictx/memory
```

The MCP client can launch the global binary:

```bash
memory-mcp
```

With a project-local package install, the client can launch through the project
package manager:

```bash
pnpm exec memory-mcp
npm exec memory-mcp
```

For one-off package resolution, name the scoped package explicitly:

```bash
npx --package @aictx/memory -- memory-mcp
```

For a local binary path, configure the client to launch:

```bash
./node_modules/.bin/memory-mcp
```

MCP uses stdout for the protocol. Startup diagnostics and failures are written
to stderr.

## Tools

The local MCP server exposes exactly four tools.

### `query_memory`

CLI equivalent: `memory query`. Returns a token-budgeted Markdown subgraph of
matching memory.

```text
query_memory({
  question: "why do webhook retries run in the worker?",
  budget: 1200            // optional token budget
})
```

### `save_memory`

CLI equivalent: `memory save --stdin`. Saves durable product memory from
intent-first input: create or update feature/decision/gotcha/question nodes,
mark stale, supersede, or delete.

```text
save_memory({
  task: "Ship retry handling for Stripe webhooks",
  nodes: [
    {
      kind: "feature",                       // feature | decision | gotcha | question
      title: "Webhook retry queue",
      body: "Failed Stripe webhooks re-enter a worker-owned retry queue.",
      stage: "building",                     // feature-only
      anchors: ["services/billing/src/webhooks/"],
      tags: ["billing"],
      related: [{ predicate: "depends_on", to: "feature.billing-worker", confidence: "high" }]
    }
  ],
  stale: [{ id: "gotcha.old-retry-loop", reason: "fixed by the new queue" }],
  supersede: [{ id: "decision.inline-retries", superseded_by: "decision.retries-run-in-worker", reason: "moved to worker" }],
  delete: [{ id: "question.retry-owner", reason: "answered" }]
})
```

All top-level arrays are optional; `task` is required. Pass an existing `id`
in a node to update it; `kind`, `title`, and `body` are required only when
creating. Writes are serialized per project.

### `status_memory`

CLI equivalent: `memory status`. Summarizes the product graph: features by
stage, open questions, stale anchors, last activity, and last sync.

```text
status_memory({})
```

### `inspect_memory`

CLI equivalent: `memory inspect <id>`. Shows one Memory object and its direct
relations.

```text
inspect_memory({ id: "decision.retries-run-in-worker" })
```

## Project scoping

When the MCP server was launched globally rather than from the project root,
every tool accepts an optional `project_root` to select the initialized
project:

```text
query_memory({
  project_root: "/path/to/project",
  question: "what is shipped?"
})
```

`project_root` chooses an initialized local Memory project. It is not
arbitrary filesystem access; reads and writes remain scoped to that project's
`.memory/` directory.

## CLI-only work

These workflows stay in the CLI:

- Setup: `memory init`
- Session reconciliation: `memory sync`
- Validation and maintenance: `memory check`, `memory rebuild`,
  `memory reset`, `memory diff`
- Registry and viewer: `memory projects`, `memory view`
- Docs: `memory docs`

The viewer is a browser inspection surface, so `memory view` has no MCP
equivalent.

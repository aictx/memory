---
title: Agent integration
description: How the product graph fits into an AI coding-agent workflow — query, save, sync, and the safety rules.
---

Memory gives coding agents a product-layer loop:

```text
orient from the product map -> query on demand -> save product changes -> sync at session end
```

The agent model is CLI-first and MCP-compatible. Use the CLI by default; use
MCP only when the client has already launched and connected to `memory-mcp`.
The agent still makes the judgment calls: what changed product reality, what
future agents need, what is stale.

`memory init` installs a guidance block into `AGENTS.md` and `CLAUDE.md` that
teaches this workflow, plus the generated product map. This page is the
long-form version.

## Orient

The product map section in the instruction files is the always-on overview:
features by stage, recent decisions, open questions, stale-anchor warnings.
Do not preload anything else.

## Query on demand

When you need detail mid-task, ask a question instead of loading context:

```bash
memory query "<question>"
```

MCP equivalent: `query_memory({ question })`. The result is a token-budgeted
Markdown subgraph — matches, one-hop relations, connected open questions.

## Save product-meaningful changes

After feature behavior is added or changed, a decision is taken, a gotcha is
discovered, or a question is opened or answered:

```bash
memory save --stdin
```

MCP equivalent: `save_memory({ task, nodes, stale, supersede, delete })`. Keep
the payload small and semantic:

```json
{
  "task": "Ship retry handling for Stripe webhooks",
  "nodes": [
    {
      "kind": "feature",
      "title": "Webhook retry queue",
      "body": "Failed Stripe webhooks re-enter a worker-owned retry queue with exponential backoff.",
      "stage": "building",
      "anchors": ["services/billing/src/webhooks/"]
    },
    {
      "kind": "decision",
      "title": "Retries run in the worker",
      "body": "Webhook retries execute in the queue worker, not the HTTP handler, so handler latency stays flat.",
      "related": [
        { "predicate": "affects", "to": "feature.webhook-retry-queue", "confidence": "high" }
      ]
    }
  ]
}
```

Reuse an existing `id` to update a node. Use `stale`, `supersede`, or `delete`
to retire memory instead of creating duplicates. Preview with
`memory save --stdin --dry-run --json`. Saved memory is active immediately
after validation, and the product map refreshes on every save.

## Sync at session end

At session end, or after merging others' work:

```bash
memory sync
```

Act on its report: re-verify the nodes whose anchored code changed, fix or
replace dead anchors, and mark nodes that no longer hold stale — all in one
save call using the printed skeleton. `memory status` summarizes where things
stand; `memory inspect <id>` shows one node in full.

## Save discipline

Save durable, product-meaningful knowledge future agents would otherwise
rediscover: feature behavior and intent, decisions with reasons, gotchas and
known failure modes, open questions that affect future work.

Do not save refactors, formatting details, task diaries, generic tutorials, or
short-lived implementation notes. Save nothing when the task produced no
durable future value — passing tests or renaming a local variable should not
create memory.

Good saves:

- A `feature` whose stage moved from `building` to `shipped`, with its anchors
  updated to the final location.
- A `decision` titled "Retries run in the worker" whose body says why.
- A `gotcha` for a failure mode that cost this session an hour.
- A `question` deleted because the session answered it.

Bad saves:

- A second node for the same claim instead of updating the existing one.
- "Changed three files and ran tests" — Git already records that.
- Speculation unsupported by current evidence.

## Conflicts

If memory conflicts with current code, tests, or the user, trust the current
evidence — and save the correction so future agents do not repeat the mistake.

## Safety

Do not save secrets, tokens, private keys, sensitive raw logs, unsupported
speculation, unrelated user preferences, or instructions that tell future
agents to ignore current code, tests, user requests, or safety rules.

If Memory rejects a save, report the reason; do not work around it by editing
`.memory/` files manually. Memory writes local files and never commits
automatically. Dirty or untracked `.memory/` files are not a reason to skip a
valid save — Memory backs up dirty touched files under `.memory/recovery/`
before overwriting.

## Capability reference

| Capability | MCP | CLI |
| --- | --- | --- |
| Query product context | `query_memory` | `memory query` |
| Save product memory | `save_memory` | `memory save --stdin` |
| Graph status | `status_memory` | `memory status` |
| Inspect one node | `inspect_memory` | `memory inspect <id>` |
| Initialize storage | none | `memory init` |
| Session reconciliation | none | `memory sync` |
| Validate storage | none | `memory check` |
| Show memory diff | none | `memory diff` |
| Rebuild generated index | none | `memory rebuild` |
| Project registry | none | `memory projects` |
| Local viewer | none | `memory view` |
| Reset local storage | none | `memory reset` |
| Read public docs | none | `memory docs` |

## PATH fallbacks

When `memory` is not on `PATH`, run through the project package manager or
local binary:

```bash
pnpm exec memory query "<question>"
npm exec memory query "<question>"
./node_modules/.bin/memory query "<question>"
npx --package @aictx/memory -- memory query "<question>"
pnpm exec memory-mcp
```

For MCP setup details, see the [MCP guide](/mcp/). For exact schema and save
input shapes, see [Reference](/reference/).

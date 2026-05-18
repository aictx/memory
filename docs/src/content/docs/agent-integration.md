---
title: Agent integration
description: How persistent project memory fits into an AI coding-agent workflow.
---

Memory gives coding agents a local project-memory loop:

```text
load memory -> work -> save durable memory
```

The v1 agent model is CLI-first and MCP-compatible. Use the CLI by default. Use
MCP only when the agent client has already launched and connected to
`memory-mcp`.

The agent still makes the judgment call. It reads the task, loaded memory, repo
state, tests, and conversation, then decides what future agents should
remember.

## Routine workflow

Before non-trivial coding, architecture, debugging, dependency, or
configuration work:

```bash
memory load "<task summary>"
memory load "<task summary>" --mode debugging
memory load "<task summary>" --file src/context/rank.ts --changed-file src/index/search.ts --history-window 30d
```

MCP equivalents are available only when the client already exposes Memory MCP
tools:

```text
load_memory({ task: "<task summary>", mode: "coding" })
load_memory({
  task: "<task summary>",
  mode: "coding",
  hints: {
    files: ["src/context/rank.ts"],
    changed_files: ["src/index/search.ts"],
    subsystems: ["retrieval"],
    history_window: "30d"
  }
})
```

Load modes are `coding`, `debugging`, `review`, `architecture`, and
`onboarding`. Modes tune deterministic ranking and rendering only.

After meaningful work, save durable knowledge:

```bash
memory remember --stdin
```

MCP equivalent when available:

```text
remember_memory({ task, memories, updates, stale, supersede, relations })
```

`remember` is the normal intent-first write path. It converts semantic agent
input into a structured patch internally. Use `memory save --stdin` or
`save_memory_patch({ patch })` only for advanced patch-shaped writes.

Saved memory is active after Memory validates and writes it. Dirty or untracked
`.memory/` files are not by themselves a reason to skip saving durable memory.
When a save overwrites or deletes a dirty touched file, Memory first backs it up
under `.memory/recovery/`.

Accepted memory can be inspected later:

```bash
memory view
memory diff
```

`memory diff` includes tracked and untracked Memory changes in Git
projects. Memory writes local files and never commits automatically.

When `memory` is not on `PATH`, run through the project package manager or local
binary:

```bash
pnpm exec memory load "<task summary>"
npm exec memory load "<task summary>"
./node_modules/.bin/memory load "<task summary>"
npx --package @aictx/memory -- memory load "<task summary>"
pnpm exec memory-mcp
npm exec memory-mcp
./node_modules/.bin/memory-mcp
npx --package @aictx/memory -- memory-mcp
```

:::tip
Save nothing when the task produced no durable future value. Memory is meant to
reduce repeated context work, not record every step an agent took.
:::

## Capability reference

| Capability | MCP | CLI |
| --- | --- | --- |
| Load task context | `load_memory` | `memory load` |
| Search memory | `search_memory` | `memory search` |
| Inspect object | `inspect_memory` | `memory inspect` |
| Remember durable context | `remember_memory` | `memory remember` |
| Save structured patch | `save_memory_patch` | `memory save` |
| Show memory diff | `diff_memory` | `memory diff` |
| Initialize storage | none | `memory init`, `memory setup` |
| Review patch file | none | `memory patch review` |
| Validate storage | none | `memory check` |
| Rebuild generated index | none | `memory rebuild` |
| Reset local storage | none | `memory reset` |
| Upgrade storage schema | none | `memory upgrade` |
| Show memory history | none | `memory history` |
| Restore memory | none | `memory restore` |
| Rewind memory | none | `memory rewind` |
| List stale memory | none | `memory stale` |
| Show graph neighborhood | none | `memory graph`, `memory view` graph screen |
| Show memory lens | none | `memory lens` |
| Manage branch handoff | none | `memory handoff` |
| Export Obsidian projection | none | `memory export obsidian` |
| Manage project registry | none | `memory projects` |
| View local memory | none | `memory view` |
| Suggest memory decision packet | none | `memory suggest` |
| Audit memory hygiene | none | `memory audit` |
| Wiki source workflow | none | `memory wiki` |
| Read public docs | none | `memory docs` |

For MCP setup details, see the [MCP guide](/mcp/). For compact command and patch
syntax, see [Reference](/reference/).

## Memory lifecycle

Good memory stays narrow, durable, and current:

- Load narrowly before non-trivial work.
- Save only durable knowledge directly as active memory.
- Update existing memory before creating duplicates.
- Mark stale or supersede old memory when current evidence invalidates it.
- Delete memory that should not persist.
- Prefer current code and user requests over loaded memory when they conflict.
- Report whether memory changed; async inspection is available through
  `memory view`, `memory diff`, or Git tools.
- Save nothing when the task produced no durable future value.

After failure or correction, treat the event as a memory-quality signal:

- Did the agent need missing project context?
- Did loaded memory conflict with current evidence?
- Did the user correct a stale assumption?
- Should existing memory be updated, marked stale, superseded, or deleted?
- Should an open `question`, `gotcha`, `source`, or `synthesis` be saved?

## Memory shape

Right-size memory. Atomic memories should normally carry one durable claim.
Use `synthesis` memories for compact area-level understanding that future agents
should load quickly. Use `source` memories to preserve where context came from,
especially repo docs, AGENTS/CLAUDE/rules, package manifests, issues, external
references recorded by the agent, and user-stated context.

Use relations only when the link matters. Common predicates include
`derived_from`, `supports`, `summarizes`, `documents`, `challenges`, `requires`,
`depends_on`, `affects`, and `supersedes`.

Update-before-create behavior keeps memory from drifting into duplicates:

- `update_object` refreshes an existing object.
- `mark_stale` records that old memory is wrong or no longer useful.
- `supersede_object` connects old memory to its replacement.
- `delete_object` removes memory that should not persist.
- `create_relation` records a durable, useful link between objects.

Create a new object only when no existing memory should be updated, marked
stale, or superseded.

## Object taxonomy

Object types are `project`, `architecture`, `decision`, `constraint`,
`question`, `fact`, `gotcha`, `workflow`, `note`, `concept`, `source`, and
`synthesis`.

`history`, `task-note`, and `feature` are not object types. Git, events, and
statuses cover history. Branch or task scope covers temporary task context.
Product capabilities fit `concept` objects or `synthesis` objects with feature
facets.

`gotcha` fits known failure modes and traps. `workflow` fits repeated
project-specific how-tos: procedures, runbooks, command sequences,
release/debugging/migration paths, verification routines, and maintenance
steps. Organization facets such as `domain`, `bounded-context`, `capability`,
`business-rule`, and `unresolved-conflict` are optional plain-language
retrieval hints.

## Examples

Good memory examples:

- Durable fact: a `fact` titled "Webhook retries run in the worker" with one
  sentence naming the current retry location.
- Linked decision: `decision.billing-retries` plus a `requires` relation to
  `constraint.webhook-idempotency` when the decision depends on that constraint.
- Gotcha: `gotcha.viewer-export-overwrites-manifest-files` when a repeated
  failure mode affects future work.
- Workflow/how-to: `workflow.release-smoke-test` for repeated release
  verification.
- Source-backed synthesis: `synthesis.product-intent` summarizes what the
  product is for and has `derived_from` relations to source records.

Bad memory examples:

- Creating a second memory for the same durable claim instead of updating,
  marking stale, or superseding the existing one.
- Saving "I changed three files and ran tests" when Git history records the
  work.
- Saving guesses that are not supported by current evidence.
- Creating a memory patch only to say that nothing important happened.

Secrets, tokens, credentials, private keys, sensitive raw logs, unsupported
speculation, and unrelated user preferences should not be saved as memory.
Memory should never ask future agents to ignore current code, tests, user
requests, or safety rules.

## Bootstrap and suggestion packets

`memory setup` provides guided first-run onboarding. It initializes storage if
needed, writes conservative evidence-backed bootstrap memory by default, runs
checks, prints role coverage, and starts the local viewer unless told not to.

For the agent-led first-run path, use `memory setup`, then run
`memory lens project-map` for a readable overview or
`memory load "onboard to this repository"` to verify retrieval.

Use `memory handoff update --stdin` only for unfinished branch continuity that
should not become project truth yet.

```bash
memory suggest --bootstrap --json
memory suggest --bootstrap --patch > bootstrap-memory.json
memory patch review bootstrap-memory.json
memory save --file bootstrap-memory.json
memory check
```

`memory suggest --from-diff --json` creates a memory suggestion packet from
current code changes. `memory suggest --after-task --json` includes ranked
`recommended_actions` and, when audit signals apply, `repair_candidates` for
updates, stale marks, supersession review, or unresolved-conflict questions.
Treat them as advisory defaults, not authoritative semantic memory. Agents
still fill in durable `title`, `body`, and `reason` fields from current
evidence.

`memory audit --json` reports grouped, actionable memory hygiene issues and
role coverage gaps. Missing roles and possible-stale findings are not `memory
check` failures.

For the full memory-quality loop, see [Demand-driven memory](/demand-driven-memory/).

---
title: Reference
description: Compact CLI, MCP, docs, object taxonomy, and structured patch reference.
---

Use this page when you need exact names, commands, and patch shapes.

## CLI commands

The CLI is the default interface for routine memory work.

| Area | Commands |
| --- | --- |
| Setup | `memory init`, `memory setup` |
| Maintenance | `memory check`, `memory rebuild`, `memory reset`, `memory upgrade` |
| Routine memory | `memory load`, `memory search`, `memory suggest`, `memory audit`, `memory remember`, `memory save` |
| Wiki workflow | `memory wiki ingest`, `memory wiki file`, `memory wiki lint`, `memory wiki log` |
| Inspection | `memory inspect`, `memory stale`, `memory graph`, `memory lens` |
| Branch continuity | `memory handoff show`, `memory handoff update --stdin`, `memory handoff close --stdin` |
| Inspection and recovery | `memory diff`, `memory history`, `memory restore`, `memory rewind` |
| Export | `memory export obsidian` |
| Viewer | `memory projects`, `memory view` |
| Docs | `memory docs` |

Commands that support structured output accept `--json`:

```bash
memory check --json
memory docs --json
```

`memory setup --dry-run` is read-only and does not initialize storage or write
repo files. `memory audit` includes role coverage gaps and advisory stale,
conflict, provenance, and referenced-file findings, but missing roles and
possible-stale findings are not `memory check` failures. `memory handoff show`
returns only an active handoff for the current Git branch; closed handoffs remain
historical memory.

## MCP tools

MCP is available when the agent client already exposes Memory MCP tools. Local
MCP exposes exactly:

- `load_memory`
- `search_memory`
- `inspect_memory`
- `remember_memory`
- `save_memory_patch`
- `diff_memory`

CLI-only workflows in v1 include setup, lenses, handoff, maintenance, recovery,
export, registry, viewer, docs, suggest, audit, wiki, stale inspection, and
graph inspection.

Future host adapters may expose generic `search` and `fetch` names over Memory
search and inspect behavior. The local MCP server exposes the six Memory-specific
tools above.

## Docs command

```bash
memory docs
memory docs getting-started
memory docs capabilities
memory docs specializing-memory
memory docs agent-recipes
memory docs agent-integration --open
memory docs --json
```

`memory docs` lists bundled public docs topics. `memory docs <topic>` prints the
bundled Markdown for that topic. `--open` opens the hosted page at
`https://docs.aictx.dev`.

## Object types

Object types are `project`, `architecture`, `source`, `synthesis`, `decision`,
`constraint`, `question`, `fact`, `gotcha`, `workflow`, `note`, and `concept`.

`history`, `task-note`, and `feature` are not object types.

Use `workflow` for durable project-specific how-tos: procedures, runbooks,
command sequences, release/debugging/migration paths, verification routines,
and maintenance steps. Generic tutorials, one-off task notes, and task diaries
should not become workflow memory.

Facet categories include `project-description`, `architecture`, `stack`,
`convention`, `file-layout`, `product-feature`, `testing`,
`decision-rationale`, `abandoned-attempt`, `workflow`, `gotcha`,
`debugging-fact`, `source`, `product-intent`, `feature-map`, `roadmap`,
`agent-guidance`, `concept`, `open-question`, `domain`, `bounded-context`,
`capability`, `business-rule`, and `unresolved-conflict`.

## Remember input

`remember` is the routine agent write primitive. It accepts intent-first JSON
and generates a structured patch internally.

```json
{
  "task": "Fix Stripe webhook retries",
  "memories": [
    {
      "kind": "decision",
      "title": "Billing retries run in the worker",
      "body": "Stripe webhook retries execute in the queue worker.",
      "tags": ["billing", "stripe"],
      "applies_to": ["services/billing/src/webhooks/handler.ts"]
    }
  ]
}
```

Supported top-level action arrays are `memories`, `updates`, `stale`,
`supersede`, and `relations`.

Workflow/how-to memory uses the same intent-first input:

```json
{
  "task": "Document release smoke test",
  "memories": [
    {
      "kind": "workflow",
      "title": "Release smoke test",
      "body": "Before tagging a release, run package verification and inspect the Memory diff.",
      "category": "workflow",
      "applies_to": ["package.json"]
    }
  ]
}
```

## Structured patch

The structured patch is the canonical advanced write contract.

```json
{
  "source": {
    "kind": "agent",
    "task": "Fix Stripe webhook retries"
  },
  "changes": [
    {
      "op": "create_object",
      "type": "decision",
      "title": "Billing retries moved to queue worker",
      "body": "Stripe webhook retries now happen in the queue worker.",
      "tags": ["billing", "stripe"]
    }
  ]
}
```

Patch operations include `create_object`, `update_object`, `mark_stale`,
`supersede_object`, `delete_object`, `create_relation`, `update_relation`, and
`delete_relation`.

Structured patches are for durable information future agents should know. A
task that produced no durable future value does not need a save.

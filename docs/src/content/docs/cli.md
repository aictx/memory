---
title: CLI guide
description: Setup, routine work, inspection, recovery, export, docs, and viewer commands.
---

The CLI is the default way to use Memory. It handles setup, routine memory work,
inspection, recovery, exports, bundled docs, and the local viewer.

Most days, an agent only needs:

```bash
memory load "task summary"
memory remember --stdin
memory diff
```

The rest of the CLI is there for setup, review, recovery, and maintenance.

## Quick checks

```bash
memory check
memory diff
memory view --open
```

- `check` validates canonical memory and generated index health.
- `diff` shows memory changes, including untracked files in Git projects.
- `view --open` starts the local browser viewer.

## Setup and bootstrap

```bash
memory init
memory setup
memory setup --dry-run
memory setup --no-view
memory setup --open
memory patch review bootstrap-memory.json
```

- `setup` is the normal onboarding command. It initializes storage if needed,
  applies conservative bootstrap memory, and starts the local viewer unless
  told not to.
- `init` creates empty storage for automation, tests, and manual workflows.
- `setup --dry-run` previews setup without writing memory or repo files.
- `setup --force --dry-run` previews reset/setup behavior without deleting or
  rewriting anything.
- `setup --no-view` skips viewer startup; `setup --open` also opens the viewer
  in the default browser.
- `patch review` reviews a structured memory patch without writing it.

:::tip
If memory is empty after `init`, use `memory setup` before hand-writing memory.
The bootstrap flow is designed for that first-run gap.
:::

## Routine memory work

```bash
memory load "change auth routes"
memory search "auth route conventions"
memory inspect decision.auth-route-conventions
memory suggest --after-task "change auth routes" --json
memory audit --json
memory remember --stdin
```

The routine loop is narrow: load context, do the work, and save durable
knowledge as active memory. A task that produced no reusable project knowledge
does not need a save.

Use `remember` for normal intent-first memory creation. Use `save` only when
you need to submit a structured patch directly. In
`suggest --after-task --json`, use `recommended_actions` and
`repair_candidates` as advice; the agent still writes the meaningful title,
body, and reason from current evidence.

## Wiki-style source workflows

```bash
memory wiki ingest --stdin
memory wiki ingest --stdin --dry-run --json
memory wiki file --stdin
memory wiki lint --json
memory wiki log --limit 20
```

`wiki ingest` creates or updates a source record with `origin` and files
agent-supplied syntheses in the same atomic patch. `wiki file` saves a useful
query result or synthesis through the intent-first remember path. `wiki lint`
uses audit semantics with wiki wording, and `wiki log` renders a chronological
view from canonical events.

Commands that support structured output accept `--json`:

```bash
memory check --json
```

## Inspection and debugging

```bash
memory stale
memory graph <id>
memory lens project-map
memory lens current-work
memory handoff show
```

`audit` includes role coverage gaps and advisory stale/conflict findings, but
missing roles and possible-stale findings are not `check` failures. `stale`
lists only confirmed stale and superseded memory. `graph` shows a one-hop
relation neighborhood. `lens` renders readable project views. `handoff`
preserves unfinished current-branch state without making it project truth.

`audit --json` is report-only by default. It can flag possible stale references,
stale source origins, missing referenced files, unresolved active conflicts,
and supersession chains that need review. Those findings do not mutate memory
or prove a claim false; they tell the agent or human what to verify next.

## Maintenance

```bash
memory check
memory rebuild
memory upgrade
memory reset
memory reset --all
```

`rebuild` regenerates indexes from canonical memory. `reset` backs up and clears
local `.memory/` storage. `reset --all` resets every project in the user-level
registry; add `--destroy` only when you intend to delete each registered
`.memory/` without backup.

## Git inspection and recovery

```bash
memory diff
memory history
memory restore <commit>
memory rewind
```

Memory writes local files and never commits automatically. Git remains the source
of truth for history and rollback when the project is inside a Git worktree.

## Export, viewer, and docs

```bash
memory export obsidian
memory projects list
memory view --open
memory docs
memory docs getting-started
memory docs demand-driven-memory
memory docs agent-recipes
memory docs agent-integration --open
```

`view` starts a local memory viewer. `docs` lists bundled public docs topics.
`docs <topic>` prints bundled Markdown for that topic. `--open` opens the
hosted docs site.

## MCP

MCP is available when the agent client has launched and connected to
`memory-mcp`. Use the [MCP guide](/mcp/) for configuration and exact tool
boundaries.

---
title: Troubleshooting
description: Fix common install, PATH, MCP, schema-version, index, and recovery issues.
---

Start with the smallest check that answers the question:

```bash
memory check
memory status
memory diff
```

`check` validates storage, index health, anchors, and the product map
sections. `status` summarizes the graph. `diff` shows memory changes.

## `memory` is not on PATH

Package-manager and local-binary forms work without a global `PATH` entry:

```bash
pnpm exec memory check
npm exec memory check
./node_modules/.bin/memory check
```

For one-off execution:

```bash
npx --package @aictx/memory -- memory check
```

If a project-local install is stale, update it or use a current global/source
binary before trusting schema errors.

## MCP tools are not available

`memory init` creates local storage. It does not add MCP tools to an already
running agent session. MCP tools become available when the client is
configured to launch `memory-mcp` and a new session starts.

If you need to keep working right now, use the CLI:

```bash
memory query "<question>"
memory save --stdin
```

See the [MCP guide](/mcp/) for the exact tool names and CLI-only boundaries.

## Unsupported storage version

Memory refuses to operate on `.memory/` storage written by a different schema
version, and `memory upgrade` is intentionally a stub — there is no migration
pre-1.0. Recover with:

```bash
memory reset
memory init
```

`reset` archives the old storage under `.memory/.backup/` first. Ask your
coding agent to rebuild the graph from the indexing brief and re-save only
what is still true from the backup.

## The graph is empty after init

That is expected. `init` creates storage and prints the indexing brief;
building the graph is the agent's job. Hand the brief to your coding agent
(reprint it with `memory init --brief`), or paste the first-time setup prompt
from the [docs landing page](/).

## Product map missing or out of date

`memory check` warns when `AGENTS.md`/`CLAUDE.md` have no generated product
map section or the section is stale. Run `memory init` to install the marker
sections; any `memory save` or `memory sync` refreshes the map afterwards.
Do not edit the generated section by hand.

## Schema or index errors

Storage validation:

```bash
memory check
```

Generated index rebuild:

```bash
memory rebuild
```

`rebuild` does not change canonical memory.

## Dirty memory warnings

Dirty or untracked `.memory/` files are not by themselves a reason to skip a
valid save. Review the files, then use the supported save path. Memory backs
up dirty touched files under `.memory/recovery/` before overwrite or delete
and continues where possible.

## Git diff misses new memory files

The Memory diff includes tracked and untracked memory files:

```bash
memory diff
```

Plain `git diff -- .memory/` can omit untracked memory files before staging.

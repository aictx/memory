---
title: Local viewer
description: Local browser viewer for project memory inspection and explicit project maintenance.
---

`memory view` starts a local browser viewer for human inspection.

```bash
memory view
memory view --open
memory view --port 4888
memory view [--port <number>] [--open] [--detach] [--json]
```

Use it when you want to browse memory objects, source-backed syntheses,
relations, audit advisories, project registry entries, and generated Obsidian
export state without editing canonical memory files.

The command binds only to `127.0.0.1`, chooses an available random port by
default, and prints a local URL with a per-run API token. It can start outside
an initialized project and open to a Projects dashboard populated from the
user-level registry, plus the current project when the launch directory is
initialized.

## Projects

The registry lives at `$MEMORY_HOME/projects.json`, defaulting to
`~/.memory/projects.json`. It stores project metadata and roots. Canonical memory
stays isolated in each project's own `.memory/` directory.

Project registry commands:

```bash
memory projects list
memory projects add
memory projects add /path/to/project
memory projects remove <registry-id|project-id|path>
memory projects prune
```

:::tip
The project registry is for discovery in the viewer. It is not shared memory
and does not make project IDs globally unique.
:::

## Write actions

The viewer is mostly read-only. It has two explicit write actions.

The Maintenance screen groups deterministic audit findings by memory id. It
highlights possible stale references, stale source origins, missing file
evidence, unresolved active conflicts, and supersession chains that need human
or agent review. These are advisory review prompts; the viewer does not mark
memory stale or repair it automatically.

Obsidian export calls the same generated projection service as:

```bash
memory export obsidian
```

Delete project permanently removes that project's derived `.memory/` directory
and removes its entry from `$MEMORY_HOME/projects.json`. It does not delete
source files.

`memory view` is a CLI workflow and has no MCP equivalent. Use MCP for routine
agent memory tools; use the viewer when a human wants to inspect local memory.

---
title: Local viewer
description: Local browser viewer for the product graph — projects dashboard, memory list, node detail, and the relation graph.
---

`memory view` starts a local browser viewer for human inspection.

```bash
memory view
memory view --open
memory view --port 4888
memory view [--port <number>] [--open] [--detach] [--json]
```

The command binds only to `127.0.0.1`, chooses an available random port by
default, and prints a local URL with a per-run API token. `--detach` starts it
in a background process and prints the URL. It can start outside an
initialized project and open to the projects dashboard populated from the
user-level registry.

## Screens

- **Projects** — dashboard of registered projects from the registry, plus the
  current project when the launch directory is initialized.
- **Memories** — the node list for one project: features, decisions, gotchas,
  and questions with their statuses. Feature rows carry a stage pill
  (idea, building, shipped, paused, dead).
- **Detail** — one node in full: body, stage, anchors, tags, evidence,
  relations, and provenance.
- **Graph** — the interactive relation graph, color-coded by node kind, for
  exploring how features, decisions, gotchas, and questions connect.

The viewer is read-only for graph content; writes go through
`memory save --stdin` (or the `save_memory` MCP tool). Its one destructive
action, deleting a project, removes that project's `.memory/` directory and
registry entry — never source files.

## Projects registry

The registry lives at `$MEMORY_HOME/projects.json`, defaulting to
`~/.memory/projects.json`. It stores project metadata and roots for the
projects dashboard and `memory status --all`. Canonical memory stays isolated
in each project's own `.memory/` directory.

Project registry commands:

```bash
memory projects list
memory projects add
memory projects add /path/to/project
memory projects remove <registry-id|project-id|path>
memory projects prune
```

:::tip
The project registry is for discovery in the viewer and the `status --all`
dashboard. It is not shared memory and does not make project ids globally
unique.
:::

`memory view` is a CLI workflow and has no MCP equivalent. Use MCP for the
routine query/save/status/inspect tools; use the viewer when a human wants to
look at the graph.

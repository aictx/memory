<!-- Generated from integrations/templates/agent-guidance.md. Do not edit directly. -->

# Memory for Codex

This plugin packages the `memory` skill for Codex.

It keeps Memory usage CLI-first: query project memory on demand with `memory query`, save product-meaningful changes with `memory save --stdin`, and use MCP equivalents only when the current Codex session already exposes Memory MCP tools.

## Contents

- `.codex-plugin/plugin.json`
- `skills/memory/SKILL.md`

## Distribution

This directory follows the Codex plugin format. It intentionally does not include MCP server configuration; Memory MCP setup remains an optional client-level configuration.

Codex adds plugins through marketplace sources, not by adding this plugin directory directly. This repo exposes the plugin through its root marketplace catalog:

```bash
codex plugin marketplace add aictx/memory
```

Then open Codex Plugins, choose the Memory marketplace, and install Memory.

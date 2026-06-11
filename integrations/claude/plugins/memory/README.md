<!-- Generated from integrations/templates/agent-guidance.md. Do not edit directly. -->

# Memory for Claude Code

This plugin packages the `memory` skill for Claude Code.

It keeps Memory usage CLI-first: query project memory on demand with `memory query`, save product-meaningful changes with `memory save --stdin`, and use MCP equivalents only when the current Claude Code session already exposes Memory MCP tools.

## Contents

- `.claude-plugin/plugin.json`
- `skills/memory/SKILL.md`

## Distribution

This directory follows the Claude Code plugin format. Submit it through Anthropic's plugin submission flow when targeting the official Claude plugin directory.

Claude Code adds plugins through marketplace sources, not by adding this plugin directory directly. This repo exposes the plugin through its root marketplace catalog:

```text
/plugin marketplace add aictx/memory
/plugin install memory@aictx
```

For official Claude listing, validate this directory with `claude plugin validate integrations/claude/plugins/memory` and use Anthropic's plugin submission flow.

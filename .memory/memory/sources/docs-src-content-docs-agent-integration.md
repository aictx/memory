# Source: docs/src/content/docs/agent-integration.md

This source records that durable Memory can be derived from `docs/src/content/docs/agent-integration.md`.

Captured signals:
- Agent integration remains CLI-first, with MCP equivalents only for routine tools when available.
- `memory suggest --after-task --json` exposes ranked recommended actions and optional repair candidates; agents must still write durable title/body/reason fields from current evidence.
- `memory audit --json` reports grouped hygiene issues and role coverage gaps; possible-stale findings are advisory and are not `memory check` failures.
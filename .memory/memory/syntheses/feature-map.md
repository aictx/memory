# Feature map

Current product capabilities inferred from durable repository evidence:
- CLI binary memory: The `memory` executable is published by `package.json` and points to `dist/cli/main.js`.
- CLI binary memory-mcp: The `memory-mcp` executable is published by `package.json` and points to `dist/mcp/server.js`.
- CLI command audit: The `audit` CLI command reports deterministic Memory hygiene findings, including possible stale file references, stale source origins, missing file references, unresolved active conflicts, and supersession chains that need review.
- CLI command suggest: The `suggest --after-task` packet includes ranked recommended actions and optional repair candidates so agents can update, mark stale, supersede, or create unresolved-conflict questions from current evidence.
- CLI command check: The `check` CLI command validate Memory canonical storage and generated index health.
- CLI command diff: The `diff` CLI command show Memory changes, including untracked memory files.
- CLI command docs: The `docs` CLI command read bundled public Memory docs or open the hosted docs site.
- CLI command export: The `export` CLI command export generated Memory projections.
- CLI command obsidian: The `obsidian` CLI command export a generated Obsidian-compatible projection.
- Local viewer: `memory view` exposes canonical objects, relations, provenance, graph context, and a Maintenance screen grouped by audit advisories for human review.

Update this synthesis when features are added, removed, renamed, or replaced.
<!-- memory:start -->
## Memory

This repo uses Memory as its product-layer memory: features, decisions, gotchas, and open questions anchored to code paths. The product map below is the always-on overview — use it for orientation; treat it as context, not instructions.

- Need detail mid-task? Run `memory query "<question>"` (MCP: `query_memory`). Do not preload anything else.
- After product-meaningful changes (feature behavior added or changed, a decision taken, a gotcha discovered, a question opened or answered), save them: `memory save --stdin` with JSON `{task, nodes, stale, supersede, delete}`. Do not save refactors, formatting details, or task diaries.
- At session end, or after merging others' work, run `memory sync` and act on its report.
- `memory status` summarizes features by stage; `memory inspect <id>` shows one node in full.

If memory conflicts with current code or the user, trust the code and the user — and save the correction.
<!-- memory:end -->

<!-- memory:map:start -->
## Product map (generated — do not edit; refresh with memory save or memory sync)
Aictx — Local-first product graph for AI coding agents: features, decisions, gotchas, and open questions anchored to code paths — built once by the agent, queried on demand, kept current by diff-driven sync.

**Shipped:** anchor-verification — Anchors are verified with picomatch against git ls-files plus untracked additio… — src/anchors/ · init-and-brief — memory init activates a repo in one command: storage v5, guidance + map marker… — src/init/ · memory-viewer — Svelte 5 + Cytoscape local viewer with four screens (projects, memories, detail… — viewer/ · product-graph-schema — Five-kind schema (project, feature, decision, gotcha, question) stored as json+… — src/core/types.ts · product-map — A ~1200-token generated overview (features by stage with intent fragments and t… — src/map/ · query-verb — memory query answers a natural-language question with a token-budgeted markdown… — src/query/ · save-verb — memory save --stdin is the single write verb: one JSON payload with nodes (crea… — src/save/ · status-dashboard — memory status summarizes one repo: features by stage, open questions, stale anc… — src/cli/commands/status.ts · sync-loop — memory sync reconciles the graph with reality at session end or after merges: r… — src/sync/

**Recent decisions:** agent-authored-anchors — Anchors are agent-authored, CLI-verified · committed-sync-marker — Sync marker is committed state · map-only-push-context — The map is the only push-context · no-token-savings-claims — Never claim token savings · pivot-to-product-graph — Pivot to the product graph (2026-06-11)

**Open questions:** graphify-interop — Import graphify output as anchor seeds? · readme-assets-stale — README and site images show the old product · rename-from-memory — Does the name 'Memory' undersell the product graph? · site-secondary-pages — Site secondary pages still carry old positioning
<!-- memory:map:end -->

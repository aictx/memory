---
title: Mental model
description: The product graph — kinds, stages, anchors, the map as push context, query as pull, sync as reconciliation, and save discipline.
---

Memory stores one thing: the product layer of a codebase. This page explains
the model behind the commands.

## The product graph

The graph has five kinds of node:

| Kind | What it holds |
| --- | --- |
| `project` | One per repo: what this product is. Created by `init`. |
| `feature` | What the product does for users, with a lifecycle `stage` and code `anchors`. |
| `decision` | A choice and the reason it was made. |
| `gotcha` | A known trap or failure mode. |
| `question` | An open product or technical question that affects future work. |

Nodes connect through four relation predicates: `affects`, `depends_on`,
`supersedes`, and `related_to`. Relations are useful when they change what an
agent should conclude — a decision that `affects` a feature, a feature that
`depends_on` another. Do not wire everything to everything.

The test for whether something belongs in the graph: is this knowledge an
agent cannot re-derive from the code? Code structure, function signatures, and
call graphs do not belong here — agents recover those cheaply by reading the
repo. Intent, stage, and rationale do belong here, because they live nowhere
else.

## Stage

Every feature carries a stage: `idea`, `building`, `shipped`, `paused`, or
`dead`. Stage is the single most valuable field in the graph and the one the
repo is worst at expressing — code for a paused feature looks exactly like
code for a shipped one. Keep stages honest: an abandoned experiment marked
`dead` saves a future session from polishing it; a feature marked `building`
tells the agent the rough edges are known.

## Anchors

Anchors are repo-relative path globs on a node — `services/billing/`,
`src/**/*.ts` — linking the claim to the code it describes. They are what make
staleness mechanical instead of a feeling:

- `memory status` reports anchors that no longer match any file.
- `memory sync` diffs the tree since the last sync and reports nodes whose
  anchored files changed or disappeared.
- `memory check` warns when anchors or the generated map are out of date.

Anchor a feature to the directory that implements it, not to individual files
that get renamed weekly. A node with no anchors can never be verified
mechanically; `sync` lists unanchored nodes for that reason.

## The map is push, the query is pull

Memory deliberately splits context into one small push surface and one
on-demand pull surface.

**Push: the product map.** A generated, roughly one-screen section in
`AGENTS.md`/`CLAUDE.md` — features grouped by stage with intent fragments and
first anchors, recent decisions, open questions, and stale-anchor warnings. It
is capped at about 1200 tokens, refreshed automatically on every `save` and
`sync`, and marked do-not-edit. This is the only Memory context an agent
carries into every session: enough to orient, not enough to drown.

**Pull: `memory query`.** When the agent needs detail mid-task, it asks a
question. The query seeds on full-text matches, expands one hop along active
relations, attaches connected open questions, and renders the result as
Markdown inside a token budget (default 2000). Nothing else is preloaded.
There is no per-task loading step.

This split is deliberate. Loading a context pack before every task sounds
efficient and is not — our own May 2026 benchmarks showed per-task context
loading does not save tokens. What the graph buys is different: agent answers
grounded in product reality, and a cold-resume path back into any project.

## Sync is reconciliation, not authorship

`memory sync` never writes graph nodes. It is the mechanical half of keeping
the graph honest:

1. Read the committed marker in `.memory/sync-state.json`.
2. Diff the tree since that commit, plus working-tree changes.
3. Verify every anchor against the actual files.
4. Report: fresh nodes, nodes whose anchored code changed, nodes with orphaned
   anchors, unanchored nodes, and directories with real code but no feature
   coverage.
5. Print an agent prompt with a pre-filled `memory save --stdin` skeleton for
   the nodes that need re-verification.
6. Advance the marker (unless `--dry-run`).

The judgment — did the behavior actually change, is the feature still
`building`, is the anchor just renamed — stays with the agent and you, in one
save call.

## Save discipline

Save product-meaningful changes: feature behavior added or changed, a decision
taken with its reason, a gotcha discovered, a question opened or answered.
Update existing nodes (reuse their `id`) instead of creating near-duplicates;
use `stale`, `supersede`, and `delete` to retire memory that current evidence
invalidates.

Do not save refactors, formatting, task diaries, generic tutorials, secrets,
or short-lived implementation notes. Passing tests or renaming a variable
should not create memory. A session that changed no product reality needs no
save — that is the common case, and it is fine.

## Trust order

Memory is context, not instructions. When the graph conflicts with the current
user request, the code, or test results, the current evidence wins — and the
correction is worth saving so the next agent does not repeat the mistake.

## Where things live

Canonical truth is plain files under `.memory/`: a JSON sidecar plus a
Markdown body per node, relations as JSON, an append-only event log. The
SQLite full-text index under `.memory/index/` is generated and disposable —
`memory rebuild` recreates it from canonical files. The exact layout and field
shapes are in the [Reference](/reference/).

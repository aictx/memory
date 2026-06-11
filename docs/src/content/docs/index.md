---
title: Memory documentation
description: Public documentation for Memory by Aictx — the product graph of a codebase, kept local and queryable for AI coding agents.
---

Your agent knows your code. It doesn't know your product.

Memory keeps the product graph of a codebase: features with their lifecycle
stage, decisions with their reasons, gotchas, and open questions — anchored to
the code paths they describe. Agents query the graph on demand mid-task and
keep it current as the product changes.

It exists for a specific pain. Developers who run several projects with AI
coding agents come back to a repo after weeks and neither they nor the agent
remembers what is shipped, what is half-done, or why anything is built the way
it is. Agents re-derive code structure cheaply; they cannot re-derive intent,
stage, or rationale, because that knowledge is not in the repo. Memory stores
it next to the code.

Everything is local: plain files under `.memory/` (JSON sidecars plus Markdown
bodies), a SQLite full-text index, no embeddings, no cloud account, no model
API. Memory is distributed as the npm package `@aictx/memory` and the Homebrew
formula `aictx/tap/memory`, and runs through the `memory` CLI and optional
`memory-mcp` server.

## The loop

```text
init once -> query on demand -> save product changes -> sync at session end
```

1. `memory init` — once per repo. Creates storage, installs a short guidance
   block and a generated **product map** into `AGENTS.md`/`CLAUDE.md`, starts
   the local viewer, and prints an **indexing brief** the coding agent follows
   to build the initial graph.
2. `memory query "<question>"` — mid-task, on demand. Returns a token-budgeted
   Markdown subgraph of matching memory. There is no per-task context loading.
3. `memory save --stdin` — after product-meaningful changes. Intent JSON in,
   validated graph writes out. The product map refreshes automatically.
4. `memory sync` — at session end. Verifies code anchors against the actual
   tree and reports what went stale, with a pre-filled save skeleton.
5. `memory status` — features by stage, open questions, stale anchors.
   `memory status --all` is the dashboard across every registered project.

## First-time setup prompt

Copy this prompt into [Claude Code](https://code.claude.com/docs/en/setup),
[Codex](https://developers.openai.com/codex/cli),
[Cursor](https://docs.cursor.com/context/rules-for-ai), or another coding
agent from the project root:

```text
Set up Memory for this repository.

Install Memory with one of:
brew install aictx/tap/memory
npm install -g @aictx/memory

Then run from the project root:
memory init

Follow the printed indexing brief: explore the repo, draft the product graph
(features with stage and anchors, decisions with their reasons, gotchas, open
questions), interview me for what the repo cannot tell you, and save it all in
one `memory save --stdin` call.

When this is done, report:
- what the product map in AGENTS.md/CLAUDE.md now shows
- what `memory status` reports
- how I can inspect the graph with `memory view`
```

## Start here

- [Getting started](/getting-started/) installs Memory, runs `init`, and walks
  through building the first product graph and the query/save/sync loop.
- [Mental model](/mental-model/) explains the product graph: kinds, stages,
  anchors, the map as push context, query as pull, and save discipline.
- [Capabilities](/capabilities/) maps the commands to the jobs they do.
- [CLI guide](/cli/) documents every verb and flag.
- [MCP guide](/mcp/) covers the four MCP tools and when to use them.
- [Agent integration](/agent-integration/) gives agents the concrete workflow
  and safety rules.
- [Reference](/reference/) has the exact schema, storage layout, and save
  input shape.

## For agents

This site is also published with agent-readable documentation files:

- `/llms.txt`
- `/llms-full.txt`
- `/llms-small.txt`

These files provide compact public documentation for coding agents without
crawling the full website navigation.

## Project health

Memory is pre-1.0; breaking changes are expected across versions, and storage
recovery is `memory reset` followed by `memory init`. The public repository
includes contributor guidelines, a code of conduct, security reporting
instructions, support paths, a public roadmap, a release policy, CI, CodeQL,
OpenSSF Scorecard, and Dependabot configuration. See the repository root for
the maintained community and release files.

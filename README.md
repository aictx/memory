# Memory

![Memory is a local wiki for AI agents. Agents load repo context, keep it current, and you review changes.](site/public/assets/readme-value-header.png)

<p align="center">
  <a href="https://memory.aictx.dev"><img alt="Website" src="https://img.shields.io/badge/website-memory.aictx.dev-111214?style=for-the-badge"></a>
  <a href="https://docs.aictx.dev"><img alt="Docs" src="https://img.shields.io/badge/docs-read-111214?style=for-the-badge"></a>
  <a href="https://demo.aictx.dev/?token=demo"><img alt="Live demo" src="https://img.shields.io/badge/demo-viewer-111214?style=for-the-badge"></a>
</p>

<p align="center">
  <a href="https://github.com/aictx/memory/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/aictx/memory/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/aictx/memory/actions/workflows/codeql.yml"><img alt="CodeQL" src="https://github.com/aictx/memory/actions/workflows/codeql.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@aictx/memory"><img alt="npm" src="https://img.shields.io/npm/v/@aictx/memory"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
</p>

Memory is a local wiki for AI coding agents and assistants: repo context they
can load before work, keep current after meaningful changes, and leave
reviewable in your project. It is inspired by
[Andrej Karpathy's LLM Wiki pattern](https://gist.githubusercontent.com/karpathy/442a6bf555914893e9891c11519de94f/raw/ac46de1ad27f92b28ac95459c782c07f6b8c964a/llm-wiki.md):
durable, human-editable project knowledge that models can read before work.

Stop re-explaining the same product intent, architecture decisions, repo
conventions, setup steps, and known traps every time a new AI coding session
starts. Activate Memory once in a repo: it gives agents a local wiki of durable
project knowledge, wires short agent guidance into the project, and loads only
the pages that matter for the current task.

Use Memory when:

- You work across many repos, branches, or agent sessions and keep losing the
  durable project state between them.
- You delegate real coding work to AI agents and want decisions, workflows,
  setup paths, and known traps to survive the chat.
- You maintain large or long-lived codebases where architecture and conventions
  keep getting rediscovered.
- You want a local wiki agents can maintain from source-backed project
  knowledge.
- You want to understand and verify agent-built work without reading every
  transcript or every file.
- You want `AGENTS.md`, `CLAUDE.md`, and rules files to stay short instead of
  becoming stale project encyclopedias.

This repository publishes the npm package `@aictx/memory` and the Homebrew
formula `aictx/tap/memory`.

Memory works with Codex, Claude Code, Cursor, Cline, OpenCode, and
MCP-capable clients. Use the `memory` CLI by default, then add the local
`memory-mcp` server when you want routine Memory tools inside an MCP client.

## Why Memory?

Memory is for the repo wiki agents actually need: durable project context that
should survive between agents, sessions, branches, and reviews without making
you re-teach the repo each time.

The value stack is practical:

- Better agent work: agents start with the product, architecture, workflow, and
  gotcha context that matters for the current task.
- Less wasted context: `memory load` builds a focused pack instead of asking you
  to paste the same briefing or carry every project fact in a giant prompt.
- Reviewable memory: saved knowledge is local project state that humans can
  inspect, diff, repair, and keep honest.

- Why not `AGENTS.md` only? Agent instruction files are good operating manuals.
  They become too broad and static when they also try to be the whole project
  wiki.
- Why not a vector DB or RAG stack? Those are useful for large retrieval
  systems. Memory keeps v1 project memory local, inspectable, Git-aware, and
  usable without embeddings, hosted infrastructure, or a model API.
- Why not long context? Long context helps inside one session. It does not make
  memory reviewable, current, reusable across future sessions, or easy to clean
  up when facts go stale.
- Why local files? Plain files make the wiki reviewable and portable. Memory
  builds on that foundation with validation, typed memory, a local index,
  task-focused loading, relation-aware inspection, and a save/no-save
  discipline.

### Inspect the Memory

Memory is not just hidden context for agents. The visual memory viewer is the
wiki review surface: a local place where humans can inspect the same schema,
objects, facets, relations, provenance, audit advisories, and graph context
agents load.

<p align="center">
  <a href="https://demo.aictx.dev/?token=demo">
    <img
      alt="Memory viewer showing the memory schema graph with relation overview and canonical storage navigation."
      src="site/public/assets/readme-visual-memory.png"
      width="940"
    >
  </a>
  <br>
  <sub>Schema, stored objects, relation provenance, maintenance advisories, and graph context in one inspectable local viewer.</sub>
</p>

## What Gets Stored

| Memory | Use it for |
| --- | --- |
| `decision` / `constraint` | Choices and boundaries future agents should respect. |
| `workflow` / `gotcha` | Repeatable procedures and known traps. |
| `source` | Where important project facts came from. |
| `synthesis` | Compact summaries of product intent, architecture, feature maps, conventions, and agent guidance. |
| `question` / `fact` / `concept` | Open scope, reusable facts, and domain ideas. |

The full object taxonomy, facets, and write contracts live in the
[reference docs](https://docs.aictx.dev/reference/).

Memory does not require a cloud account, embeddings, hosted sync, an external
model API, or network access for core memory commands. Saved memory is active
immediately after Memory validates and writes it.

## How It Works

![Memory workflow: load wiki context, do work, and save durable updates.](site/public/assets/readme-how-it-works.png)

```text
set up once -> agents load wiki context -> save durable updates
```

The loop is deliberately small after setup. Agents load memory before
non-trivial work, use the current repo and tests as evidence, then save only
knowledge that should remain in the repo wiki for future sessions, branches,
and reviews.

## Get Started Quickly

Memory requires Node.js `>=22`. The Homebrew formula installs Node through
Homebrew; npm installs require a compatible Node already on `PATH`. Core
commands run locally; no cloud account, model API, embeddings, or hosted sync
are required.

```bash
# macOS/Linux with Homebrew
brew install aictx/tap/memory

# or npm
npm install -g @aictx/memory

cd path/to/your/repo
memory setup
memory load "onboard to this repository"
memory view
```

`memory setup` activates Memory in the current repo. It creates local `.memory/`
memory, updates the marked Memory sections in `AGENTS.md` and `CLAUDE.md`, writes
conservative first-run memory, runs checks, and starts the local viewer. Use
`memory setup --no-view` when you do not want the viewer to start, or
`memory setup --dry-run` to preview before writing.

Memory writes local files and never commits automatically.

## Project Status and Upgrade Recovery

Memory is not ready for production use yet. Breaking changes should be expected
across package versions while the schema and local storage format are still
evolving.

If you update to the latest package version and later see errors from existing
local Memory storage, reset and re-run setup from the project root:

```bash
memory reset
memory setup
```

`memory reset` creates a backup archive under `.memory/.backup/` before clearing
local Memory storage. If useful context is missing after setup, ask your coding
agent to inspect the newest backup and add back only relevant durable project
knowledge. For example:

```text
Memory was reset after a package upgrade. Inspect the newest archive in
.memory/.backup/, compare it with the current .memory/ contents, and add back
only relevant durable project knowledge that was lost. Do not restore stale
schema files blindly; use current Memory commands and validate with memory check.
```

## Ask an Agent to Activate It

Paste this into Codex, Claude Code, OpenCode, Cursor, Cline, or another
CLI-capable coding agent from the project root:

```text
Set up Memory for this repository.

Install Memory with one of:
brew install aictx/tap/memory
npm install -g @aictx/memory

Then run:
memory setup
memory check
memory load "onboard to this repository"

When this is done, report:
- whether setup wrote memory
- whether check passed
- how I can inspect the result with `memory view` or `memory diff`
```

After setup, the normal agent loop is small:

```bash
memory load "<task summary>"
# do the work
memory remember --stdin
memory diff
```

Save only durable project knowledge. Memory is meant to keep the repo wiki
current, not archive every task transcript.

## What You Get

Four surfaces ship today. Each one works locally and fits normal Git review.

| Surface | What it gives agents and humans | Try |
| --- | --- | --- |
| One-time setup | Creates the local wiki memory and short repo guidance so future agents know when to load and save context. | `memory setup` |
| Task-focused loading | Pulls relevant wiki context before coding, debugging, review, architecture, or onboarding work. | `memory load "change auth routes"` |
| Visual memory viewer | Opens a local browser for the memory schema, canonical objects, facets, maintenance advisories, relation overview, provenance, and graph context. | `memory view` |
| Save discipline | Saves only durable facts, decisions, workflows, gotchas, source records, and syntheses. | `memory remember --stdin` |

## Works With Your Agent

| Agent or client | Fastest path |
| --- | --- |
| Codex | `memory setup` writes `AGENTS.md`; use the CLI loop by default. |
| Claude Code | `memory setup` writes `CLAUDE.md`; use the CLI loop by default. |
| OpenCode | Uses the root `AGENTS.md` guidance created by setup. |
| Cursor | Copy `integrations/cursor/memory.mdc` into `.cursor/rules/memory.mdc`, then run setup. |
| Cline | Copy `integrations/cline/memory.md` into `.clinerules/memory.md`, then run setup. |
| MCP-capable clients | Start with the CLI; configure `memory-mcp` later when the client exposes MCP tools. |

## Distribution Artifacts

The `integrations/` directory includes generated skill and plugin artifacts for
external agent packaging. They package the same CLI-first guidance as the setup
aids and do not add MCP configuration.

Codex users can add this repo's marketplace with one command:

```bash
codex plugin marketplace add aictx/memory
```

Then open Codex Plugins and install **Memory**.

Claude Code users can add the marketplace and install the plugin from inside
Claude Code:

```text
/plugin marketplace add aictx/memory
/plugin install memory@aictx
```

For official listing paths and release prep, see
[Publishing agent plugins](https://docs.aictx.dev/plugin-publishing/).

## Documentation

- [Setup](https://docs.aictx.dev/getting-started/)
- [Memory recipes](https://docs.aictx.dev/memory-recipes/)
- [Agent recipes](https://docs.aictx.dev/agent-recipes/)
- [CLI reference](https://docs.aictx.dev/cli/)
- [MCP](https://docs.aictx.dev/mcp/)
- [Reference](https://docs.aictx.dev/reference/)
- [Wiki workflow](https://docs.aictx.dev/wiki-workflow/)

## Contribute

Memory is MIT-licensed and built in the open. Issues, docs fixes, examples,
agent recipes, and pull requests are welcome.

[Contribute on GitHub](https://github.com/aictx/memory/blob/main/CONTRIBUTING.md)

## Project identity

Memory by Aictx gives AI coding agents a local wiki for repo context. It stores
durable project memory as reviewable local files agents can load before work
and update after meaningful changes. It is distributed through the open source
npm package `@aictx/memory` and the Homebrew formula `aictx/tap/memory`, then
runs through the `memory` CLI and optional `memory-mcp` server.

---
title: AI coding agent memory recipes
description: Memory setup recipes for Codex, Claude Code, Cursor, Cline, OpenCode, and MCP-capable coding assistants.
---

Use these recipes when you want an AI coding agent to set up and use Memory from
inside an existing repository.

The working loop is:

```text
load relevant memory -> do the work -> save what future agents should remember
```

The CLI is the default path. MCP is optional and only helps after the agent
client has launched with `memory-mcp` configured.

## Quick comparison

| Agent | Instruction file | Setup path | Routine path |
| --- | --- | --- | --- |
| Codex | `AGENTS.md` | Paste the setup prompt into Codex from the repo root. | CLI by default; MCP only when configured. |
| Claude Code | `CLAUDE.md` | Paste the setup prompt into Claude Code from the repo root. | CLI by default; MCP only when configured. |
| Cursor | `.cursor/rules/memory.mdc` | Add the generated rule, then paste the setup prompt. | CLI by default in agent commands. |
| Cline | `.clinerules/memory.md` | Add the generated rule, then paste the setup prompt. | CLI by default in agent commands. |
| OpenCode | `AGENTS.md` | Use the root `AGENTS.md` created by setup. | CLI by default; MCP only when configured. |
| Generic MCP-capable agent | Agent-specific instructions plus MCP config | Paste the setup prompt; configure MCP later if needed. | CLI first, MCP for routine equivalents when already exposed. |

## Distribution artifacts

The files below package the same generated Memory guidance for external
marketplace or catalog submission. They are not used by `memory setup`, which
writes the marked sections in `AGENTS.md` and `CLAUDE.md`.

| Target | Path | Submission note |
| --- | --- | --- |
| Codex standalone skill | `integrations/codex/skills/memory/` | Copy into `openai/skills` when preparing a Codex skills catalog PR. |
| Codex plugin | `integrations/codex/plugins/memory/` | Follows the `.codex-plugin/plugin.json` format and points at `./skills/`. |
| Claude Code plugin | `integrations/claude/plugins/memory/` | Follows the `.claude-plugin/plugin.json` format; use Anthropic's plugin submission flow for official listing. |

These artifacts stay CLI-first. They do not bundle `.mcp.json`; configure MCP
in the client when you want it.

For the self-hosted marketplace in this repo, Codex users add the marketplace,
then install **Memory** from Codex Plugins:

```bash
codex plugin marketplace add aictx/memory
```

Claude Code users can add the marketplace and install the plugin directly:

```text
/plugin marketplace add aictx/memory
/plugin install memory@aictx
```

See [Publishing plugins](/plugin-publishing/) for marketplace and official
submission details.

## Common setup prompt

Paste this prompt into the agent from the project root:

```text
Set up fresh Memory for this repository.

Install Memory with one of:
brew install aictx/tap/memory
npm install -g @aictx/memory

Then run:
memory setup
memory check
memory load "onboard to this repository"

When this is done, report:
- whether setup applied memory
- whether check passed
- the viewer URL or the command `memory view`
- the review command `memory diff`
```

## Repair prompt

Use this after a task exposed stale, conflicting, or weakly evidenced memory:

```text
Review Memory after this task.

Run:
memory suggest --after-task "<task summary>" --json
memory audit --json

Use current code, tests, docs, and my correction as higher-priority evidence.
If existing memory is wrong or outdated, update it, mark it stale, supersede it,
or create an open unresolved-conflict question. Do not save a task diary.
Report whether Memory changed and how I can inspect the diff.
```

## Codex

Instruction file: `AGENTS.md`

Codex reads repository guidance from `AGENTS.md`. Run `memory setup` once so the
marked Memory section is present and first-run memory is seeded, or paste the
common setup prompt into Codex from the repository root.

Normal loop:

```bash
memory load "<task summary>"
memory remember --stdin
memory diff
```

MCP note: keep using the CLI unless Codex already exposes Memory MCP tools in
the current session. `memory init` does not start MCP.

Distribution artifacts are available at `integrations/codex/skills/memory/`
for the standalone skill catalog and `integrations/codex/plugins/memory/`
for Codex plugin packaging.

## Claude Code

Instruction file: `CLAUDE.md`

Claude Code can use the `CLAUDE.md` guidance created by `memory setup`. Paste
the common setup prompt into Claude Code from the repository root for first-run
memory seeding.

Normal loop:

```bash
memory load "<task summary>"
memory remember --stdin
memory diff
```

Optional generated guidance is available at `integrations/claude/memory.md` and
`integrations/claude/memory/SKILL.md`.

The Claude Code plugin artifact is available at
`integrations/claude/plugins/memory/` for marketplace review or official
plugin submission.

## Cursor

Instruction file: `.cursor/rules/memory.mdc`

Copy `integrations/cursor/memory.mdc` into `.cursor/rules/memory.mdc`, then paste
the common setup prompt into Cursor from the repository root.

Normal loop:

```bash
memory load "<task summary>"
memory remember --stdin
memory diff
```

Keep Cursor rules short. The rule should tell the agent when to load memory,
when to save durable memory, and when saving nothing is correct; `.memory/`
stores the project knowledge.

## Cline

Instruction file: `.clinerules/memory.md`

Copy `integrations/cline/memory.md` into `.clinerules/memory.md`, then paste the
common setup prompt into Cline from the repository root.

Normal loop:

```bash
memory load "<task summary>"
memory remember --stdin
memory diff
```

Cline should use supported Memory CLI or MCP entrypoints. It should not edit
`.memory/` files directly when a supported command exists.

## OpenCode

Instruction file: `AGENTS.md`

OpenCode can use the root `AGENTS.md` guidance created by setup. No separate
OpenCode-specific generated file is needed in this release.

Normal loop:

```bash
memory load "<task summary>"
memory remember --stdin
memory diff
```

## Generic MCP-capable agents

Instruction file: whatever the agent client treats as persistent project
instructions.

Paste the common setup prompt from the repository root. Configure MCP later only
if the client supports launching `memory-mcp`.

Routine CLI loop:

```bash
memory load "<task summary>"
memory remember --stdin
memory diff
```

Routine MCP equivalents when already configured:

```text
load_memory({ task: "<task summary>", mode: "coding" })
remember_memory({ task, memories, updates, stale, supersede, relations })
diff_memory({})
```

For the exact MCP tool list and CLI-only boundaries, see the [MCP guide](/mcp/).

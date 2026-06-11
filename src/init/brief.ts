/**
 * The indexing brief: the instructions printed after `memory init` (and on
 * demand via `memory init --brief`) that tell an agent how to build the
 * initial product graph. Init itself stays mechanical — exploring the repo,
 * drafting nodes, and interviewing the user is the agent's job.
 */
export const INDEXING_BRIEF = [
  "Memory indexing brief",
  "---------------------",
  "Goal: build this repo's product graph so agents can query product context on demand.",
  "",
  "1. Explore the repo: README, package manifests, route/command/job entrypoints, docs, recent git log.",
  "2. Draft the graph: 3-10 feature nodes (what the product does for its users), each with a stage",
  "   (idea|building|shipped|paused|dead) and anchors (repo-relative path globs); key decisions with",
  "   their reasons; known gotchas; open questions.",
  "3. Interview the user for what the repo cannot tell you: product intent, the real stage of each",
  "   feature, decisions and why, what is abandoned versus merely paused.",
  "4. Save everything in ONE call:",
  "   memory save --stdin <<'JSON'",
  '   {"task": "initial product graph",',
  '    "nodes": [',
  '      {"kind": "feature", "title": "...", "body": "...", "stage": "building", "anchors": ["src/..."]},',
  '      {"kind": "decision", "title": "...", "body": "..."},',
  '      {"kind": "question", "title": "...", "body": "..."}',
  "    ]}",
  "   JSON",
  "5. Verify with memory status and memory check. The product map in AGENTS.md/CLAUDE.md refreshes",
  "   automatically on save.",
  "",
  'Ongoing loop: memory query "<question>" when you need context; memory save --stdin after',
  "product-meaningful changes; memory sync at session end."
].join("\n");

export function buildIndexingBrief(): string {
  return INDEXING_BRIEF;
}

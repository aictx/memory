import {
  estimateTokenCount,
  TOKEN_CHARS_PER_TOKEN
} from "../core/tokens.js";
import type { ObjectId } from "../core/types.js";
import type { StoredMemoryObject } from "../storage/objects.js";
import type { QueryConnectedNode, QuerySeed, QuerySubgraph } from "./select.js";

export const QUERY_CONNECTED_LINE_CAP = 12;
export const QUERY_SEED_BUDGET_RATIO = 0.8;
const BODY_TRUNCATION_MARKER = "…";

export interface RenderQueryResultOptions {
  question: string;
  subgraph: QuerySubgraph;
  tokenBudget: number;
}

export interface QueryMemoryData {
  question: string;
  markdown: string;
  included_ids: ObjectId[];
  connected_ids: ObjectId[];
  estimated_tokens: number;
  truncated: boolean;
}

export function renderQueryResult(options: RenderQueryResultOptions): QueryMemoryData {
  if (options.subgraph.seeds.length === 0) {
    return renderEmptyResult(options.question);
  }

  const heading = `# Memory — "${options.question}"`;
  const matchesHeading = "## Matches";
  const seedBudget = Math.floor(options.tokenBudget * QUERY_SEED_BUDGET_RATIO);
  const rendered = renderSeedBlocks(
    options.subgraph.seeds,
    seedBudget - estimateTokenCount(heading) - estimateTokenCount(matchesHeading)
  );
  const connectedEntries = options.subgraph.connected.slice(0, QUERY_CONNECTED_LINE_CAP);
  const connectedCapped = options.subgraph.connected.length > connectedEntries.length;
  const openQuestionEntries = [...options.subgraph.openQuestions];
  const blocks = [...rendered.blocks];
  const includedIds = [...rendered.includedIds];
  let droppedForBudget = false;
  let markdown = assembleQueryMarkdown(
    heading,
    matchesHeading,
    blocks,
    connectedEntries,
    openQuestionEntries,
    includedIds
  );

  // The token budget caps the whole rendered output. Seeds are budgeted at
  // QUERY_SEED_BUDGET_RATIO up front; if connected lines, open questions, or
  // the footer still push the total over budget, drop trailing lines until it
  // fits, always keeping at least one seed.
  while (estimateTokenCount(markdown) > options.tokenBudget) {
    if (openQuestionEntries.length > 0) {
      openQuestionEntries.pop();
    } else if (connectedEntries.length > 0) {
      connectedEntries.pop();
    } else if (blocks.length > 1) {
      blocks.pop();
      includedIds.pop();
    } else {
      break;
    }

    droppedForBudget = true;
    markdown = assembleQueryMarkdown(
      heading,
      matchesHeading,
      blocks,
      connectedEntries,
      openQuestionEntries,
      includedIds
    );
  }

  return {
    question: options.question,
    markdown,
    included_ids: includedIds,
    connected_ids: [
      ...connectedEntries.map((entry) => entry.node.sidecar.id),
      ...openQuestionEntries.map((entry) => entry.node.sidecar.id)
    ],
    estimated_tokens: estimateTokenCount(markdown),
    truncated: rendered.truncated || connectedCapped || droppedForBudget
  };
}

function assembleQueryMarkdown(
  heading: string,
  matchesHeading: string,
  blocks: readonly string[],
  connectedEntries: readonly QueryConnectedNode[],
  openQuestionEntries: readonly QueryConnectedNode[],
  includedIds: readonly ObjectId[]
): string {
  const sections = [
    heading,
    [matchesHeading, ...blocks].join("\n\n")
  ];

  if (connectedEntries.length > 0) {
    sections.push(
      ["## Connected", ...connectedEntries.map(renderConnectedLine)].join("\n")
    );
  }

  if (openQuestionEntries.length > 0) {
    sections.push(
      ["## Open questions", ...openQuestionEntries.map(renderOpenQuestionLine)].join("\n")
    );
  }

  const body = sections.join("\n\n");
  const footer = renderFooter(
    includedIds.length,
    connectedEntries.length,
    estimateTokenCount(body),
    includedIds[0]
  );

  return `${body}\n\n---\n${footer}`;
}

interface RenderedSeedBlocks {
  blocks: string[];
  includedIds: ObjectId[];
  truncated: boolean;
}

function renderSeedBlocks(seeds: readonly QuerySeed[], seedBudget: number): RenderedSeedBlocks {
  const blocks: string[] = [];
  const includedIds: ObjectId[] = [];
  let remaining = Math.max(0, seedBudget);
  let truncated = false;

  for (const [index, seed] of seeds.entries()) {
    if (truncated) {
      break;
    }

    const headerLines = seedHeaderLines(seed.object);
    const body = seed.object.body.trim();
    const fullBlock = [...headerLines, body].join("\n");
    const fullTokens = estimateTokenCount(fullBlock);

    if (fullTokens <= remaining) {
      blocks.push(fullBlock);
      includedIds.push(seed.object.sidecar.id);
      remaining -= fullTokens;
      continue;
    }

    const headerTokens = estimateTokenCount(headerLines.join("\n"));

    if (index > 0 && headerTokens >= remaining) {
      truncated = true;
      break;
    }

    const allowedBodyChars = Math.max(
      0,
      (remaining - headerTokens) * TOKEN_CHARS_PER_TOKEN - BODY_TRUNCATION_MARKER.length
    );
    const truncatedBody = `${body.slice(0, allowedBodyChars).trimEnd()}${BODY_TRUNCATION_MARKER}`;

    blocks.push([...headerLines, truncatedBody].join("\n"));
    includedIds.push(seed.object.sidecar.id);
    truncated = true;
  }

  if (!truncated && includedIds.length < seeds.length) {
    truncated = true;
  }

  return {
    blocks,
    includedIds,
    truncated
  };
}

function seedHeaderLines(object: StoredMemoryObject): string[] {
  const sidecar = object.sidecar;
  const lines = [`### ${sidecar.id} — ${sidecar.title}  [${sidecar.status}]`];

  if (sidecar.type === "feature" && sidecar.stage !== undefined) {
    lines.push(`stage: ${sidecar.stage}`);
  }

  if (sidecar.anchors !== undefined && sidecar.anchors.length > 0) {
    lines.push(`anchors: ${sidecar.anchors.join(", ")}`);
  }

  return lines;
}

function renderConnectedLine(entry: QueryConnectedNode): string {
  return `- ${entry.node.sidecar.id} (${entry.predicate} ${entry.via}) — ${entry.node.sidecar.title}`;
}

function renderOpenQuestionLine(entry: QueryConnectedNode): string {
  return `- ${entry.node.sidecar.id} — ${entry.node.sidecar.title}`;
}

function renderFooter(
  matchedCount: number,
  connectedCount: number,
  estimatedTokens: number,
  topId: ObjectId | undefined
): string {
  const inspectId = topId ?? "<id>";

  return [
    `${matchedCount} matched + ${connectedCount} connected`,
    `~${estimatedTokens} tokens`,
    `\`memory inspect ${inspectId}\` for full detail`
  ].join(" · ");
}

function renderEmptyResult(question: string): QueryMemoryData {
  const markdown = [
    `No matching memory for "${question}".`,
    "Try a broader phrasing, an id, a tag, or a file path fragment."
  ].join("\n");

  return {
    question,
    markdown,
    included_ids: [],
    connected_ids: [],
    estimated_tokens: estimateTokenCount(markdown),
    truncated: false
  };
}

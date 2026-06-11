import type { AnchorVerification } from "../anchors/verify.js";
import type { Clock } from "../core/clock.js";
import { estimateTokenCount } from "../core/tokens.js";
import type { FeatureStage } from "../core/types.js";
import type { StoredMemoryObject } from "../storage/objects.js";

export const PRODUCT_MAP_TOKEN_CAP = 1200;
export const PRODUCT_MAP_HEADER =
  "## Product map (generated — do not edit; refresh with memory save or memory sync)";
export const PRODUCT_MAP_EMPTY_PLACEHOLDER =
  "No features recorded yet. Run `memory init --brief` for the indexing brief.";

const RECENT_DECISIONS_CAP = 5;
const OPEN_QUESTIONS_CAP = 5;
const STALE_LINES_CAP = 5;
const INTENT_FRAGMENT_MAX_CHARS = 80;
const TRIMMED_INTENT_FRAGMENT_MAX_CHARS = 40;
const TRUNCATION_MARKER = "…";

/** Feature stage display order; `dead` is excluded entirely. */
const STAGE_ORDER = ["building", "shipped", "paused", "idea"] as const;
const STAGE_LABELS: Record<(typeof STAGE_ORDER)[number], string> = {
  building: "Building",
  shipped: "Shipped",
  paused: "Paused",
  idea: "Idea"
};

export interface RenderProductMapOptions {
  objects: readonly StoredMemoryObject[];
  anchorFindings?: readonly AnchorVerification[] | null;
  clock?: Clock;
}

interface FeatureEntry {
  slug: string;
  intent: string;
  anchor: string | null;
}

interface MapState {
  projectLine: string | null;
  features: Map<FeatureStage, FeatureEntry[]>;
  decisions: string[];
  questions: string[];
  stale: string[];
  intentMaxChars: number;
}

/**
 * Renders the generated product map body (without the marker comments),
 * hard-capped at PRODUCT_MAP_TOKEN_CAP estimated tokens. Truncation order:
 * stale lines, open questions, intent fragments, decisions, then whole
 * feature lines from the end of each stage group (lowest-priority stage
 * first). Headers and the project line are never dropped.
 */
export function renderProductMap(options: RenderProductMapOptions): string {
  const state = buildMapState(options);
  let body = assembleMapBody(state);

  while (estimateTokenCount(body) > PRODUCT_MAP_TOKEN_CAP && shrinkMapState(state)) {
    body = assembleMapBody(state);
  }

  return body;
}

function buildMapState(options: RenderProductMapOptions): MapState {
  const active = options.objects.filter(
    (object) => object.sidecar.status === "active" || object.sidecar.status === "open"
  );
  const project = active.find((object) => object.sidecar.type === "project") ?? null;
  const features = new Map<FeatureStage, FeatureEntry[]>();

  for (const stage of STAGE_ORDER) {
    const entries = active
      .filter((object) => object.sidecar.type === "feature")
      .filter((object) => (object.sidecar.stage ?? "idea") === stage)
      .sort(byUpdatedAtDesc)
      .map((object) => ({
        slug: slugOf(object.sidecar.id),
        intent: firstSentence(object.body),
        anchor: object.sidecar.anchors?.[0] ?? null
      }));

    features.set(stage, entries);
  }

  const decisions = active
    .filter((object) => object.sidecar.type === "decision")
    .sort(byUpdatedAtDesc)
    .slice(0, RECENT_DECISIONS_CAP)
    .map((object) => `${slugOf(object.sidecar.id)} — ${object.sidecar.title}`);
  const questions = active
    .filter(
      (object) => object.sidecar.type === "question" && object.sidecar.status === "open"
    )
    .sort(byUpdatedAtDesc)
    .slice(0, OPEN_QUESTIONS_CAP)
    .map((object) => `${slugOf(object.sidecar.id)} — ${object.sidecar.title}`);
  const activeIds = new Set(active.map((object) => object.sidecar.id));
  const stale = (options.anchorFindings ?? [])
    .filter((finding) => activeIds.has(finding.id))
    .flatMap((finding) =>
      finding.orphaned_anchors.map(
        (anchor) => `${finding.id} — anchor ${anchor} matches no files`
      )
    )
    .slice(0, STALE_LINES_CAP);

  return {
    projectLine: project === null ? null : renderProjectLine(project),
    features,
    decisions,
    questions,
    stale,
    intentMaxChars: INTENT_FRAGMENT_MAX_CHARS
  };
}

function assembleMapBody(state: MapState): string {
  const sections: string[] = [];
  const headerLines = [PRODUCT_MAP_HEADER];

  if (state.projectLine !== null) {
    headerLines.push(state.projectLine);
  }

  sections.push(headerLines.join("\n"));

  const stageLines = STAGE_ORDER.filter(
    (stage) => (state.features.get(stage) ?? []).length > 0
  ).map((stage) =>
    [
      `**${STAGE_LABELS[stage]}:**`,
      (state.features.get(stage) ?? [])
        .map((entry) => renderFeatureEntry(entry, state.intentMaxChars))
        .join(" · ")
    ].join(" ")
  );

  if (stageLines.length > 0) {
    sections.push(stageLines.join("\n"));
  }

  if (state.decisions.length > 0) {
    sections.push(`**Recent decisions:** ${state.decisions.join(" · ")}`);
  }

  if (state.questions.length > 0) {
    sections.push(`**Open questions:** ${state.questions.join(" · ")}`);
  }

  if (state.stale.length > 0) {
    sections.push(`**Stale:** ${state.stale.join("\n")}`);
  }

  if (sections.length === 1) {
    sections.push(PRODUCT_MAP_EMPTY_PLACEHOLDER);
  }

  return sections.join("\n\n");
}

/** Removes one unit of content in the specified truncation order. */
function shrinkMapState(state: MapState): boolean {
  if (state.stale.length > 0) {
    state.stale.pop();
    return true;
  }

  if (state.questions.length > 0) {
    state.questions.pop();
    return true;
  }

  if (state.intentMaxChars > TRIMMED_INTENT_FRAGMENT_MAX_CHARS && hasFeatureIntent(state)) {
    state.intentMaxChars = TRIMMED_INTENT_FRAGMENT_MAX_CHARS;
    return true;
  }

  if (state.decisions.length > 0) {
    state.decisions.pop();
    return true;
  }

  for (const stage of [...STAGE_ORDER].reverse()) {
    const entries = state.features.get(stage) ?? [];

    if (entries.length > 0) {
      entries.pop();
      return true;
    }
  }

  return false;
}

function hasFeatureIntent(state: MapState): boolean {
  for (const entries of state.features.values()) {
    if (entries.some((entry) => entry.intent.length > TRIMMED_INTENT_FRAGMENT_MAX_CHARS)) {
      return true;
    }
  }

  return false;
}

function renderProjectLine(project: StoredMemoryObject): string {
  const sentence = firstSentence(project.body);

  if (sentence === "") {
    return `${project.sidecar.title}.`;
  }

  const terminated = /[.!?]$/u.test(sentence) ? sentence : `${sentence}.`;
  return `${project.sidecar.title} — ${terminated}`;
}

function renderFeatureEntry(entry: FeatureEntry, intentMaxChars: number): string {
  const parts = [entry.slug];
  const intent = truncateFragment(entry.intent, intentMaxChars);

  if (intent !== "") {
    parts.push(intent);
  }

  if (entry.anchor !== null) {
    parts.push(entry.anchor);
  }

  return parts.join(" — ");
}

function truncateFragment(fragment: string, maxChars: number): string {
  if (fragment.length <= maxChars) {
    return fragment;
  }

  return `${fragment.slice(0, maxChars - TRUNCATION_MARKER.length).trimEnd()}${TRUNCATION_MARKER}`;
}

/** First sentence of a markdown body, ignoring heading lines. */
function firstSentence(body: string): string {
  const text = body
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  const match = /^.*?[.!?](?=\s|$)/u.exec(text);

  return (match?.[0] ?? text).trim();
}

function slugOf(id: string): string {
  const separator = id.indexOf(".");
  return separator === -1 ? id : id.slice(separator + 1);
}

function byUpdatedAtDesc(left: StoredMemoryObject, right: StoredMemoryObject): number {
  return (
    right.sidecar.updated_at.localeCompare(left.sidecar.updated_at) ||
    left.sidecar.id.localeCompare(right.sidecar.id)
  );
}

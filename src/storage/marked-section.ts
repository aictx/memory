export interface MarkedSectionMarkers {
  start: string;
  end: string;
}

export const AGENT_GUIDANCE_MARKERS: MarkedSectionMarkers = {
  start: "<!-- memory:start -->",
  end: "<!-- memory:end -->"
};

export const LEGACY_AGENT_GUIDANCE_MARKERS: MarkedSectionMarkers = {
  start: "<!-- aictx-memory:start -->",
  end: "<!-- aictx-memory:end -->"
};

export const PRODUCT_MAP_MARKERS: MarkedSectionMarkers = {
  start: "<!-- memory:map:start -->",
  end: "<!-- memory:map:end -->"
};

export type MarkedSectionResult =
  | { status: "updated"; contents: string }
  | { status: "skipped" };

export interface ApplyMarkedSectionOptions {
  /**
   * When true (default), a file without the markers gets the block appended
   * after the existing content. When false, missing markers report skipped.
   */
  appendIfMissing?: boolean;
}

/** Wraps a section body in its marker comments, ending with one newline. */
export function buildMarkedSectionBlock(
  markers: MarkedSectionMarkers,
  body: string
): string {
  return `${markers.start}\n${body}\n${markers.end}\n`;
}

/**
 * Replaces the marked section of `contents` with `block` (which must include
 * the markers and end with a newline). Exactly one start and one end marker
 * are replaced in place; zero markers appends (unless disabled); ambiguous
 * or out-of-order markers report skipped without modifying anything.
 */
export function applyMarkedSection(
  contents: string,
  markers: MarkedSectionMarkers,
  block: string,
  options: ApplyMarkedSectionOptions = {}
): MarkedSectionResult {
  const startCount = countOccurrences(contents, markers.start);
  const endCount = countOccurrences(contents, markers.end);

  if (startCount === 0 && endCount === 0) {
    if (options.appendIfMissing === false) {
      return { status: "skipped" };
    }

    const base = contents.replace(/\n*$/u, "");
    const separator = base === "" ? "" : "\n\n";

    return {
      status: "updated",
      contents: `${base}${separator}${block}`
    };
  }

  if (startCount !== 1 || endCount !== 1) {
    return { status: "skipped" };
  }

  const startIndex = contents.indexOf(markers.start);
  const endIndex = contents.indexOf(markers.end);

  if (startIndex > endIndex) {
    return { status: "skipped" };
  }

  const replaceEnd = endIndex + markers.end.length;
  const hasTrailingBlockNewline = contents.slice(replaceEnd, replaceEnd + 1) === "\n";
  const suffixStart = hasTrailingBlockNewline ? replaceEnd + 1 : replaceEnd;

  return {
    status: "updated",
    contents: `${contents.slice(0, startIndex)}${block}${contents.slice(suffixStart)}`
  };
}

/**
 * Returns the body between the markers (without the marker lines), or null
 * when the markers are missing, duplicated, or out of order.
 */
export function extractMarkedSection(
  contents: string,
  markers: MarkedSectionMarkers
): string | null {
  if (
    countOccurrences(contents, markers.start) !== 1 ||
    countOccurrences(contents, markers.end) !== 1
  ) {
    return null;
  }

  const startIndex = contents.indexOf(markers.start);
  const endIndex = contents.indexOf(markers.end);

  if (startIndex > endIndex) {
    return null;
  }

  return contents
    .slice(startIndex + markers.start.length, endIndex)
    .replace(/^\n/u, "")
    .replace(/\n$/u, "");
}

export function countOccurrences(value: string, search: string): number {
  if (search === "") {
    return 0;
  }

  return value.split(search).length - 1;
}

import { memoryError, type MemoryError } from "../core/errors.js";
import { err, ok, type Result } from "../core/result.js";

export interface AnchorIssue {
  anchor: string;
  message: string;
}

export type NormalizeAnchorResult =
  | { ok: true; anchor: string }
  | { ok: false; message: string };

/**
 * Normalizes one anchor value.
 *
 * Anchors are repo-relative glob strings such as `src/index/` or
 * `src/**\/*.ts`. Normalization trims whitespace and strips one leading
 * `./`. Validation rejects absolute paths, backslashes, `..` segments,
 * URLs, control characters, and references into `.memory/`.
 */
export function normalizeAnchor(value: string): NormalizeAnchorResult {
  const trimmed = value.trim();

  if (trimmed === "") {
    return { ok: false, message: "Anchor must be a non-empty repo-relative glob." };
  }

  if (trimmed.includes("\\")) {
    return { ok: false, message: "Anchor must use forward slashes, not backslashes." };
  }

  if (trimmed.includes("\0")) {
    return { ok: false, message: "Anchor must not contain control characters." };
  }

  if (trimmed.includes("://")) {
    return { ok: false, message: "Anchor must be a repo-relative glob, not a URL." };
  }

  const normalized = trimmed.replace(/^\.\//u, "");

  if (normalized === "" || normalized === ".") {
    return { ok: false, message: "Anchor must reference a path inside the repository." };
  }

  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    return { ok: false, message: "Anchor must be repo-relative, not an absolute path." };
  }

  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.endsWith("/..") ||
    normalized.includes("/../")
  ) {
    return { ok: false, message: "Anchor must not contain `..` segments." };
  }

  if (normalized === ".memory" || normalized.startsWith(".memory/")) {
    return { ok: false, message: "Anchor must not reference Memory storage under .memory/." };
  }

  return { ok: true, anchor: normalized };
}

/**
 * Normalizes and validates a list of anchors, deduplicating while
 * preserving first-seen order. Returns a MemoryValidationFailed error
 * listing every invalid anchor when any value is rejected.
 */
export function validateAnchors(
  values: readonly string[],
  field = "anchors"
): Result<string[]> {
  const anchors: string[] = [];
  const seen = new Set<string>();
  const issues: AnchorIssue[] = [];

  for (const value of values) {
    const normalized = normalizeAnchor(value);

    if (!normalized.ok) {
      issues.push({ anchor: value, message: normalized.message });
      continue;
    }

    if (!seen.has(normalized.anchor)) {
      seen.add(normalized.anchor);
      anchors.push(normalized.anchor);
    }
  }

  if (issues.length > 0) {
    return err(invalidAnchorsError(issues, field));
  }

  return ok(anchors);
}

function invalidAnchorsError(issues: readonly AnchorIssue[], field: string): MemoryError {
  return memoryError("MemoryValidationFailed", "Anchors must be repo-relative glob strings.", {
    field,
    issues: issues.map((issue) => ({
      anchor: issue.anchor,
      message: issue.message
    }))
  });
}

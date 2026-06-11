import picomatch from "picomatch";

import type { ObjectId } from "../core/types.js";
import type { StoredMemoryObject } from "../storage/objects.js";
import { normalizeAnchor } from "./normalize.js";

export interface AnchorVerification {
  id: ObjectId;
  matched_anchors: string[];
  orphaned_anchors: string[];
}

/**
 * Verifies the anchors of each object against the repo file list.
 *
 * Anchor semantics:
 * - Glob anchors (`src/**\/*.ts`) match with picomatch (`dot: true`).
 * - Exact file anchors (`src/cli/main.ts`) match that file exactly.
 * - Bare directory-style anchors (`src/query/` or `src/query`) match any
 *   file under that path, i.e. `src/query/**` semantics.
 *
 * Only objects that carry at least one anchor produce a result entry.
 */
export function verifyAnchors(
  objects: readonly StoredMemoryObject[],
  trackedFiles: readonly string[]
): AnchorVerification[] {
  const findings: AnchorVerification[] = [];

  for (const object of objects) {
    const anchors = object.sidecar.anchors ?? [];

    if (anchors.length === 0) {
      continue;
    }

    const matched: string[] = [];
    const orphaned: string[] = [];

    for (const anchor of anchors) {
      if (anchorMatchesAnyFile(anchor, trackedFiles)) {
        matched.push(anchor);
      } else {
        orphaned.push(anchor);
      }
    }

    findings.push({
      id: object.sidecar.id,
      matched_anchors: matched,
      orphaned_anchors: orphaned
    });
  }

  return findings;
}

export function anchorMatchesAnyFile(
  anchor: string,
  trackedFiles: readonly string[]
): boolean {
  const matcher = buildAnchorMatcher(anchor);

  if (matcher === null) {
    return false;
  }

  // Wrap the call: picomatch matchers take a second `returnObject` argument,
  // so passing them directly to Array#some would hand them the index.
  return trackedFiles.some((file) => matcher(file) === true);
}

function buildAnchorMatcher(anchor: string): ((file: string) => boolean) | null {
  const normalized = normalizeAnchor(anchor);

  if (!normalized.ok) {
    return null;
  }

  const pattern = normalized.anchor.replace(/\/+$/u, "");

  if (pattern === "") {
    return null;
  }

  if (!picomatch.scan(pattern).isGlob) {
    const directoryPrefix = `${pattern}/`;
    return (file) => file === pattern || file.startsWith(directoryPrefix);
  }

  return picomatch(pattern, { dot: true });
}

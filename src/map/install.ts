import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { verifyAnchors, type AnchorVerification } from "../anchors/verify.js";
import { normalizeLineEndingsToLf, writeTextAtomic } from "../core/fs.js";
import { listTrackedFiles, type GitWrapperOptions } from "../core/git.js";
import {
  applyMarkedSection,
  buildMarkedSectionBlock,
  PRODUCT_MAP_MARKERS
} from "../storage/marked-section.js";
import type { CanonicalStorageSnapshot } from "../storage/read.js";
import { renderProductMap } from "./render.js";

export const PRODUCT_MAP_TARGETS = ["AGENTS.md", "CLAUDE.md"] as const;

export type ProductMapStorage = Pick<CanonicalStorageSnapshot, "objects">;

export interface ProductMapBody {
  body: string;
  anchorFindings: AnchorVerification[] | null;
  warnings: string[];
}

export interface RefreshProductMapResult {
  updated: string[];
  skipped: string[];
  warnings: string[];
}

/**
 * Renders the product map body for the current storage, verifying anchors
 * against tracked plus untracked-but-present files. Anchor verification is
 * skipped silently outside Git and degraded to a warning when Git fails.
 */
export async function buildProductMapBody(
  projectRoot: string,
  storage: ProductMapStorage,
  options: GitWrapperOptions = {}
): Promise<ProductMapBody> {
  const warnings: string[] = [];
  let anchorFindings: AnchorVerification[] | null = null;
  const trackedFiles = await listTrackedFiles(projectRoot, options);

  if (!trackedFiles.ok) {
    warnings.push(`Anchor verification skipped: ${trackedFiles.error.message}`);
  } else if (trackedFiles.data !== null) {
    anchorFindings = verifyAnchors(storage.objects, trackedFiles.data);
  }

  return {
    body: renderProductMap({ objects: storage.objects, anchorFindings }),
    anchorFindings,
    warnings
  };
}

/**
 * Rewrites only the marked product map section in AGENTS.md and CLAUDE.md.
 * Targets that are missing or have no map markers are skipped with a
 * warning; init owns installing the section. Never throws — every failure
 * degrades to a warning so callers can treat map refresh as best-effort.
 */
export async function refreshProductMap(
  projectRoot: string,
  storage: ProductMapStorage,
  options: GitWrapperOptions = {}
): Promise<RefreshProductMapResult> {
  const updated: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  try {
    const map = await buildProductMapBody(projectRoot, storage, options);
    warnings.push(...map.warnings);
    const block = buildMarkedSectionBlock(PRODUCT_MAP_MARKERS, map.body);

    for (const target of PRODUCT_MAP_TARGETS) {
      const result = await refreshProductMapTarget(projectRoot, target, block);

      if (result.warning !== null) {
        warnings.push(result.warning);
      }

      if (result.status === "updated") {
        updated.push(target);
      } else if (result.status === "skipped") {
        skipped.push(target);
      }
    }
  } catch (error) {
    warnings.push(`Product map refresh failed: ${messageFromUnknown(error)}`);
  }

  return { updated, skipped, warnings };
}

interface RefreshTargetResult {
  status: "updated" | "unchanged" | "skipped";
  warning: string | null;
}

async function refreshProductMapTarget(
  projectRoot: string,
  target: string,
  block: string
): Promise<RefreshTargetResult> {
  let existing: string | null;

  try {
    existing = await readFile(join(projectRoot, target), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      existing = null;
    } else {
      return {
        status: "skipped",
        warning: `Product map in ${target} was not refreshed: ${messageFromUnknown(error)}`
      };
    }
  }

  if (existing === null) {
    return {
      status: "skipped",
      warning: `Product map in ${target} was not refreshed because the file is missing. Run \`memory init\` to install it.`
    };
  }

  const normalized = normalizeLineEndingsToLf(existing);
  const applied = applyMarkedSection(normalized, PRODUCT_MAP_MARKERS, block, {
    appendIfMissing: false
  });

  if (applied.status === "skipped") {
    return {
      status: "skipped",
      warning: `Product map in ${target} was not refreshed because Memory map markers are missing or ambiguous. Run \`memory init\` to install them.`
    };
  }

  if (applied.contents === normalized) {
    return { status: "unchanged", warning: null };
  }

  const written = await writeTextAtomic(projectRoot, target, applied.contents);

  if (!written.ok) {
    return {
      status: "skipped",
      warning: `Product map in ${target} was not refreshed: ${written.error.message}`
    };
  }

  return { status: "updated", warning: null };
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }

  const code = error.code;
  return typeof code === "string" ? code : null;
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

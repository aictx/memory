import {
  anchorMatchesAnyFile,
  filterFilesMatchingAnchor
} from "../anchors/verify.js";
import type { Clock } from "../core/clock.js";
import { readUtf8FileInsideRoot, writeTextAtomic } from "../core/fs.js";
import {
  getChangedFilesBetween,
  getChangedProjectFiles,
  getMergeBase,
  isAncestorCommit,
  isIgnoredProjectChangePath,
  type GitWrapperOptions
} from "../core/git.js";
import { ok, type Result } from "../core/result.js";
import type { ObjectId } from "../core/types.js";
import type { StoredMemoryObject } from "../storage/objects.js";

export const SYNC_STATE_PATH = ".memory/sync-state.json";
export const SYNC_STATE_VERSION = 1;
export const SYNC_SAVE_SKELETON_TASK = "sync reconciliation";

const COVERAGE_GAP_DIRECTORY_CAP = 10;
const COVERAGE_GAP_EXAMPLES_CAP = 3;
const SAFE_COMMIT_PATTERN = /^[0-9a-f]{6,64}$/iu;

export interface SyncChangedNode {
  id: ObjectId;
  anchors: string[];
  files: string[];
}

export interface SyncOrphanedNode {
  id: ObjectId;
  anchors: string[];
}

export interface SyncCoverageGap {
  dir: string;
  files_count: number;
  examples: string[];
}

export interface SyncSaveSkeleton {
  task: string;
  nodes: Array<{ id: ObjectId }>;
  stale: Array<{ id: ObjectId; reason: string }>;
}

export interface SyncVerdicts {
  fresh: ObjectId[];
  changed: SyncChangedNode[];
  orphaned: SyncOrphanedNode[];
  unanchored: ObjectId[];
  coverage_gaps: SyncCoverageGap[];
  titles: Record<ObjectId, string>;
}

export interface SyncBaseline {
  fullVerification: boolean;
  baseCommit: string | null;
  /** Committed plus working-tree changes, ignored paths excluded, sorted. */
  changedFiles: string[];
  /** Committed deletions and rename old paths (subset of changedFiles). */
  deletedFiles: string[];
}

export interface SyncEngineInput {
  objects: readonly StoredMemoryObject[];
  /** Current repo files: tracked plus untracked-but-present additions. */
  currentFiles: readonly string[];
  changedFiles: readonly string[];
  deletedFiles: readonly string[];
}

/**
 * Reads the committed sync marker defensively. Any problem — missing file,
 * invalid JSON, wrong version, or a commit that is not a plain hex sha —
 * yields null so the caller runs in full-verification mode instead of
 * failing.
 */
export async function readSyncMarker(projectRoot: string): Promise<string | null> {
  const contents = await readUtf8FileInsideRoot(projectRoot, SYNC_STATE_PATH);

  if (!contents.ok) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(contents.data);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const marker = parsed as { version?: unknown; last_sync_commit?: unknown };

  if (marker.version !== SYNC_STATE_VERSION) {
    return null;
  }

  if (
    typeof marker.last_sync_commit !== "string" ||
    !SAFE_COMMIT_PATTERN.test(marker.last_sync_commit)
  ) {
    return null;
  }

  return marker.last_sync_commit;
}

/** Writes the sync marker for the given HEAD commit atomically. */
export async function writeSyncMarker(
  projectRoot: string,
  headCommit: string,
  clock: Clock
): Promise<Result<void>> {
  const marker = {
    version: SYNC_STATE_VERSION,
    last_sync_commit: headCommit,
    last_sync_at: clock.nowIso()
  };

  return writeTextAtomic(projectRoot, SYNC_STATE_PATH, `${JSON.stringify(marker, null, 2)}\n`);
}

/**
 * Resolves the diff baseline for one sync run. The marker commit is used
 * directly when it is an ancestor of HEAD; after a rebase or amend the merge
 * base is used instead; when no base can be computed the run degrades to
 * full-verification mode with an empty changed set. The changed set is the
 * committed `base..HEAD` diff (rename old paths included as deletions)
 * unioned with working-tree changes, excluding `.memory/**` and generated
 * build output.
 */
export async function resolveSyncBaseline(options: {
  projectRoot: string;
  markerCommit: string | null;
  runner?: GitWrapperOptions["runner"];
}): Promise<Result<SyncBaseline>> {
  const gitOptions = options.runner === undefined ? {} : { runner: options.runner };

  if (options.markerCommit === null) {
    return ok(fullVerificationBaseline());
  }

  const ancestor = await isAncestorCommit(
    options.projectRoot,
    options.markerCommit,
    "HEAD",
    gitOptions
  );

  if (!ancestor.ok) {
    return ancestor;
  }

  let base = options.markerCommit;

  if (!ancestor.data) {
    const mergeBase = await getMergeBase(options.projectRoot, options.markerCommit, "HEAD", gitOptions);

    if (!mergeBase.ok) {
      return mergeBase;
    }

    if (mergeBase.data === null) {
      return ok(fullVerificationBaseline());
    }

    base = mergeBase.data;
  }

  const committed = await getChangedFilesBetween(options.projectRoot, base, gitOptions);

  if (!committed.ok) {
    return committed;
  }

  const working = await getChangedProjectFiles(options.projectRoot, gitOptions);

  if (!working.ok) {
    return working;
  }

  const changed = new Set<string>();
  const deleted = new Set<string>();

  for (const change of committed.data) {
    if (!isIgnoredProjectChangePath(change.path)) {
      changed.add(change.path);

      if (change.status === "D") {
        deleted.add(change.path);
      }
    }

    if (change.oldPath !== null && !isIgnoredProjectChangePath(change.oldPath)) {
      changed.add(change.oldPath);

      if (change.status === "R") {
        deleted.add(change.oldPath);
      }
    }
  }

  for (const file of working.data.changedFiles) {
    changed.add(file);
  }

  return ok({
    fullVerification: false,
    baseCommit: base,
    changedFiles: [...changed].sort(),
    deletedFiles: [...deleted].sort()
  });
}

/**
 * Classifies every live (active/open) node by anchor state:
 *
 * - `orphaned`: at least one anchor matches no current file. Orphaned is the
 *   more urgent verdict, so a node that is both orphaned and changed is
 *   reported once here, listing only its dead anchors.
 * - `changed`: an anchor matches a path in the changed set (deleted old
 *   paths included).
 * - `fresh`: anchored, no orphaned anchors, no changed-set hits.
 * - `unanchored`: live nodes without anchors, informational only. The
 *   project node is excluded — it never carries anchors by design.
 *
 * Coverage gaps are changed files (excluding deletions) that match no anchor
 * of any live node, grouped by top-level directory.
 */
export function computeSyncVerdicts(input: SyncEngineInput): SyncVerdicts {
  const liveObjects = input.objects.filter(
    (object) => object.sidecar.status === "active" || object.sidecar.status === "open"
  );
  const fresh: ObjectId[] = [];
  const changed: SyncChangedNode[] = [];
  const orphaned: SyncOrphanedNode[] = [];
  const unanchored: ObjectId[] = [];
  const titles: Record<ObjectId, string> = {};
  const liveAnchors: string[] = [];

  for (const object of liveObjects) {
    const sidecar = object.sidecar;
    const anchors = sidecar.anchors ?? [];

    if (anchors.length === 0) {
      if (sidecar.type !== "project") {
        unanchored.push(sidecar.id);
        titles[sidecar.id] = sidecar.title;
      }

      continue;
    }

    liveAnchors.push(...anchors);

    const orphanedAnchors = anchors.filter(
      (anchor) => !anchorMatchesAnyFile(anchor, input.currentFiles)
    );

    if (orphanedAnchors.length > 0) {
      orphaned.push({ id: sidecar.id, anchors: orphanedAnchors });
      titles[sidecar.id] = sidecar.title;
      continue;
    }

    const hitAnchors: string[] = [];
    const hitFiles = new Set<string>();

    for (const anchor of anchors) {
      const files = filterFilesMatchingAnchor(anchor, input.changedFiles);

      if (files.length > 0) {
        hitAnchors.push(anchor);

        for (const file of files) {
          hitFiles.add(file);
        }
      }
    }

    if (hitAnchors.length > 0) {
      changed.push({ id: sidecar.id, anchors: hitAnchors, files: [...hitFiles].sort() });
      titles[sidecar.id] = sidecar.title;
    } else {
      fresh.push(sidecar.id);
    }
  }

  fresh.sort();
  unanchored.sort();
  changed.sort((left, right) => left.id.localeCompare(right.id));
  orphaned.sort((left, right) => left.id.localeCompare(right.id));

  return {
    fresh,
    changed,
    orphaned,
    unanchored,
    coverage_gaps: computeCoverageGaps(input, liveAnchors),
    titles
  };
}

/**
 * Builds the pre-filled `memory save --stdin` skeleton: changed nodes as
 * bare-id update slots and orphaned nodes as stale candidates.
 */
export function buildSyncSaveSkeleton(
  changed: readonly SyncChangedNode[],
  orphaned: readonly SyncOrphanedNode[]
): SyncSaveSkeleton {
  return {
    task: SYNC_SAVE_SKELETON_TASK,
    nodes: changed.map((node) => ({ id: node.id })),
    stale: orphaned.map((node) => ({ id: node.id, reason: "" }))
  };
}

function computeCoverageGaps(
  input: SyncEngineInput,
  liveAnchors: readonly string[]
): SyncCoverageGap[] {
  const deleted = new Set(input.deletedFiles);
  const groups = new Map<string, string[]>();

  for (const file of input.changedFiles) {
    if (deleted.has(file)) {
      continue;
    }

    if (liveAnchors.some((anchor) => anchorMatchesAnyFile(anchor, [file]))) {
      continue;
    }

    const dir = topLevelDirectory(file);
    const files = groups.get(dir) ?? [];

    files.push(file);
    groups.set(dir, files);
  }

  return [...groups.entries()]
    .map(([dir, files]) => ({
      dir,
      files_count: files.length,
      examples: [...files].sort().slice(0, COVERAGE_GAP_EXAMPLES_CAP)
    }))
    .sort(
      (left, right) =>
        right.files_count - left.files_count || left.dir.localeCompare(right.dir)
    )
    .slice(0, COVERAGE_GAP_DIRECTORY_CAP);
}

function topLevelDirectory(file: string): string {
  const separator = file.indexOf("/");
  return separator === -1 ? "." : file.slice(0, separator);
}

function fullVerificationBaseline(): SyncBaseline {
  return {
    fullVerification: true,
    baseCommit: null,
    changedFiles: [],
    deletedFiles: []
  };
}

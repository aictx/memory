import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { systemClock, type Clock } from "../core/clock.js";
import { memoryError, type MemoryError } from "../core/errors.js";
import { readUtf8FileInsideRoot } from "../core/fs.js";
import {
  getMemoryDiff,
  getMemoryDirtyState,
  getGitState,
  getRecentProjectFileChanges,
  getTrackedMemoryDirtyFiles,
  listTrackedFiles,
  showMemoryFileAtCommit,
  type GitWrapperOptions,
  type ProjectFileChange
} from "../core/git.js";
import { withProjectLock } from "../core/lock.js";
import { resolveProjectPaths, type ProjectPaths } from "../core/paths.js";
import { err, ok, type Result } from "../core/result.js";
import { runSubprocess } from "../core/subprocess.js";
import { normalizeTokenBudget } from "../core/tokens.js";
import {
  FEATURE_STAGES,
  type FeatureStage,
  type IsoDateTime,
  type MemoryMeta,
  type ObjectId,
  type ObjectStatus,
  type ObjectType,
  type Predicate,
  type RelationConfidence,
  type RelationId,
  type RelationStatus,
  type Source,
  type SourceOrigin,
  type ValidationIssue
} from "../core/types.js";
import { verifyAnchors, type AnchorVerification } from "../anchors/verify.js";
import {
  updateIndexAfterCanonicalWrite
} from "../index/incremental.js";
import {
  buildProductMapBody,
  refreshProductMap,
  PRODUCT_MAP_TARGETS
} from "../map/install.js";
import {
  rebuildIndex as rebuildGeneratedIndex,
  type RebuildIndexData
} from "../index/rebuild.js";
import { CURRENT_INDEX_SCHEMA_VERSION } from "../index/migrations.js";
import { searchIndex, type SearchMemoryData } from "../index/search.js";
import { renderQueryResult, type QueryMemoryData } from "../query/render.js";
import { selectQuerySubgraph, QUERY_SEED_LIMIT } from "../query/select.js";
import {
  buildSaveMemoryPatch,
  type SaveMemoryPatch
} from "../save/plan.js";
import {
  currentProjectRegistryEntry,
  findRegisteredProject,
  pruneProjectRegistry,
  readProjectRegistry,
  removeProjectFromRegistry,
  removeProjectRootFromRegistry,
  removeProjectRootsFromRegistry,
  resolveProjectRegistryLocation,
  upsertCurrentProjectInRegistry,
  type ProjectRegistryEntry,
  type ProjectRegistrySource,
  type ResolvedProjectRegistryEntry
} from "../registry/projects.js";
import { openSqliteDatabase } from "../index/sqlite-driver.js";
import { resolveIndexDatabasePath } from "../index/sqlite.js";
import { buildIndexingBrief } from "../init/brief.js";
import {
  initializeStorage,
  planInitializeStorage,
  type InitStorageData
} from "../storage/init.js";
import { CURRENT_STORAGE_VERSION } from "../storage/objects.js";
import {
  extractMarkedSection,
  PRODUCT_MAP_MARKERS
} from "../storage/marked-section.js";
import type { StoredMemoryObject } from "../storage/objects.js";
import {
  checkStorageVersion,
  readCanonicalStorage,
  type CanonicalStorageSnapshot
} from "../storage/read.js";
import type { StoredMemoryRelation } from "../storage/relations.js";
import {
  applyMemoryPatch,
  restoreCanonicalStorageFromCommit
} from "../storage/write.js";
import { planMemoryPatch } from "../storage/patch.js";
import {
  buildSyncSaveSkeleton,
  computeSyncVerdicts,
  readSyncMarker,
  resolveSyncBaseline,
  writeSyncMarker,
  type SyncChangedNode,
  type SyncCoverageGap,
  type SyncOrphanedNode,
  type SyncSaveSkeleton
} from "../sync/engine.js";
import {
  detectSecretsInPatch,
  secretDetectionError
} from "../validation/secrets.js";
import { validateProject } from "../validation/validate.js";

const INITIAL_INDEX_UNAVAILABLE_WARNING =
  "Initial index was not built because the index module is not available yet.";

export interface InitProjectOptions extends GitWrapperOptions {
  cwd: string;
  clock?: Clock;
  agentGuidance?: boolean;
  force?: boolean;
  dryRun?: boolean;
  allowTrackedMemoryDeletions?: boolean;
}

export interface InitProjectData extends InitStorageData {
  dry_run: boolean;
  brief: string;
}

export interface GetProjectStatusOptions extends GitWrapperOptions {
  cwd: string;
  clock?: Clock;
}

export interface StatusFeatureStageSummary {
  count: number;
  titles: string[];
}

export interface StatusOpenQuestion {
  id: ObjectId;
  title: string;
}

export interface StatusStaleAnchors {
  id: ObjectId;
  title: string;
  orphaned_anchors: string[];
}

export interface StatusSyncState {
  last_sync_commit: string | null;
  last_sync_at: IsoDateTime | null;
}

export interface StatusData {
  project: {
    id: string;
    name: string;
  };
  features_by_stage: Record<FeatureStage, StatusFeatureStageSummary>;
  open_questions: StatusOpenQuestion[];
  stale: StatusStaleAnchors[];
  last_activity: IsoDateTime | null;
  last_sync: StatusSyncState | null;
}

export interface ProjectStatusRow {
  registry_id: string;
  project: {
    id: string;
    name: string;
  };
  project_root: string;
  needs_reset: boolean;
  storage_version: number | string | null;
  features_by_stage: Record<FeatureStage, StatusFeatureStageSummary> | null;
  open_questions: StatusOpenQuestion[] | null;
  stale: StatusStaleAnchors[] | null;
  last_activity: IsoDateTime | null;
  last_sync: StatusSyncState | null;
}

export interface AllProjectsStatusData {
  registry_path: string;
  projects: ProjectStatusRow[];
}

export interface RebuildIndexOptions extends GitWrapperOptions {
  cwd: string;
  clock?: Clock;
}

export interface CheckProjectOptions extends GitWrapperOptions {
  cwd: string;
}

export interface QueryMemoryOptions extends GitWrapperOptions {
  cwd: string;
  question: string;
  tokenBudget?: number;
  clock?: Clock;
}

export interface InspectMemoryOptions extends GitWrapperOptions {
  cwd: string;
  id: ObjectId;
}

export interface DiffMemoryOptions extends GitWrapperOptions {
  cwd: string;
}

export interface SyncMemoryOptions extends GitWrapperOptions {
  cwd: string;
  dryRun?: boolean;
  clock?: Clock;
}

export interface SyncMemoryData {
  base_commit: string | null;
  head_commit: string;
  full_verification: boolean;
  changed_files_count: number;
  fresh: ObjectId[];
  changed: SyncChangedNode[];
  orphaned: SyncOrphanedNode[];
  unanchored: ObjectId[];
  coverage_gaps: SyncCoverageGap[];
  save_skeleton: SyncSaveSkeleton;
  marker_advanced: boolean;
  /** Titles for the ids reported in changed/orphaned/unanchored. */
  titles: Record<ObjectId, string>;
}

export interface ResetMemoryOptions extends GitWrapperOptions {
  cwd: string;
  destroy?: boolean;
  memoryHome?: string;
}

export interface GetViewerBootstrapOptions extends GitWrapperOptions {
  cwd: string;
}

export interface ProjectRegistryOperationOptions extends GitWrapperOptions {
  cwd: string;
  memoryHome?: string;
  clock?: Clock;
}

export interface AddRegisteredProjectOptions extends ProjectRegistryOperationOptions {
  path?: string;
}

export interface RemoveRegisteredProjectOptions extends ProjectRegistryOperationOptions {
  identifier: string;
}

export interface GetViewerProjectsOptions extends ProjectRegistryOperationOptions {}

export interface GetViewerProjectBootstrapOptions extends ProjectRegistryOperationOptions {
  registryId: string;
}

export interface DeleteViewerProjectOptions extends ProjectRegistryOperationOptions {
  registryId: string;
}

export interface SaveMemoryPatchOptions extends GitWrapperOptions {
  cwd: string;
  patch?: unknown;
  clock?: Clock;
}

export interface SaveMemoryOptions extends GitWrapperOptions {
  cwd: string;
  input?: unknown;
  dryRun?: boolean;
  clock?: Clock;
}

export interface SaveMemoryPatchData {
  files_changed: string[];
  recovery_files: {
    path: string;
    recovery_path: string;
    reason: string;
  }[];
  repairs_applied: string[];
  memory_created: ObjectId[];
  memory_updated: ObjectId[];
  memory_deleted: ObjectId[];
  relations_created: RelationId[];
  relations_updated: RelationId[];
  relations_deleted: RelationId[];
  events_appended: number;
  index_updated: boolean;
}

export interface SaveMemoryData extends SaveMemoryPatchData {
  dry_run: boolean;
  patch: SaveMemoryPatch;
}

export interface DiffMemoryData {
  diff: string;
  changed_files: string[];
  untracked_files: string[];
  changed_memory_ids: ObjectId[];
  changed_relation_ids: RelationId[];
}

export interface CheckProjectData {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface MemoryObjectSummary {
  id: ObjectId;
  type: ObjectType;
  status: ObjectStatus;
  title: string;
  body_path: string;
  json_path: string;
  stage: FeatureStage | null;
  anchors: string[];
  tags: string[];
  evidence: Array<{
    kind: "memory" | "relation" | "file" | "commit" | "task" | "source";
    id: string;
  }>;
  source: Source | null;
  origin: SourceOrigin | null;
  superseded_by: ObjectId | null;
  created_at: string;
  updated_at: string;
  body: string;
}

export interface MemoryRelationSummary {
  id: RelationId;
  from: ObjectId;
  predicate: Predicate;
  to: ObjectId;
  status: RelationStatus;
  confidence: RelationConfidence | null;
  evidence: Array<{
    kind: "memory" | "relation" | "file" | "commit" | "task" | "source";
    id: string;
  }>;
  content_hash: string | null;
  created_at: string;
  updated_at: string;
  json_path: string;
}

export interface InspectMemoryData {
  object: MemoryObjectSummary;
  relations: {
    outgoing: MemoryRelationSummary[];
    incoming: MemoryRelationSummary[];
  };
}

export interface ViewerBootstrapData {
  project: {
    id: string;
    name: string;
  };
  objects: MemoryObjectSummary[];
  relations: MemoryRelationSummary[];
  counts: {
    objects: number;
    relations: number;
    stale_objects: number;
    superseded_objects: number;
    active_relations: number;
  };
  storage_warnings: string[];
}

export interface RegisteredProjectSummary {
  registry_id: string;
  project: {
    id: string;
    name: string;
  };
  project_root: string;
  memory_root: string;
  source: ProjectRegistrySource;
  registered_at: string;
  last_seen_at: string;
}

export interface ProjectRegistryListData {
  registry_path: string;
  projects: RegisteredProjectSummary[];
}

export interface ProjectRegistryAddData {
  registry_path: string;
  project: RegisteredProjectSummary;
}

export interface ProjectRegistryRemoveData {
  registry_path: string;
  removed: RegisteredProjectSummary;
}

export interface ProjectRegistryPruneData {
  registry_path: string;
  projects: RegisteredProjectSummary[];
  removed: RegisteredProjectSummary[];
}

export interface ViewerProjectSummary extends RegisteredProjectSummary {
  current: boolean;
  available: boolean;
  counts: ViewerBootstrapData["counts"] | null;
  git: MemoryMeta["git"] | null;
  warnings: string[];
}

export interface ViewerProjectsData {
  registry_path: string;
  projects: ViewerProjectSummary[];
  counts: {
    projects: number;
    available: number;
    unavailable: number;
  };
  current_project_registry_id: string | null;
}

export interface ViewerProjectDeleteData {
  registry_path: string;
  project: RegisteredProjectSummary;
  removed: RegisteredProjectSummary | null;
  destroyed: true;
  entries_removed: string[];
}

export interface ResetMemoryData {
  destroyed: boolean;
  backup_path: string | null;
  entries_removed: string[];
}

export interface ResetAllMemoryProjectReset extends RegisteredProjectSummary {
  destroyed: boolean;
  backup_path: string | null;
  entries_removed: string[];
}

export interface ResetAllMemoryProjectSkipped extends RegisteredProjectSummary {
  reason: string;
}

export interface ResetAllMemoryProjectFailed extends RegisteredProjectSummary {
  error: MemoryError;
  warnings: string[];
}

export interface ResetAllMemoryData {
  registry_path: string;
  destroyed: boolean;
  projects_reset: ResetAllMemoryProjectReset[];
  projects_skipped: ResetAllMemoryProjectSkipped[];
  projects_failed: ResetAllMemoryProjectFailed[];
}

export type AppResult<T> =
  | {
      ok: true;
      data: T;
      warnings: string[];
      meta: MemoryMeta;
    }
  | {
      ok: false;
      error: MemoryError;
      warnings: string[];
      meta: MemoryMeta;
    };

export async function initProject(
  options: InitProjectOptions
): Promise<AppResult<InitProjectData>> {
  const clock = options.clock ?? systemClock;
  const brief = buildIndexingBrief();
  const storageOptions = {
    cwd: options.cwd,
    clock,
    agentGuidance: options.agentGuidance ?? true,
    force: options.force ?? false,
    allowTrackedMemoryDeletions: options.allowTrackedMemoryDeletions ?? false,
    runner: options.runner
  };

  if (options.dryRun === true) {
    const planned = await planInitializeStorage(storageOptions);

    if (!planned.ok) {
      return {
        ok: false,
        error: planned.error,
        warnings: planned.warnings,
        meta: await buildBestEffortMeta(options)
      };
    }

    const meta = await buildMeta(planned.data.paths, options);

    if (!meta.ok) {
      return meta;
    }

    return {
      ok: true,
      data: {
        ...planned.data.data,
        dry_run: true,
        brief
      },
      warnings: planned.warnings,
      meta: meta.meta
    };
  }

  const initialized = await initializeStorage(storageOptions);

  if (initialized.ok) {
    const meta = await buildMeta(initialized.data.paths, options);

    if (!meta.ok) {
      return meta;
    }

    const rebuilt = await rebuildIndexForResolvedProject({
      paths: initialized.data.paths,
      meta: meta.meta,
      clock,
      runner: options.runner
    });
    const initWarnings = initialized.warnings.filter(
      (warning) => warning !== INITIAL_INDEX_UNAVAILABLE_WARNING
    );

    if (rebuilt.ok) {
      return {
        ok: true,
        data: {
          ...initialized.data.data,
          index_built: true,
          dry_run: false,
          brief
        },
        warnings: [...initWarnings, ...rebuilt.warnings],
        meta: meta.meta
      };
    }

    return {
      ok: true,
      data: {
        ...initialized.data.data,
        index_built: false,
        dry_run: false,
        brief
      },
      warnings: [
        ...initWarnings,
        ...rebuilt.warnings,
        `Initial index rebuild failed: ${rebuilt.error.message}`
      ],
      meta: meta.meta
    };
  }

  const meta = await buildBestEffortMeta(options);

  return {
    ok: false,
    error: initialized.error,
    warnings: initialized.warnings,
    meta
  };
}

export async function getProjectStatus(
  options: GetProjectStatusOptions
): Promise<AppResult<StatusData>> {
  const paths = await resolveProjectPaths({
    cwd: options.cwd,
    mode: "require-initialized",
    runner: options.runner
  });

  if (!paths.ok) {
    return {
      ok: false,
      error: paths.error,
      warnings: paths.warnings,
      meta: await buildBestEffortMeta(options)
    };
  }

  const meta = await buildMeta(paths.data, options);

  if (!meta.ok) {
    return meta;
  }

  const versionGate = await checkStorageVersion(paths.data.projectRoot);

  if (!versionGate.ok) {
    return {
      ok: false,
      error: versionGate.error,
      warnings: versionGate.warnings,
      meta: meta.meta
    };
  }

  const storage = await readCanonicalStorage(paths.data.projectRoot);

  if (!storage.ok) {
    return {
      ok: false,
      error: storage.error,
      warnings: storage.warnings,
      meta: meta.meta
    };
  }

  const computed = await computeProjectStatus(paths.data.projectRoot, storage.data, options);

  return {
    ok: true,
    data: computed.data,
    warnings: [...storage.warnings, ...computed.warnings],
    meta: meta.meta
  };
}

export async function getAllProjectsStatus(
  options: ProjectRegistryOperationOptions
): Promise<AppResult<AllProjectsStatusData>> {
  const registry = await readProjectRegistry(options);
  const meta = await buildBestEffortMeta(options);
  const registryPath = resolveProjectRegistryLocation(options).registryPath;

  if (!registry.ok) {
    return {
      ok: false,
      error: registry.error,
      warnings: registry.warnings,
      meta
    };
  }

  const rows: ProjectStatusRow[] = [];

  for (const entry of registry.data.registry.projects) {
    rows.push(await projectStatusRow(entry, options));
  }

  rows.sort(compareProjectStatusRows);

  return {
    ok: true,
    data: {
      registry_path: registryPath,
      projects: rows
    },
    warnings: registry.warnings,
    meta
  };
}

/**
 * Builds one read-only status row for a registered project. A project whose
 * storage is version-gated or unreadable is reported as needing
 * `memory reset && memory init` instead of failing the whole listing.
 */
async function projectStatusRow(
  entry: ProjectRegistryEntry,
  options: GitWrapperOptions
): Promise<ProjectStatusRow> {
  const base = {
    registry_id: entry.registry_id,
    project: {
      id: entry.project.id,
      name: entry.project.name
    },
    project_root: resolve(entry.project_root)
  };

  try {
    const versionGate = await checkStorageVersion(base.project_root);

    if (!versionGate.ok) {
      return needsResetStatusRow(base, storageVersionFromError(versionGate.error));
    }

    const storage = await readCanonicalStorage(base.project_root);

    if (!storage.ok) {
      return needsResetStatusRow(base, null);
    }

    const computed = await computeProjectStatus(base.project_root, storage.data, options);

    return {
      ...base,
      project: {
        id: storage.data.config.project.id,
        name: storage.data.config.project.name
      },
      needs_reset: false,
      storage_version: CURRENT_STORAGE_VERSION,
      features_by_stage: computed.data.features_by_stage,
      open_questions: computed.data.open_questions,
      stale: computed.data.stale,
      last_activity: computed.data.last_activity,
      last_sync: computed.data.last_sync
    };
  } catch {
    return needsResetStatusRow(base, null);
  }
}

function needsResetStatusRow(
  base: Pick<ProjectStatusRow, "registry_id" | "project" | "project_root">,
  storageVersion: number | string | null
): ProjectStatusRow {
  return {
    ...base,
    needs_reset: true,
    storage_version: storageVersion,
    features_by_stage: null,
    open_questions: null,
    stale: null,
    last_activity: null,
    last_sync: null
  };
}

function storageVersionFromError(error: MemoryError): number | string | null {
  const details = error.details;

  if (isRecord(details)) {
    const found = details.found_version;

    if (typeof found === "number" || typeof found === "string") {
      return found;
    }
  }

  return null;
}

function compareProjectStatusRows(left: ProjectStatusRow, right: ProjectStatusRow): number {
  if (left.last_activity !== right.last_activity) {
    if (left.last_activity === null) {
      return 1;
    }

    if (right.last_activity === null) {
      return -1;
    }

    return left.last_activity < right.last_activity ? 1 : -1;
  }

  return left.project.name.localeCompare(right.project.name) ||
    left.project_root.localeCompare(right.project_root);
}

/**
 * Computes the status aggregates from a canonical storage snapshot.
 * Features count toward stages only while their lifecycle status is
 * `active`; the `dead` stage still appears in the counts so abandoned work
 * stays visible. Stale findings cover live objects whose anchors match no
 * tracked or added file, and are skipped silently outside Git.
 */
async function computeProjectStatus(
  projectRoot: string,
  storage: CanonicalStorageSnapshot,
  options: GitWrapperOptions
): Promise<{ data: StatusData; warnings: string[] }> {
  const warnings: string[] = [];
  const featuresByStage = emptyFeaturesByStage();

  for (const object of storage.objects) {
    if (object.sidecar.type !== "feature" || object.sidecar.status !== "active") {
      continue;
    }

    const summary = featuresByStage[object.sidecar.stage ?? "idea"];

    summary.count += 1;
    summary.titles.push(object.sidecar.title);
  }

  for (const stage of FEATURE_STAGES) {
    featuresByStage[stage].titles.sort((left, right) => left.localeCompare(right));
  }

  const openQuestions = storage.objects
    .filter((object) => object.sidecar.type === "question" && object.sidecar.status === "open")
    .map((object) => ({ id: object.sidecar.id, title: object.sidecar.title }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const liveObjects = storage.objects.filter(
    (object) => object.sidecar.status === "active" || object.sidecar.status === "open"
  );
  let stale: StatusStaleAnchors[] = [];
  const trackedFiles = await listTrackedFiles(projectRoot, options);

  if (!trackedFiles.ok) {
    warnings.push(`Stale anchor check skipped: ${trackedFiles.error.message}`);
  } else if (trackedFiles.data !== null) {
    const titleById = new Map(
      liveObjects.map((object) => [object.sidecar.id, object.sidecar.title])
    );

    stale = verifyAnchors(liveObjects, trackedFiles.data)
      .filter((finding) => finding.orphaned_anchors.length > 0)
      .map((finding) => ({
        id: finding.id,
        title: titleById.get(finding.id) ?? finding.id,
        orphaned_anchors: [...finding.orphaned_anchors]
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  const lastActivity = storage.objects.reduce<IsoDateTime | null>(
    (latest, object) =>
      latest === null || object.sidecar.updated_at > latest
        ? object.sidecar.updated_at
        : latest,
    null
  );

  return {
    data: {
      project: {
        id: storage.config.project.id,
        name: storage.config.project.name
      },
      features_by_stage: featuresByStage,
      open_questions: openQuestions,
      stale,
      last_activity: lastActivity,
      last_sync: await readSyncState(projectRoot)
    },
    warnings
  };
}

function emptyFeaturesByStage(): Record<FeatureStage, StatusFeatureStageSummary> {
  const summaries = {} as Record<FeatureStage, StatusFeatureStageSummary>;

  for (const stage of FEATURE_STAGES) {
    summaries[stage] = { count: 0, titles: [] };
  }

  return summaries;
}

/**
 * Reads `.memory/sync-state.json` defensively: the file ships with the sync
 * verb, so a missing or malformed file simply means "never synced".
 */
async function readSyncState(projectRoot: string): Promise<StatusSyncState | null> {
  const contents = await readUtf8FileInsideRoot(projectRoot, ".memory/sync-state.json");

  if (!contents.ok) {
    return null;
  }

  const parsed = parseJsonObject(contents.data);

  if (parsed === null) {
    return null;
  }

  return {
    last_sync_commit:
      typeof parsed.last_sync_commit === "string" ? parsed.last_sync_commit : null,
    last_sync_at: typeof parsed.last_sync_at === "string" ? parsed.last_sync_at : null
  };
}

export async function rebuildIndex(
  options: RebuildIndexOptions
): Promise<AppResult<RebuildIndexData>> {
  const clock = options.clock ?? systemClock;
  const paths = await resolveProjectPaths({
    cwd: options.cwd,
    mode: "require-initialized",
    runner: options.runner
  });

  if (!paths.ok) {
    return {
      ok: false,
      error: paths.error,
      warnings: paths.warnings,
      meta: await buildBestEffortMeta(options)
    };
  }

  const meta = await buildMeta(paths.data, options);

  if (!meta.ok) {
    return meta;
  }

  const versionGate = await checkStorageVersion(paths.data.projectRoot);

  if (!versionGate.ok) {
    return {
      ok: false,
      error: versionGate.error,
      warnings: versionGate.warnings,
      meta: meta.meta
    };
  }

  const rebuilt = await rebuildIndexForResolvedProject({
    paths: paths.data,
    meta: meta.meta,
    clock,
    runner: options.runner
  });

  if (!rebuilt.ok) {
    return {
      ok: false,
      error: rebuilt.error,
      warnings: rebuilt.warnings,
      meta: meta.meta
    };
  }

  return {
    ok: true,
    data: rebuilt.data,
    warnings: rebuilt.warnings,
    meta: meta.meta
  };
}

export async function checkProject(
  options: CheckProjectOptions
): Promise<AppResult<CheckProjectData>> {
  const paths = await resolveProjectPaths({
    cwd: options.cwd,
    mode: "require-initialized",
    runner: options.runner
  });

  if (!paths.ok) {
    return {
      ok: false,
      error: paths.error,
      warnings: paths.warnings,
      meta: await buildBestEffortMeta(options)
    };
  }

  const meta = await buildMeta(paths.data, options);

  if (!meta.ok) {
    return meta;
  }

  const versionGate = await checkStorageVersion(paths.data.projectRoot);

  if (!versionGate.ok) {
    return {
      ok: false,
      error: versionGate.error,
      warnings: versionGate.warnings,
      meta: meta.meta
    };
  }

  const validation = await validateProject(paths.data.projectRoot, {
    git: {
      available: meta.meta.git.available,
      branch: meta.meta.git.branch
    }
  });
  const gitConflictIssues = await unresolvedGitConflictIssues(
    paths.data,
    meta.meta,
    options
  );

  if (!gitConflictIssues.ok) {
    return {
      ok: false,
      error: gitConflictIssues.error,
      warnings: gitConflictIssues.warnings,
      meta: meta.meta
    };
  }

  const errors = [...validation.errors, ...gitConflictIssues.data];
  const warnings =
    errors.length === 0
      ? [
          ...validation.warnings,
          ...(await generatedIndexWarnings(paths.data)),
          ...(await productGraphCheckWarnings(paths.data, options))
        ]
      : validation.warnings;

  return {
    ok: true,
    data: {
      valid: errors.length === 0,
      errors,
      warnings
    },
    warnings: [],
    meta: meta.meta
  };
}

export async function queryMemory(
  options: QueryMemoryOptions
): Promise<AppResult<QueryMemoryData>> {
  const clock = options.clock ?? systemClock;
  const paths = await resolveProjectPaths({
    cwd: options.cwd,
    mode: "require-initialized",
    runner: options.runner
  });

  if (!paths.ok) {
    return {
      ok: false,
      error: paths.error,
      warnings: paths.warnings,
      meta: await buildBestEffortMeta(options)
    };
  }

  const meta = await buildMeta(paths.data, options);

  if (!meta.ok) {
    return meta;
  }

  const versionGate = await checkStorageVersion(paths.data.projectRoot);

  if (!versionGate.ok) {
    return {
      ok: false,
      error: versionGate.error,
      warnings: versionGate.warnings,
      meta: meta.meta
    };
  }

  const storage = await readCanonicalStorage(paths.data.projectRoot);

  if (!storage.ok) {
    return {
      ok: false,
      error: storage.error,
      warnings: storage.warnings,
      meta: meta.meta
    };
  }

  const budget = normalizeTokenBudget({
    requestedBudget: options.tokenBudget ?? storage.data.config.memory.defaultTokenBudget
  });

  if (!budget.ok) {
    return {
      ok: false,
      error: budget.error,
      warnings: [...storage.warnings, ...budget.warnings],
      meta: meta.meta
    };
  }

  const searched = await querySearchIndexWithAutoRebuild({
    paths: paths.data,
    meta: meta.meta,
    question: options.question,
    autoIndex: storage.data.config.memory.autoIndex,
    clock,
    runner: options.runner
  });

  if (!searched.ok) {
    return {
      ok: false,
      error: searched.error,
      warnings: [...storage.warnings, ...searched.warnings],
      meta: meta.meta
    };
  }

  const subgraph = selectQuerySubgraph({
    objects: storage.data.objects,
    relations: storage.data.relations,
    matches: searched.data.matches
  });
  const rendered = renderQueryResult({
    question: options.question,
    subgraph,
    tokenBudget: budget.data.tokenTarget ?? storage.data.config.memory.defaultTokenBudget
  });

  return {
    ok: true,
    data: rendered,
    warnings: [...storage.warnings, ...searched.warnings],
    meta: meta.meta
  };
}

async function querySearchIndexWithAutoRebuild(options: {
  paths: ProjectPaths;
  meta: MemoryMeta;
  question: string;
  autoIndex: boolean;
  clock: Clock;
  runner?: GitWrapperOptions["runner"];
}): Promise<Result<SearchMemoryData>> {
  const searchOptions = {
    memoryRoot: options.paths.memoryRoot,
    query: options.question,
    limit: QUERY_SEED_LIMIT
  };
  const searched = await searchIndex(searchOptions);

  if (searched.ok || searched.error.code !== "MemoryIndexUnavailable" || !options.autoIndex) {
    return searched;
  }

  const rebuilt = await rebuildIndexForResolvedProject({
    paths: options.paths,
    meta: options.meta,
    clock: options.clock,
    runner: options.runner
  });

  if (!rebuilt.ok) {
    return err(rebuilt.error, [...searched.warnings, ...rebuilt.warnings]);
  }

  const retried = await searchIndex(searchOptions);

  if (!retried.ok) {
    return err(retried.error, [
      ...searched.warnings,
      ...rebuilt.warnings,
      ...retried.warnings
    ]);
  }

  return ok(retried.data, [...rebuilt.warnings, ...retried.warnings]);
}

export async function inspectMemory(
  options: InspectMemoryOptions
): Promise<AppResult<InspectMemoryData>> {
  const prepared = await readOnlyCanonicalStorage(options);

  if (!prepared.ok) {
    return prepared;
  }

  const object = findStoredObject(prepared.storage.objects, options.id);

  if (object === undefined) {
    return {
      ok: false,
      error: objectNotFound(options.id),
      warnings: prepared.storageWarnings,
      meta: prepared.meta
    };
  }

  return {
    ok: true,
    data: {
      object: summarizeObject(object),
      relations: {
        outgoing: summarizeRelations(outgoingRelations(prepared.storage.relations, options.id)),
        incoming: summarizeRelations(incomingRelations(prepared.storage.relations, options.id))
      }
    },
    warnings: prepared.storageWarnings,
    meta: prepared.meta
  };
}

export async function getViewerBootstrap(
  options: GetViewerBootstrapOptions
): Promise<AppResult<ViewerBootstrapData>> {
  const prepared = await readOnlyCanonicalStorage(options);

  if (!prepared.ok) {
    return prepared;
  }

  const objects = [...prepared.storage.objects].sort(compareStoredObjectsById);
  const relations = [...prepared.storage.relations].sort(compareStoredRelationsById);

  return {
    ok: true,
    data: {
      project: {
        id: prepared.storage.config.project.id,
        name: prepared.storage.config.project.name
      },
      objects: objects.map(summarizeObject),
      relations: summarizeRelations(relations),
      counts: {
        objects: objects.length,
        relations: relations.length,
        stale_objects: countObjectsByStatus(objects, "stale"),
        superseded_objects: countObjectsByStatus(objects, "superseded"),
        active_relations: relations.filter(
          (relation) => relation.relation.status === "active"
        ).length
      },
      storage_warnings: prepared.storageWarnings
    },
    warnings: prepared.storageWarnings,
    meta: prepared.meta
  };
}

export async function listRegisteredProjects(
  options: ProjectRegistryOperationOptions
): Promise<AppResult<ProjectRegistryListData>> {
  const registry = await readProjectRegistry(options);
  const meta = await buildBestEffortMeta(options);

  if (!registry.ok) {
    return {
      ok: false,
      error: registry.error,
      warnings: registry.warnings,
      meta
    };
  }

  return {
    ok: true,
    data: {
      registry_path: registry.data.location.registryPath,
      projects: registry.data.registry.projects.map(summarizeRegisteredProject)
    },
    warnings: registry.warnings,
    meta
  };
}

export async function addRegisteredProject(
  options: AddRegisteredProjectOptions
): Promise<AppResult<ProjectRegistryAddData>> {
  const cwd = options.path === undefined ? options.cwd : resolve(options.cwd, options.path);
  const registered = await upsertCurrentProjectInRegistry({
    ...options,
    cwd,
    source: "manual"
  });
  const meta = await buildBestEffortMeta({ ...options, cwd });
  const registryPath = resolveProjectRegistryLocation(options).registryPath;

  if (!registered.ok) {
    return {
      ok: false,
      error: registered.error,
      warnings: registered.warnings,
      meta
    };
  }

  return {
    ok: true,
    data: {
      registry_path: registryPath,
      project: summarizeRegisteredProject(registered.data)
    },
    warnings: registered.warnings,
    meta
  };
}

export async function removeRegisteredProject(
  options: RemoveRegisteredProjectOptions
): Promise<AppResult<ProjectRegistryRemoveData>> {
  const removed = await removeProjectFromRegistry(options);
  const meta = await buildBestEffortMeta(options);
  const registryPath = resolveProjectRegistryLocation(options).registryPath;

  if (!removed.ok) {
    return {
      ok: false,
      error: removed.error,
      warnings: removed.warnings,
      meta
    };
  }

  return {
    ok: true,
    data: {
      registry_path: registryPath,
      removed: summarizeRegisteredProject(removed.data)
    },
    warnings: removed.warnings,
    meta
  };
}

export async function pruneRegisteredProjects(
  options: ProjectRegistryOperationOptions
): Promise<AppResult<ProjectRegistryPruneData>> {
  const pruned = await pruneProjectRegistry(options);
  const meta = await buildBestEffortMeta(options);
  const registryPath = resolveProjectRegistryLocation(options).registryPath;

  if (!pruned.ok) {
    return {
      ok: false,
      error: pruned.error,
      warnings: pruned.warnings,
      meta
    };
  }

  return {
    ok: true,
    data: {
      registry_path: registryPath,
      projects: pruned.data.projects.map(summarizeRegisteredProject),
      removed: pruned.data.removed.map(summarizeRegisteredProject)
    },
    warnings: pruned.warnings,
    meta
  };
}

export async function registerCurrentProject(
  options: ProjectRegistryOperationOptions & { source?: ProjectRegistrySource }
): Promise<AppResult<ProjectRegistryAddData>> {
  const registered = await upsertCurrentProjectInRegistry({
    ...options,
    source: options.source ?? "auto"
  });
  const meta = await buildBestEffortMeta(options);
  const registryPath = resolveProjectRegistryLocation(options).registryPath;

  if (!registered.ok) {
    return {
      ok: false,
      error: registered.error,
      warnings: registered.warnings,
      meta
    };
  }

  return {
    ok: true,
    data: {
      registry_path: registryPath,
      project: summarizeRegisteredProject(registered.data)
    },
    warnings: registered.warnings,
    meta
  };
}

export async function unregisterProjectRoot(
  options: ProjectRegistryOperationOptions & { projectRoot: string }
): Promise<AppResult<ProjectRegistryRemoveData | { registry_path: string; removed: null }>> {
  const removed = await removeProjectRootFromRegistry(options);
  const meta = await buildBestEffortMeta(options);
  const registryPath = resolveProjectRegistryLocation(options).registryPath;

  if (!removed.ok) {
    return {
      ok: false,
      error: removed.error,
      warnings: removed.warnings,
      meta
    };
  }

  return {
    ok: true,
    data: removed.data === null
      ? { registry_path: registryPath, removed: null }
      : { registry_path: registryPath, removed: summarizeRegisteredProject(removed.data) },
    warnings: removed.warnings,
    meta
  };
}

export async function getViewerProjects(
  options: GetViewerProjectsOptions
): Promise<AppResult<ViewerProjectsData>> {
  const registry = await readProjectRegistry(options);
  const meta = await buildBestEffortMeta(options);

  if (!registry.ok) {
    return {
      ok: false,
      error: registry.error,
      warnings: registry.warnings,
      meta
    };
  }

  const current = await currentProjectRegistryEntry(options);
  const currentWarnings = current.ok ? current.warnings : [];
  const entries = mergeRegistryEntries(
    registry.data.registry.projects,
    current.ok ? current.data : null,
    options.clock ?? systemClock
  );
  const projects: ViewerProjectSummary[] = [];

  for (const entry of entries) {
    projects.push(await summarizeViewerProject(entry, current.ok ? current.data : null, options));
  }

  const sortedProjects = projects.sort(compareViewerProjects);
  const available = sortedProjects.filter((project) => project.available).length;

  return {
    ok: true,
    data: {
      registry_path: registry.data.location.registryPath,
      projects: sortedProjects,
      counts: {
        projects: sortedProjects.length,
        available,
        unavailable: sortedProjects.length - available
      },
      current_project_registry_id: current.ok ? current.data?.registry_id ?? null : null
    },
    warnings: [...registry.warnings, ...currentWarnings],
    meta
  };
}

export async function getViewerProjectBootstrap(
  options: GetViewerProjectBootstrapOptions
): Promise<AppResult<ViewerBootstrapData>> {
  const resolved = await resolveViewerProjectCwd(options);

  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.error,
      warnings: resolved.warnings,
      meta: await buildBestEffortMeta(options)
    };
  }

  return getViewerBootstrap({
    cwd: resolved.data.project_root,
    runner: options.runner
  });
}

export async function deleteViewerProject(
  options: DeleteViewerProjectOptions
): Promise<AppResult<ViewerProjectDeleteData>> {
  const resolved = await resolveViewerProjectCwd(options);
  const registryPath = resolveProjectRegistryLocation(options).registryPath;

  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.error,
      warnings: resolved.warnings,
      meta: await buildBestEffortMeta(options)
    };
  }

  const project = registeredProjectWithDerivedMemoryRoot(resolved.data);
  const summary = summarizeRegisteredProject(project);
  const meta = await buildBestEffortMeta({
    ...options,
    cwd: project.project_root
  });
  const missing = await isMemoryRootMissing(project.memory_root);

  if (!missing.ok) {
    return {
      ok: false,
      error: missing.error,
      warnings: [...resolved.warnings, ...missing.warnings],
      meta
    };
  }

  const warnings = [...resolved.warnings, ...missing.warnings];
  const entriesRemoved: string[] = [];

  if (!missing.data) {
    const deleted = await removeMemoryRoot(project.memory_root);

    if (!deleted.ok) {
      return {
        ok: false,
        error: deleted.error,
        warnings: [...warnings, ...deleted.warnings],
        meta
      };
    }

    warnings.push(...deleted.warnings);
    entriesRemoved.push(".memory");
  }

  const unregistered = await removeProjectRootFromRegistry({
    ...options,
    projectRoot: project.project_root
  });

  if (!unregistered.ok) {
    return {
      ok: false,
      error: unregistered.error,
      warnings: [...warnings, ...unregistered.warnings],
      meta
    };
  }

  warnings.push(...unregistered.warnings);

  return {
    ok: true,
    data: {
      registry_path: registryPath,
      project: summary,
      removed: unregistered.data === null ? null : summarizeRegisteredProject(unregistered.data),
      destroyed: true,
      entries_removed: entriesRemoved
    },
    warnings,
    meta
  };
}

export async function diffMemory(
  options: DiffMemoryOptions
): Promise<AppResult<DiffMemoryData>> {
  const paths = await resolveProjectPaths({
    cwd: options.cwd,
    mode: "require-initialized",
    runner: options.runner
  });

  if (!paths.ok) {
    return {
      ok: false,
      error: paths.error,
      warnings: paths.warnings,
      meta: await buildBestEffortMeta(options)
    };
  }

  const meta = await buildMeta(paths.data, options);

  if (!meta.ok) {
    return meta;
  }

  if (!meta.meta.git.available) {
    return {
      ok: false,
      error: memoryError("MemoryGitRequired", "Git is required for this operation."),
      warnings: [],
      meta: meta.meta
    };
  }

  const diff = await getMemoryDiff(paths.data.projectRoot, options);

  if (!diff.ok) {
    return {
      ok: false,
      error: diff.error,
      warnings: diff.warnings,
      meta: meta.meta
    };
  }

  const changedIds = await detectChangedIds(
    paths.data.projectRoot,
    diff.data.changedFiles,
    options
  );

  return {
    ok: true,
    data: {
      diff: diff.data.diff,
      changed_files: diff.data.changedFiles,
      untracked_files: diff.data.untrackedFiles,
      changed_memory_ids: changedIds.memoryIds,
      changed_relation_ids: changedIds.relationIds
    },
    warnings: diff.warnings,
    meta: meta.meta
  };
}

export type {
  SyncChangedNode,
  SyncCoverageGap,
  SyncOrphanedNode,
  SyncSaveSkeleton
} from "../sync/engine.js";

/**
 * Runs the mechanical, diff-driven staleness pass. Sync never writes graph
 * objects: it classifies live nodes against the changes since the last sync
 * marker (full verification when no usable marker exists), reports coverage
 * gaps, advances the commit-based marker to HEAD, and refreshes the product
 * map. Working-tree changes are intentionally re-reported on the next sync
 * because the marker only tracks commits. Dry runs report without advancing
 * the marker or touching the map.
 */
export async function syncMemory(
  options: SyncMemoryOptions
): Promise<AppResult<SyncMemoryData>> {
  const clock = options.clock ?? systemClock;
  const paths = await resolveProjectPaths({
    cwd: options.cwd,
    mode: "require-initialized",
    runner: options.runner
  });

  if (!paths.ok) {
    return {
      ok: false,
      error: paths.error,
      warnings: paths.warnings,
      meta: await buildBestEffortMeta(options)
    };
  }

  const meta = await buildMeta(paths.data, options);

  if (!meta.ok) {
    return meta;
  }

  if (!meta.meta.git.available || meta.meta.git.commit === null) {
    return {
      ok: false,
      error: memoryError("MemoryGitRequired", "Git is required for this operation."),
      warnings: [],
      meta: meta.meta
    };
  }

  const headCommit = meta.meta.git.commit;
  const versionGate = await checkStorageVersion(paths.data.projectRoot);

  if (!versionGate.ok) {
    return {
      ok: false,
      error: versionGate.error,
      warnings: versionGate.warnings,
      meta: meta.meta
    };
  }

  const storage = await readCanonicalStorage(paths.data.projectRoot);

  if (!storage.ok) {
    return {
      ok: false,
      error: storage.error,
      warnings: storage.warnings,
      meta: meta.meta
    };
  }

  const warnings = [...storage.warnings];
  const markerCommit = await readSyncMarker(paths.data.projectRoot);
  const baseline = await resolveSyncBaseline({
    projectRoot: paths.data.projectRoot,
    markerCommit,
    ...(options.runner === undefined ? {} : { runner: options.runner })
  });

  if (!baseline.ok) {
    return {
      ok: false,
      error: baseline.error,
      warnings: [...warnings, ...baseline.warnings],
      meta: meta.meta
    };
  }

  const trackedFiles = await listTrackedFiles(paths.data.projectRoot, options);

  if (!trackedFiles.ok) {
    return {
      ok: false,
      error: trackedFiles.error,
      warnings: [...warnings, ...trackedFiles.warnings],
      meta: meta.meta
    };
  }

  const verdicts = computeSyncVerdicts({
    objects: storage.data.objects,
    currentFiles: trackedFiles.data ?? [],
    changedFiles: baseline.data.changedFiles,
    deletedFiles: baseline.data.deletedFiles
  });
  let markerAdvanced = false;

  if (options.dryRun !== true) {
    const marker = await writeSyncMarker(paths.data.projectRoot, headCommit, clock);

    if (!marker.ok) {
      return {
        ok: false,
        error: marker.error,
        warnings: [...warnings, ...marker.warnings],
        meta: meta.meta
      };
    }

    markerAdvanced = true;
    warnings.push(...(await refreshProductMapAfterWrite(paths.data, options)));
  }

  return {
    ok: true,
    data: {
      base_commit: baseline.data.baseCommit,
      head_commit: headCommit,
      full_verification: baseline.data.fullVerification,
      changed_files_count: baseline.data.changedFiles.length,
      fresh: verdicts.fresh,
      changed: verdicts.changed,
      orphaned: verdicts.orphaned,
      unanchored: verdicts.unanchored,
      coverage_gaps: verdicts.coverage_gaps,
      save_skeleton: buildSyncSaveSkeleton(verdicts.changed, verdicts.orphaned),
      marker_advanced: markerAdvanced,
      titles: verdicts.titles
    },
    warnings,
    meta: meta.meta
  };
}

export async function resetMemory(options: ResetMemoryOptions): Promise<AppResult<ResetMemoryData>> {
  const paths = await resolveProjectPaths({
    cwd: options.cwd,
    mode: "init",
    runner: options.runner
  });

  if (!paths.ok) {
    return {
      ok: false,
      error: paths.error,
      warnings: paths.warnings,
      meta: await buildBestEffortMeta(options)
    };
  }

  const meta = await buildMeta(paths.data, options);

  if (!meta.ok) {
    return meta;
  }

  if (options.destroy === true) {
    const destroyed = await removeMemoryRoot(paths.data.memoryRoot);

    if (!destroyed.ok) {
      return appError(destroyed.error, destroyed.warnings, meta.meta);
    }

    return {
      ok: true,
      data: {
        destroyed: true,
        backup_path: null,
        entries_removed: [".memory"]
      },
      warnings: destroyed.warnings,
      meta: meta.meta
    };
  }

  const reset = await backupAndClearMemoryRoot(paths.data.projectRoot, paths.data.memoryRoot, options);

  if (!reset.ok) {
    return appError(reset.error, reset.warnings, meta.meta);
  }

  return {
    ok: true,
    data: {
      destroyed: false,
      backup_path: reset.data.backupPath,
      entries_removed: reset.data.entriesRemoved
    },
    warnings: reset.warnings,
    meta: meta.meta
  };
}

export async function resetAllMemory(
  options: ResetMemoryOptions
): Promise<AppResult<ResetAllMemoryData>> {
  const registry = await readProjectRegistry(options);
  const meta = await buildBestEffortMeta(options);
  const registryPath = resolveProjectRegistryLocation(options).registryPath;

  if (!registry.ok) {
    return {
      ok: false,
      error: registry.error,
      warnings: registry.warnings,
      meta
    };
  }

  const warnings = [...registry.warnings];
  const projectsReset: ResetAllMemoryProjectReset[] = [];
  const projectsSkipped: ResetAllMemoryProjectSkipped[] = [];
  const projectsFailed: ResetAllMemoryProjectFailed[] = [];
  const projectRootsToUnregister: string[] = [];

  for (const entry of registry.data.registry.projects) {
    const project = registeredProjectWithDerivedMemoryRoot(entry);
    const summary = summarizeRegisteredProject(project);
    const missing = await isMemoryRootMissing(project.memory_root);

    if (!missing.ok) {
      projectsFailed.push({
        ...summary,
        error: missing.error,
        warnings: missing.warnings
      });
      warnings.push(...missing.warnings);
      continue;
    }

    if (missing.data) {
      projectsSkipped.push({
        ...summary,
        reason: ".memory directory does not exist."
      });
      projectRootsToUnregister.push(project.project_root);
      continue;
    }

    if (options.destroy === true) {
      const reset = await removeMemoryRoot(project.memory_root);

      if (!reset.ok) {
        projectsFailed.push({
          ...summary,
          error: reset.error,
          warnings: reset.warnings
        });
        warnings.push(...reset.warnings);
        continue;
      }

      warnings.push(...reset.warnings);
      projectRootsToUnregister.push(project.project_root);

      projectsReset.push({
        ...summary,
        destroyed: true,
        backup_path: null,
        entries_removed: [".memory"]
      });
      continue;
    }

    const reset = await backupAndClearMemoryRoot(project.project_root, project.memory_root, options);

    if (!reset.ok) {
      projectsFailed.push({
        ...summary,
        error: reset.error,
        warnings: reset.warnings
      });
      warnings.push(...reset.warnings);
      continue;
    }

    warnings.push(...reset.warnings);
    projectRootsToUnregister.push(project.project_root);

    projectsReset.push({
      ...summary,
      destroyed: false,
      backup_path: reset.data.backupPath,
      entries_removed: reset.data.entriesRemoved
    });
  }

  if (projectRootsToUnregister.length > 0) {
    const unregistered = await removeProjectRootsFromRegistry({
      ...options,
      projectRoots: projectRootsToUnregister
    });

    if (!unregistered.ok) {
      return {
        ok: false,
        error: unregistered.error,
        warnings: [...warnings, ...unregistered.warnings],
        meta
      };
    }

    warnings.push(...unregistered.warnings);
  }

  return {
    ok: true,
    data: {
      registry_path: registryPath,
      destroyed: options.destroy === true,
      projects_reset: projectsReset,
      projects_skipped: projectsSkipped,
      projects_failed: projectsFailed
    },
    warnings,
    meta
  };
}

export async function saveMemoryPatch(
  options: SaveMemoryPatchOptions
): Promise<AppResult<SaveMemoryPatchData>> {
  const clock = options.clock ?? systemClock;

  if (options.patch === undefined) {
    return {
      ok: false,
      error: memoryError("MemoryPatchRequired", "Structured memory patch is required."),
      warnings: [],
      meta: await buildBestEffortMeta(options)
    };
  }

  const paths = await resolveWritableProjectPaths({
    cwd: options.cwd,
    runner: options.runner
  });

  if (!paths.ok) {
    return {
      ok: false,
      error: paths.error,
      warnings: paths.warnings,
      meta: await buildBestEffortMeta(options)
    };
  }

  const meta = await buildMeta(paths.data, options);

  if (!meta.ok) {
    return {
      ok: false,
      error: meta.error,
      warnings: [...paths.warnings, ...meta.warnings],
      meta: meta.meta
    };
  }

  const saved = await withProjectLock(
    {
      memoryRoot: paths.data.memoryRoot,
      operation: "save",
      clock
    },
    async () => {
      const secrets = rejectPatchSecrets(options.patch);

      if (!secrets.ok) {
        return secrets;
      }

      const applied = await applyMemoryPatch({
        projectRoot: paths.data.projectRoot,
        patch: options.patch,
        git: meta.meta.git,
        clock,
        runner: options.runner
      });

      if (!applied.ok) {
        return err(applied.error, [...secrets.warnings, ...applied.warnings]);
      }

      const indexed = await updateIndexAfterCanonicalWrite({
        projectRoot: paths.data.projectRoot,
        memoryRoot: paths.data.memoryRoot,
        clock,
        git: meta.meta.git,
        touched: {
          objectIds: [...applied.data.memory_created, ...applied.data.memory_updated],
          deletedObjectIds: applied.data.memory_deleted,
          relationIds: [
            ...applied.data.relations_created,
            ...applied.data.relations_updated
          ],
          deletedRelationIds: applied.data.relations_deleted,
          appendedEventCount: applied.data.events_appended
        }
      });

      return ok(
        {
          files_changed: applied.data.files_changed,
          recovery_files: applied.data.recovery_files,
          repairs_applied: applied.data.repairs_applied,
          memory_created: applied.data.memory_created,
          memory_updated: applied.data.memory_updated,
          memory_deleted: applied.data.memory_deleted,
          relations_created: applied.data.relations_created,
          relations_updated: applied.data.relations_updated,
          relations_deleted: applied.data.relations_deleted,
          events_appended: applied.data.events_appended,
          index_updated: indexed.ok ? indexed.data.index_updated : false
        },
        [
          ...secrets.warnings,
          ...applied.warnings,
          ...indexed.warnings,
          ...(indexed.ok ? [] : [`Index warning: ${indexed.error.message}`])
        ]
      );
    }
  );

  if (!saved.ok) {
    return {
      ok: false,
      error: saved.error,
      warnings: [...paths.warnings, ...saved.warnings],
      meta: meta.meta
    };
  }

  const refreshedMeta = await buildMeta(paths.data, options);

  if (!refreshedMeta.ok) {
    return {
      ok: true,
      data: saved.data,
      warnings: [
        ...paths.warnings,
        ...saved.warnings,
        ...refreshedMeta.warnings,
        `Git metadata refresh failed after save: ${refreshedMeta.error.message}`
      ],
      meta: refreshedMeta.meta
    };
  }

  return {
    ok: true,
    data: saved.data,
    warnings: [...paths.warnings, ...saved.warnings],
    meta: refreshedMeta.meta
  };
}

export async function saveMemory(
  options: SaveMemoryOptions
): Promise<AppResult<SaveMemoryData>> {
  const clock = options.clock ?? systemClock;

  if (options.input === undefined) {
    return {
      ok: false,
      error: memoryError("MemoryPatchRequired", "Save input is required."),
      warnings: [],
      meta: await buildBestEffortMeta(options)
    };
  }

  const paths = await resolveWritableProjectPaths({
    cwd: options.cwd,
    allowRestore: options.dryRun !== true,
    runner: options.runner
  });

  if (!paths.ok) {
    return {
      ok: false,
      error: paths.error,
      warnings: paths.warnings,
      meta: await buildBestEffortMeta(options)
    };
  }

  const meta = await buildMeta(paths.data, options);

  if (!meta.ok) {
    return {
      ok: false,
      error: meta.error,
      warnings: [...paths.warnings, ...meta.warnings],
      meta: meta.meta
    };
  }

  const storage = await readCanonicalStorage(paths.data.projectRoot);

  if (!storage.ok) {
    return {
      ok: false,
      error: storage.error,
      warnings: [...paths.warnings, ...storage.warnings],
      meta: meta.meta
    };
  }

  const patch = buildSaveMemoryPatch({
    input: options.input,
    storage: storage.data
  });

  if (!patch.ok) {
    return {
      ok: false,
      error: patch.error,
      warnings: [...paths.warnings, ...storage.warnings, ...patch.warnings],
      meta: meta.meta
    };
  }

  if (options.dryRun === true) {
    const secrets = rejectPatchSecrets(patch.data);

    if (!secrets.ok) {
      return {
        ok: false,
        error: secrets.error,
        warnings: [...paths.warnings, ...storage.warnings, ...secrets.warnings],
        meta: meta.meta
      };
    }

    const planned = await planMemoryPatch({
      projectRoot: paths.data.projectRoot,
      patch: patch.data,
      git: meta.meta.git,
      clock,
      runner: options.runner
    });

    if (!planned.ok) {
      return {
        ok: false,
        error: planned.error,
        warnings: [
          ...paths.warnings,
          ...storage.warnings,
          ...secrets.warnings,
          ...planned.warnings
        ],
        meta: meta.meta
      };
    }

    return {
      ok: true,
      data: {
        dry_run: true,
        patch: patch.data,
        files_changed: planned.data.files_changed,
        recovery_files: planned.data.recovery_files,
        repairs_applied: planned.data.repairs_applied,
        memory_created: planned.data.memory_created,
        memory_updated: planned.data.memory_updated,
        memory_deleted: planned.data.memory_deleted,
        relations_created: planned.data.relations_created,
        relations_updated: planned.data.relations_updated,
        relations_deleted: planned.data.relations_deleted,
        events_appended: planned.data.events_appended,
        index_updated: false
      },
      warnings: [
        ...paths.warnings,
        ...storage.warnings,
        ...secrets.warnings,
        ...planned.warnings
      ],
      meta: meta.meta
    };
  }

  const saved = await saveMemoryPatch({
    cwd: paths.data.projectRoot,
    patch: patch.data,
    clock,
    runner: options.runner
  });

  if (!saved.ok) {
    return {
      ok: false,
      error: saved.error,
      warnings: [...paths.warnings, ...storage.warnings, ...saved.warnings],
      meta: saved.meta
    };
  }

  const mapWarnings = await refreshProductMapAfterWrite(paths.data, options);

  return {
    ok: true,
    data: {
      dry_run: false,
      patch: patch.data,
      ...saved.data
    },
    warnings: [...paths.warnings, ...storage.warnings, ...saved.warnings, ...mapWarnings],
    meta: saved.meta
  };
}

/**
 * Refreshes the generated product map sections after a successful write,
 * using fresh post-write storage. Runs outside the project lock and never
 * fails the save: every failure or skipped target degrades to a warning.
 */
async function refreshProductMapAfterWrite(
  paths: ProjectPaths,
  options: GitWrapperOptions
): Promise<string[]> {
  const storage = await readCanonicalStorage(paths.projectRoot);

  if (!storage.ok) {
    return [`Product map was not refreshed: ${storage.error.message}`];
  }

  const refreshed = await refreshProductMap(
    paths.projectRoot,
    storage.data,
    options.runner === undefined ? {} : { runner: options.runner }
  );

  return refreshed.warnings;
}

function summarizeRegisteredProject(entry: ProjectRegistryEntry): RegisteredProjectSummary {
  return {
    registry_id: entry.registry_id,
    project: {
      id: entry.project.id,
      name: entry.project.name
    },
    project_root: entry.project_root,
    memory_root: entry.memory_root,
    source: entry.source,
    registered_at: entry.registered_at,
    last_seen_at: entry.last_seen_at
  };
}

function registeredProjectWithDerivedMemoryRoot(entry: ProjectRegistryEntry): ProjectRegistryEntry {
  const projectRoot = resolve(entry.project_root);

  return {
    ...entry,
    project_root: projectRoot,
    memory_root: join(projectRoot, ".memory")
  };
}

function mergeRegistryEntries(
  registered: readonly ProjectRegistryEntry[],
  current: ResolvedProjectRegistryEntry | null,
  clock: Clock
): ProjectRegistryEntry[] {
  const entries = [...registered];

  if (current === null || entries.some((entry) => entry.registry_id === current.registry_id)) {
    return entries;
  }

  const now = clock.nowIso();

  entries.push({
    ...current,
    source: "auto",
    registered_at: now,
    last_seen_at: now
  });

  return entries;
}

async function summarizeViewerProject(
  entry: ProjectRegistryEntry,
  current: ResolvedProjectRegistryEntry | null,
  options: ProjectRegistryOperationOptions
): Promise<ViewerProjectSummary> {
  const bootstrap = await getViewerBootstrap({
    cwd: entry.project_root,
    runner: options.runner
  });
  const base = summarizeRegisteredProject(entry);

  if (!bootstrap.ok) {
    return {
      ...base,
      current: current?.registry_id === entry.registry_id,
      available: false,
      counts: null,
      git: null,
      warnings: [...bootstrap.warnings, bootstrap.error.message]
    };
  }

  return {
    ...base,
    project: bootstrap.data.project,
    current: current?.registry_id === entry.registry_id,
    available: true,
    counts: bootstrap.data.counts,
    git: bootstrap.meta.git,
    warnings: [...bootstrap.warnings, ...bootstrap.data.storage_warnings]
  };
}

function compareViewerProjects(left: ViewerProjectSummary, right: ViewerProjectSummary): number {
  if (left.current !== right.current) {
    return left.current ? -1 : 1;
  }

  if (left.available !== right.available) {
    return left.available ? -1 : 1;
  }

  return left.project.name.localeCompare(right.project.name) ||
    left.project.id.localeCompare(right.project.id) ||
    left.project_root.localeCompare(right.project_root);
}

async function resolveViewerProjectCwd(
  options: ProjectRegistryOperationOptions & { registryId: string }
): Promise<Result<ProjectRegistryEntry>> {
  const current = await currentProjectRegistryEntry(options);

  if (current.ok && current.data?.registry_id === options.registryId) {
    const now = (options.clock ?? systemClock).nowIso();

    return ok({
      ...current.data,
      source: "auto",
      registered_at: now,
      last_seen_at: now
    });
  }

  const registered = await findRegisteredProject({
    ...options,
    registryId: options.registryId
  });

  if (!registered.ok) {
    return registered;
  }

  if (registered.data === null) {
    return err(
      memoryError("MemoryValidationFailed", "Registered Memory project was not found.", {
        registry_id: options.registryId
      })
    );
  }

  return ok(registered.data, registered.warnings);
}

export const applicationOperations = {
  addRegisteredProject,
  checkProject,
  deleteViewerProject,
  diffMemory,
  getAllProjectsStatus,
  getProjectStatus,
  getViewerProjectBootstrap,
  getViewerBootstrap,
  getViewerProjects,
  initProject,
  inspectMemory,
  listRegisteredProjects,
  pruneRegisteredProjects,
  queryMemory,
  rebuildIndex,
  registerCurrentProject,
  removeRegisteredProject,
  resetAllMemory,
  resetMemory,
  saveMemory,
  syncMemory,
  unregisterProjectRoot
};

type ReadOnlyCanonicalStorageResult =
  | {
      ok: true;
      storage: CanonicalStorageSnapshot;
      storageWarnings: string[];
      meta: MemoryMeta;
    }
  | {
      ok: false;
      error: MemoryError;
      warnings: string[];
      meta: MemoryMeta;
    };

async function readOnlyCanonicalStorage(
  options: GitWrapperOptions & { cwd: string }
): Promise<ReadOnlyCanonicalStorageResult> {
  const paths = await resolveProjectPaths({
    cwd: options.cwd,
    mode: "require-initialized",
    runner: options.runner
  });

  if (!paths.ok) {
    return {
      ok: false,
      error: paths.error,
      warnings: paths.warnings,
      meta: await buildBestEffortMeta(options)
    };
  }

  const meta = await buildMeta(paths.data, options);

  if (!meta.ok) {
    return meta;
  }

  const storage = await readCanonicalStorage(paths.data.projectRoot);

  if (!storage.ok) {
    return {
      ok: false,
      error: storage.error,
      warnings: storage.warnings,
      meta: meta.meta
    };
  }

  return {
    ok: true,
    storage: storage.data,
    storageWarnings: storage.warnings,
    meta: meta.meta
  };
}

function findStoredObject(
  objects: readonly StoredMemoryObject[],
  id: ObjectId
): StoredMemoryObject | undefined {
  return objects.find((object) => object.sidecar.id === id);
}

function outgoingRelations(
  relations: readonly StoredMemoryRelation[],
  id: ObjectId
): StoredMemoryRelation[] {
  return relations
    .filter((relation) => relation.relation.from === id)
    .sort(compareStoredRelationsById);
}

function incomingRelations(
  relations: readonly StoredMemoryRelation[],
  id: ObjectId
): StoredMemoryRelation[] {
  return relations
    .filter((relation) => relation.relation.to === id)
    .sort(compareStoredRelationsById);
}

function summarizeObject(object: StoredMemoryObject): MemoryObjectSummary {
  const sidecar = object.sidecar;

  return {
    id: sidecar.id,
    type: sidecar.type,
    status: sidecar.status,
    title: sidecar.title,
    body_path: object.bodyPath,
    json_path: object.path,
    stage: sidecar.stage ?? null,
    anchors: [...(sidecar.anchors ?? [])],
    tags: [...(sidecar.tags ?? [])],
    evidence: [...(sidecar.evidence ?? [])],
    source: sidecar.source ?? null,
    origin: sidecar.origin ?? null,
    superseded_by: sidecar.superseded_by ?? null,
    created_at: sidecar.created_at,
    updated_at: sidecar.updated_at,
    body: object.body
  };
}

function summarizeRelations(
  relations: readonly StoredMemoryRelation[]
): MemoryRelationSummary[] {
  return relations.map(summarizeRelation);
}

function countObjectsByStatus(
  objects: readonly StoredMemoryObject[],
  status: ObjectStatus
): number {
  return objects.filter((object) => object.sidecar.status === status).length;
}

function summarizeRelation(relation: StoredMemoryRelation): MemoryRelationSummary {
  const data = relation.relation;

  return {
    id: data.id,
    from: data.from,
    predicate: data.predicate,
    to: data.to,
    status: data.status,
    confidence: data.confidence ?? null,
    evidence: [...(data.evidence ?? [])],
    content_hash: data.content_hash ?? null,
    created_at: data.created_at,
    updated_at: data.updated_at,
    json_path: relation.path
  };
}

function compareStoredObjectsById(
  left: StoredMemoryObject,
  right: StoredMemoryObject
): number {
  return left.sidecar.id.localeCompare(right.sidecar.id);
}

function compareStoredRelationsById(
  left: StoredMemoryRelation,
  right: StoredMemoryRelation
): number {
  return left.relation.id.localeCompare(right.relation.id);
}

function objectNotFound(id: ObjectId): MemoryError {
  return memoryError("MemoryObjectNotFound", "Memory object was not found.", {
    id
  });
}

type MetaBuildResult =
  | {
      ok: true;
      meta: MemoryMeta;
    }
  | {
      ok: false;
      error: MemoryError;
      warnings: string[];
      meta: MemoryMeta;
    };

async function buildMeta(
  paths: ProjectPaths,
  options: GitWrapperOptions
): Promise<MetaBuildResult> {
  const git = await getGitState(paths.projectRoot, options);

  if (!git.ok) {
    return {
      ok: false,
      error: git.error,
      warnings: git.warnings,
      meta: fallbackMeta(paths)
    };
  }

  return {
    ok: true,
    meta: {
      project_root: paths.projectRoot,
      memory_root: paths.memoryRoot,
      git: git.data
    }
  };
}

async function buildBestEffortMeta(
  options: GitWrapperOptions & { cwd: string }
): Promise<MemoryMeta> {
  const paths = await resolveProjectPaths({
    cwd: options.cwd,
    mode: "init",
    runner: options.runner
  });

  if (!paths.ok) {
    return {
      project_root: options.cwd,
      memory_root: `${options.cwd}/.memory`,
      git: {
        available: false,
        branch: null,
        commit: null,
        dirty: null
      }
    };
  }

  const meta = await buildMeta(paths.data, options);

  return meta.meta;
}

async function resolveWritableProjectPaths(options: {
  cwd: string;
  allowRestore?: boolean;
  runner?: GitWrapperOptions["runner"];
}): Promise<Result<ProjectPaths>> {
  const paths = await resolveProjectPaths({
    cwd: options.cwd,
    mode: "init",
    runner: options.runner
  });

  if (!paths.ok) {
    return paths;
  }

  const initialized = await memoryConfigExists(paths.data);

  if (!initialized.ok) {
    return err(initialized.error, initialized.warnings);
  }

  if (initialized.data) {
    return ok(paths.data, initialized.warnings);
  }

  const recoverableDeletion = await hasOnlyTrackedMemoryDeletions(paths.data, {
    runner: options.runner
  });

  if (!recoverableDeletion.ok) {
    return recoverableDeletion;
  }

  if (!recoverableDeletion.data || options.allowRestore === false) {
    return err(
      memoryError("MemoryNotInitialized", "Memory is not initialized in this project.", {
        projectRoot: paths.data.projectRoot,
        memoryRoot: paths.data.memoryRoot
      }),
      initialized.warnings
    );
  }

  const restored = await restoreCanonicalStorageFromCommit({
    projectRoot: paths.data.projectRoot,
    commit: "HEAD",
    runner: options.runner
  });

  if (!restored.ok) {
    return err(restored.error, [...initialized.warnings, ...restored.warnings]);
  }

  return ok(
    paths.data,
    [
      ...initialized.warnings,
      ...restored.warnings,
      "Memory storage was restored from HEAD before writing because tracked .memory files were deleted."
    ]
  );
}

async function memoryConfigExists(paths: ProjectPaths): Promise<Result<boolean>> {
  try {
    await lstat(join(paths.memoryRoot, "config.json"));
    return ok(true);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return ok(false);
    }

    return err(
      memoryError("MemoryValidationFailed", "Memory config could not be read.", {
        path: ".memory/config.json",
        message: messageFromUnknown(error)
      })
    );
  }
}

async function hasOnlyTrackedMemoryDeletions(
  paths: ProjectPaths,
  options: GitWrapperOptions
): Promise<Result<boolean>> {
  if (!paths.git.available) {
    return ok(false);
  }

  const dirtyFiles = await getTrackedMemoryDirtyFiles(paths.projectRoot, options);

  if (!dirtyFiles.ok) {
    return dirtyFiles;
  }

  if (dirtyFiles.data.files.length === 0) {
    return ok(false);
  }

  return allFilesMissing(paths.projectRoot, dirtyFiles.data.files);
}

async function allFilesMissing(
  projectRoot: string,
  files: readonly string[]
): Promise<Result<boolean>> {
  for (const file of files) {
    try {
      await lstat(join(projectRoot, file));
      return ok(false);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        continue;
      }

      return err(
        memoryError("MemoryValidationFailed", "Memory dirty file state could not be checked.", {
          path: file,
          message: messageFromUnknown(error)
        })
      );
    }
  }

  return ok(true);
}

async function recentGitFileChangesForIndex(
  projectRoot: string,
  meta: MemoryMeta,
  options: GitWrapperOptions
): Promise<Result<ProjectFileChange[]>> {
  if (!meta.git.available) {
    return ok([]);
  }

  const changes = await getRecentProjectFileChanges(projectRoot, {
    files: ["."],
    limit: 100,
    runner: options.runner
  });

  if (!changes.ok) {
    return ok([], [
      ...changes.warnings,
      `Git file history warning: ${changes.error.message}`
    ]);
  }

  return ok(changes.data.changes, changes.warnings);
}

async function rebuildIndexForResolvedProject(options: {
  paths: ProjectPaths;
  meta: MemoryMeta;
  clock: Clock;
  runner?: GitWrapperOptions["runner"];
}) {
  return withProjectLock(
    {
      memoryRoot: options.paths.memoryRoot,
      operation: "rebuild",
      clock: options.clock
    },
    async () => {
      const gitFileChanges = await recentGitFileChangesForIndex(
        options.paths.projectRoot,
        options.meta,
        options
      );

      const rebuilt = await rebuildGeneratedIndex({
        projectRoot: options.paths.projectRoot,
        memoryRoot: options.paths.memoryRoot,
        clock: options.clock,
        git: options.meta.git,
        gitFileChanges: gitFileChanges.ok ? gitFileChanges.data : []
      });

      return rebuilt.ok
        ? ok(rebuilt.data, [...gitFileChanges.warnings, ...rebuilt.warnings])
        : rebuilt;
    }
  );
}

async function detectChangedIds(
  projectRoot: string,
  changedFiles: readonly string[],
  options: GitWrapperOptions
): Promise<{ memoryIds: ObjectId[]; relationIds: RelationId[] }> {
  const memoryIds = new Set<ObjectId>();
  const relationIds = new Set<RelationId>();

  for (const file of changedFiles) {
    const memorySidecarPath = memorySidecarPathForChangedFile(file);

    if (memorySidecarPath !== null) {
      const id = await readObjectIdFromCurrentOrHead(projectRoot, memorySidecarPath, options);

      if (id !== null) {
        memoryIds.add(id);
      }
    }

    if (isRelationSidecarPath(file)) {
      const id = await readRelationIdFromCurrentOrHead(projectRoot, file, options);

      if (id !== null) {
        relationIds.add(id);
      }
    }
  }

  return {
    memoryIds: [...memoryIds].sort(),
    relationIds: [...relationIds].sort()
  };
}

function memorySidecarPathForChangedFile(file: string): string | null {
  if (!file.startsWith(".memory/memory/")) {
    return null;
  }

  if (file.endsWith(".json")) {
    return file;
  }

  if (file.endsWith(".md")) {
    return `${file.slice(0, -".md".length)}.json`;
  }

  return null;
}

function isRelationSidecarPath(file: string): boolean {
  return file.startsWith(".memory/relations/") && file.endsWith(".json");
}

async function readObjectIdFromCurrentOrHead(
  projectRoot: string,
  file: string,
  options: GitWrapperOptions
): Promise<ObjectId | null> {
  return readIdFromCurrentOrHead(projectRoot, file, options, objectIdFromContents);
}

async function readRelationIdFromCurrentOrHead(
  projectRoot: string,
  file: string,
  options: GitWrapperOptions
): Promise<RelationId | null> {
  return readIdFromCurrentOrHead(projectRoot, file, options, relationIdFromContents);
}

async function readIdFromCurrentOrHead<T extends ObjectId | RelationId>(
  projectRoot: string,
  file: string,
  options: GitWrapperOptions,
  parseId: (contents: string) => T | null
): Promise<T | null> {
  const current = await readUtf8FileInsideRoot(projectRoot, file);

  if (current.ok) {
    const id = parseId(current.data);

    if (id !== null) {
      return id;
    }
  }

  const head = await showMemoryFileAtCommit(projectRoot, "HEAD", file, options);

  if (!head.ok) {
    return null;
  }

  return parseId(head.data.contents);
}

function objectIdFromContents(contents: string): ObjectId | null {
  const parsed = parseJsonObject(contents);

  if (parsed === null || typeof parsed.id !== "string") {
    return null;
  }

  return parsed.id;
}

function relationIdFromContents(contents: string): RelationId | null {
  const parsed = parseJsonObject(contents);

  if (parsed === null || typeof parsed.id !== "string") {
    return null;
  }

  return parsed.id;
}

function parseJsonObject(contents: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(contents) as unknown;

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectPatchSecrets(patch: unknown): Result<void> {
  const result = detectSecretsInPatch(patch);
  const warnings = validationWarnings(result.warnings);

  if (!result.valid) {
    return err(secretDetectionError(result.errors), warnings);
  }

  return ok(undefined, warnings);
}

function validationWarnings(issues: readonly ValidationIssue[]): string[] {
  return issues.map((issue) => `Validation warning in ${issue.path}: ${issue.message}`);
}

async function unresolvedGitConflictIssues(
  paths: ProjectPaths,
  meta: MemoryMeta,
  options: GitWrapperOptions
): Promise<Result<ValidationIssue[]>> {
  if (!meta.git.available) {
    return ok([]);
  }

  const dirtyState = await getMemoryDirtyState(paths.projectRoot, options);

  if (!dirtyState.ok) {
    return dirtyState;
  }

  return ok(
    dirtyState.data.unmergedFiles.map((path) => ({
      code: "MemoryConflictDetected",
      message: "Unresolved Git conflict detected in an Memory file.",
      path,
      field: null
    }))
  );
}

async function generatedIndexWarnings(paths: ProjectPaths): Promise<ValidationIssue[]> {
  const databasePath = await resolveIndexDatabasePath(paths.memoryRoot);

  if (!databasePath.ok) {
    return [generatedIndexWarning(databasePath.error.message)];
  }

  let db: Awaited<ReturnType<typeof openSqliteDatabase>> | null = null;

  try {
    db = await openSqliteDatabase(databasePath.data, {
      readonly: true,
      fileMustExist: true
    });
    const row = db
      .prepare<[string], { value: string }>("SELECT value FROM meta WHERE key = ?")
      .get("schema_version");

    if (row === undefined) {
      return [generatedIndexWarning("SQLite index is missing schema metadata.")];
    }

    if (row.value !== String(CURRENT_INDEX_SCHEMA_VERSION)) {
      return [
        generatedIndexWarning(
          `SQLite index schema version ${row.value} does not match expected version ${CURRENT_INDEX_SCHEMA_VERSION}.`
        )
      ];
    }

    return [];
  } catch (error) {
    return [generatedIndexWarning(`SQLite index could not be opened: ${messageFromUnknown(error)}`)];
  } finally {
    if (db?.open === true) {
      try {
        db.close();
      } catch {
        // Health-check warnings above are more useful than a close failure.
      }
    }
  }
}

function generatedIndexWarning(message: string): ValidationIssue {
  return {
    code: "GeneratedIndexUnavailable",
    message,
    path: ".memory/index/memory.sqlite",
    field: null
  };
}

/**
 * Warning-level product graph findings for `memory check`: anchors that
 * match no tracked or added file, and AGENTS.md/CLAUDE.md product map
 * sections that drifted from the rendered map (or lost their markers).
 * Anchor warnings are skipped when Git is unavailable. Warnings never fail
 * the check.
 */
async function productGraphCheckWarnings(
  paths: ProjectPaths,
  options: GitWrapperOptions
): Promise<ValidationIssue[]> {
  const storage = await readCanonicalStorage(paths.projectRoot);

  if (!storage.ok) {
    return [];
  }

  const map = await buildProductMapBody(paths.projectRoot, storage.data, options);
  const issues = orphanedAnchorWarnings(storage.data.objects, map.anchorFindings);

  for (const target of PRODUCT_MAP_TARGETS) {
    const issue = await productMapFreshnessWarning(paths.projectRoot, target, map.body);

    if (issue !== null) {
      issues.push(issue);
    }
  }

  return issues;
}

function orphanedAnchorWarnings(
  objects: readonly StoredMemoryObject[],
  anchorFindings: readonly AnchorVerification[] | null
): ValidationIssue[] {
  if (anchorFindings === null) {
    return [];
  }

  const liveObjects = new Map(
    objects
      .filter(
        (object) => object.sidecar.status === "active" || object.sidecar.status === "open"
      )
      .map((object) => [object.sidecar.id, object])
  );
  const issues: ValidationIssue[] = [];

  for (const finding of anchorFindings) {
    const object = liveObjects.get(finding.id);

    if (object === undefined) {
      continue;
    }

    for (const anchor of finding.orphaned_anchors) {
      issues.push({
        code: "AnchorOrphaned",
        message: `Anchor \`${anchor}\` on ${finding.id} matches no tracked or added file.`,
        path: object.path,
        field: "/anchors"
      });
    }
  }

  return issues;
}

async function productMapFreshnessWarning(
  projectRoot: string,
  target: string,
  renderedBody: string
): Promise<ValidationIssue | null> {
  const contents = await readUtf8FileInsideRoot(projectRoot, target);

  if (!contents.ok) {
    return {
      code: "ProductMapMissing",
      message: `${target} has no generated product map section. Run \`memory init\` to install it, then any \`memory save\` keeps it fresh.`,
      path: target,
      field: null
    };
  }

  const embedded = extractMarkedSection(contents.data, PRODUCT_MAP_MARKERS);

  if (embedded === null) {
    return {
      code: "ProductMapMissing",
      message: `${target} has no generated product map section. Run \`memory init\` to install it, then any \`memory save\` keeps it fresh.`,
      path: target,
      field: null
    };
  }

  if (embedded.trim() !== renderedBody.trim()) {
    return {
      code: "ProductMapStale",
      message: `Product map section in ${target} is out of date. Run any \`memory save\` to refresh the generated map.`,
      path: target,
      field: null
    };
  }

  return null;
}

function appError<T>(error: MemoryError, warnings: string[], meta: MemoryMeta): AppResult<T> {
  return {
    ok: false,
    error,
    warnings,
    meta
  };
}

async function removeMemoryRoot(memoryRoot: string): Promise<Result<void>> {
  try {
    await rm(memoryRoot, { recursive: true, force: true });
    return ok(undefined);
  } catch (error) {
    return err(
      memoryError("MemoryValidationFailed", "Memory root could not be deleted.", {
        memoryRoot,
        message: messageFromUnknown(error)
      })
    );
  }
}

async function isMemoryRootMissing(memoryRoot: string): Promise<Result<boolean>> {
  try {
    await lstat(memoryRoot);
    return ok(false);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return ok(true);
    }

    return err(
      memoryError("MemoryValidationFailed", "Memory root could not be read.", {
        memoryRoot,
        message: messageFromUnknown(error)
      })
    );
  }
}

async function backupAndClearMemoryRoot(
  projectRoot: string,
  memoryRoot: string,
  options: GitWrapperOptions
): Promise<Result<{ backupPath: string; entriesRemoved: string[] }>> {
  const existingRoot = await ensureRealDirectory(memoryRoot, ".memory");

  if (!existingRoot.ok) {
    return existingRoot;
  }

  const backupRoot = join(memoryRoot, ".backup");

  try {
    await mkdir(backupRoot, { recursive: true });
  } catch (error) {
    return err(
      memoryError("MemoryValidationFailed", "Memory backup directory could not be created.", {
        path: ".memory/.backup",
        message: messageFromUnknown(error)
      })
    );
  }

  const backupDirectory = await ensureRealDirectory(backupRoot, ".memory/.backup");

  if (!backupDirectory.ok) {
    return backupDirectory;
  }

  const archiveName = `memory-${timestampForFilename()}-${randomUUID()}.tar.gz`;
  const archivePath = join(backupRoot, archiveName);
  const archiveRelativePath = toSlash(join(".memory", ".backup", archiveName));
  const archived = await runSubprocess(
    "tar",
    [
      "-czf",
      archivePath,
      "--exclude",
      "./.backup",
      "--exclude",
      ".backup",
      "-C",
      memoryRoot,
      "."
    ],
    {
      cwd: projectRoot,
      ...(options.runner === undefined ? {} : { runner: options.runner })
    }
  );

  if (!archived.ok) {
    await rm(archivePath, { force: true });
    return archived;
  }

  if (archived.data.exitCode !== 0) {
    await rm(archivePath, { force: true });
    return err(
      memoryError("MemoryInternalError", "Memory backup archive could not be created.", {
        command: "tar",
        exitCode: archived.data.exitCode,
        signal: archived.data.signal,
        stderr: archived.data.stderr
      })
    );
  }

  try {
    const entries = await readdir(memoryRoot);
    const entriesToRemove = entries.filter((entry) => entry !== ".backup");

    await Promise.all(
      entriesToRemove.map((entry) => rm(join(memoryRoot, entry), { recursive: true, force: true }))
    );

    return ok({
      backupPath: archiveRelativePath,
      entriesRemoved: entriesToRemove.map((entry) => toSlash(join(".memory", entry))).sort()
    });
  } catch (error) {
    return err(
      memoryError("MemoryValidationFailed", "Memory root could not be cleared after backup.", {
        memoryRoot,
        backupPath: archiveRelativePath,
        message: messageFromUnknown(error)
      })
    );
  }
}

async function ensureRealDirectory(path: string, label: string): Promise<Result<void>> {
  let stats;

  try {
    stats = await lstat(path);
  } catch (error) {
    const code = errorCode(error);
    const message = code === "ENOENT"
      ? `${label} directory does not exist.`
      : `${label} directory could not be read.`;

    return err(
      memoryError(code === "ENOENT" ? "MemoryNotInitialized" : "MemoryValidationFailed", message, {
        path: label,
        message: messageFromUnknown(error)
      })
    );
  }

  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return err(
      memoryError("MemoryValidationFailed", `${label} must be a real directory.`, {
        path: label
      })
    );
  }

  return ok(undefined);
}

function timestampForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function toSlash(path: string): string {
  return path.replace(/\\/gu, "/");
}

function fallbackMeta(paths: ProjectPaths): MemoryMeta {
  return {
    project_root: paths.projectRoot,
    memory_root: paths.memoryRoot,
    git: {
      available: paths.git.available,
      branch: null,
      commit: null,
      dirty: paths.git.available ? false : null
    }
  };
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
  if (isJsonObject(error) && typeof error.code === "string") {
    return error.code;
  }

  return null;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

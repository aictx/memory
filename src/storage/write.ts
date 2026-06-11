import { copyFile, lstat, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import fg from "fast-glob";

import { memoryError, type JsonValue } from "../core/errors.js";
import {
  readUtf8FileInsideRoot,
  resolveInsideRoot,
  writeJsonAtomic,
  writeMarkdownAtomic,
  writeTextAtomic
} from "../core/fs.js";
import {
  getMemoryDirtyState,
  restoreMemoryFromCommit,
  type GitWrapperOptions
} from "../core/git.js";
import { err, ok, type Result } from "../core/result.js";
import type {
  Evidence,
  FeatureStage,
  IsoDateTime,
  MemoryEvent,
  ObjectId,
  ObjectStatus,
  ObjectType,
  PatchOperation,
  RelationConfidence,
  RelationId,
  Source,
  SourceOrigin
} from "../core/types.js";
import {
  compileProjectSchemas,
  type CompiledSchemaValidators
} from "../validation/schemas.js";
import { detectConflictMarkersInText } from "../validation/conflicts.js";
import {
  schemaValidationError,
  validateEvent,
  validateObject,
  validateRelation
} from "../validation/validate.js";
import {
  appendEvents,
  buildWriteEvent,
  validateBuiltEvent
} from "./events.js";
import {
  computeObjectContentHash,
  computeRelationContentHash
} from "./hashes.js";
import { validateMarkdownBody } from "./markdown.js";
import type {
  MemoryObjectSidecar,
  StoredMemoryObject
} from "./objects.js";
import {
  planMemoryPatch,
  type NormalizedCreateObjectChange,
  type NormalizedCreateRelationChange,
  type NormalizedDeleteObjectChange,
  type NormalizedDeleteRelationChange,
  type NormalizedMarkStaleChange,
  type NormalizedPatchChange,
  type NormalizedSupersedeObjectChange,
  type NormalizedUpdateObjectChange,
  type NormalizedUpdateRelationChange,
  type PatchPlan,
  type PatchPlannedEventAppend,
  type PatchRecoveryFile,
  type PlanMemoryPatchOptions
} from "./patch.js";
import { recoveryPathForDirtyFile } from "./patch.js";
import { readCanonicalStorage } from "./read.js";
import type { MemoryRelation } from "./relations.js";

type MemoryPatchOperation = Extract<
  PatchOperation,
  "create_object" | "update_object" | "mark_stale" | "supersede_object" | "delete_object"
>;

type RelationPatchOperation = Extract<
  PatchOperation,
  "create_relation" | "update_relation" | "delete_relation"
>;

type ObjectPatchChange =
  | NormalizedCreateObjectChange
  | NormalizedUpdateObjectChange
  | NormalizedMarkStaleChange
  | NormalizedSupersedeObjectChange
  | NormalizedDeleteObjectChange;

type RelationPatchChange =
  | NormalizedCreateRelationChange
  | NormalizedUpdateRelationChange
  | NormalizedDeleteRelationChange;

type PatchWriteAction =
  | {
      kind: "write_json";
      path: string;
      json: Record<string, JsonValue>;
    }
  | {
      kind: "write_markdown";
      path: string;
      markdown: string;
    }
  | {
      kind: "delete";
      path: string;
    };

interface WriteState {
  objectsById: Map<ObjectId, StoredMemoryObject>;
  relationsById: Map<RelationId, MemoryRelation>;
}

interface RelationJsonInput {
  id: RelationId;
  from: string;
  predicate: string;
  to: string;
  status: string;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  confidence?: RelationConfidence;
  evidence?: Evidence[];
  content_hash?: string;
}

interface ObjectSidecarInput {
  id: ObjectId;
  type: ObjectType;
  status: ObjectStatus;
  title: string;
  bodyPath: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  stage?: FeatureStage | undefined;
  anchors?: string[] | undefined;
  tags?: string[] | undefined;
  evidence?: Evidence[] | undefined;
  source?: Source | undefined;
  origin?: SourceOrigin | undefined;
  supersededBy?: ObjectId | null | undefined;
}

export interface RestoreCanonicalStorageFromCommitOptions extends GitWrapperOptions {
  projectRoot: string;
  commit: string;
}

export interface RestoreCanonicalStorageFromCommitData {
  restored_from: string;
  files_changed: string[];
}

interface RepairCanonicalStorageForSaveData {
  recovery_files: PatchRecoveryFile[];
  repairs_applied: string[];
}

export async function applyMemoryPatch(
  options: PlanMemoryPatchOptions
): Promise<Result<PatchPlan>> {
  const projectRoot = resolve(options.projectRoot);
  const validators = await getValidators(projectRoot, options.validators);

  if (!validators.ok) {
    return validators;
  }

  const repaired = await repairInvalidCanonicalStorageForSave(
    projectRoot,
    validators.data,
    options.clock.nowIso()
  );

  if (!repaired.ok) {
    return repaired;
  }

  const planned = await planMemoryPatch({
    ...options,
    projectRoot,
    validators: validators.data
  });

  if (!planned.ok) {
    return err(planned.error, [...repaired.warnings, ...planned.warnings]);
  }

  const storage = await readCanonicalStorage(projectRoot, {
    validators: validators.data
  });

  if (!storage.ok) {
    return storage;
  }

  const state = createWriteState(storage.data.objects, storage.data.relations);
  const actions = buildWriteActions(planned.data, state, validators.data);

  if (!actions.ok) {
    return err(actions.error, planned.warnings);
  }

  const events = buildPlannedEvents(planned.data.eventAppends, validators.data);

  if (!events.ok) {
    return err(events.error, planned.warnings);
  }

  const recovered = await backupRecoveryFiles(projectRoot, planned.data.recovery_files);

  if (!recovered.ok) {
    return err(recovered.error, planned.warnings);
  }

  for (const action of actions.data) {
    const applied = await applyWriteAction(projectRoot, action);

    if (!applied.ok) {
      return err(applied.error, [...planned.warnings, ...recovered.warnings]);
    }
  }

  const appendedEvents = await appendEvents(projectRoot, validators.data, events.data);

  if (!appendedEvents.ok) {
    return err(appendedEvents.error, [...planned.warnings, ...recovered.warnings]);
  }

  return ok(
    {
      ...planned.data,
      recovery_files: [...repaired.data.recovery_files, ...planned.data.recovery_files],
      repairs_applied: repaired.data.repairs_applied
    },
    [...repaired.warnings, ...planned.warnings, ...recovered.warnings]
  );
}

export async function restoreCanonicalStorageFromCommit(
  options: RestoreCanonicalStorageFromCommitOptions
): Promise<Result<RestoreCanonicalStorageFromCommitData>> {
  const projectRoot = resolve(options.projectRoot);
  const restored = await restoreMemoryFromCommit(projectRoot, options.commit, options);

  if (!restored.ok) {
    return restored;
  }

  // Git cannot restore empty directories, and v5 storage tracks no starter
  // relation, so recreate the required canonical directories after restore.
  for (const requiredDirectory of ["memory", "relations", "schema"] as const) {
    await mkdir(resolve(projectRoot, ".memory", requiredDirectory), { recursive: true });
  }

  const changed = await getMemoryDirtyState(projectRoot, options);

  if (!changed.ok) {
    return changed;
  }

  return ok({
    restored_from: options.commit,
    files_changed: changed.data.files
  });
}

async function repairInvalidCanonicalStorageForSave(
  projectRoot: string,
  validators: CompiledSchemaValidators,
  timestamp: IsoDateTime
): Promise<Result<RepairCanonicalStorageForSaveData>> {
  const recoveryFiles: PatchRecoveryFile[] = [];
  const repairsApplied: string[] = [];
  const warnings: string[] = [];

  const objectPaths = await discoverCanonicalJson(projectRoot, ".memory/memory/**/*.json");

  for (const path of objectPaths) {
    const result = await inspectObjectForSave(projectRoot, validators, path);

    if (result.valid) {
      continue;
    }

    const recovered = await quarantineCanonicalFile(projectRoot, path, timestamp);
    warnings.push(...recovered.warnings);

    if (recovered.ok && recovered.data !== null) {
      recoveryFiles.push(recovered.data);
      repairsApplied.push(`Quarantined invalid memory object sidecar: ${path}`);
    }

    if (result.bodyPath !== null) {
      const bodyRecovered = await quarantineCanonicalFile(projectRoot, result.bodyPath, timestamp);
      warnings.push(...bodyRecovered.warnings);

      if (bodyRecovered.ok && bodyRecovered.data !== null) {
        recoveryFiles.push(bodyRecovered.data);
        repairsApplied.push(`Quarantined invalid memory object body: ${result.bodyPath}`);
      }
    }
  }

  const relationPaths = await discoverCanonicalJson(projectRoot, ".memory/relations/**/*.json");

  for (const path of relationPaths) {
    const result = await inspectRelationForSave(projectRoot, validators, path);

    if (result.valid) {
      continue;
    }

    const recovered = await quarantineCanonicalFile(projectRoot, path, timestamp);
    warnings.push(...recovered.warnings);

    if (recovered.ok && recovered.data !== null) {
      recoveryFiles.push(recovered.data);
      repairsApplied.push(`Quarantined invalid memory relation: ${path}`);
    }
  }

  const events = await repairEventsForSave(projectRoot, validators, timestamp);

  if (!events.ok) {
    return events;
  }

  return ok(
    {
      recovery_files: [...recoveryFiles, ...events.data.recovery_files],
      repairs_applied: [...repairsApplied, ...events.data.repairs_applied]
    },
    [...warnings, ...events.warnings]
  );
}

async function getValidators(
  projectRoot: string,
  validators: CompiledSchemaValidators | undefined
): Promise<Result<CompiledSchemaValidators>> {
  if (validators !== undefined) {
    return ok(validators);
  }

  return compileProjectSchemas(projectRoot);
}

interface InspectCanonicalFileResult {
  valid: boolean;
  bodyPath: string | null;
}

async function inspectObjectForSave(
  projectRoot: string,
  validators: CompiledSchemaValidators,
  path: string
): Promise<InspectCanonicalFileResult> {
  const contents = await readUtf8FileInsideRoot(projectRoot, path);

  if (!contents.ok || hasConflictMarkers(contents.data, path)) {
    return { valid: false, bodyPath: null };
  }

  const parsed = parseJson(contents.data);

  if (!parsed.ok) {
    return { valid: false, bodyPath: null };
  }

  const bodyPath = bodyPathFromSidecar(parsed.data);
  const validation = validateObject(validators, parsed.data, path);

  if (!validation.valid || bodyPath === null) {
    return { valid: false, bodyPath };
  }

  const body = await readUtf8FileInsideRoot(projectRoot, bodyPath);

  if (!body.ok || hasConflictMarkers(body.data, bodyPath)) {
    return { valid: false, bodyPath };
  }

  return { valid: true, bodyPath };
}

async function inspectRelationForSave(
  projectRoot: string,
  validators: CompiledSchemaValidators,
  path: string
): Promise<InspectCanonicalFileResult> {
  const contents = await readUtf8FileInsideRoot(projectRoot, path);

  if (!contents.ok || hasConflictMarkers(contents.data, path)) {
    return { valid: false, bodyPath: null };
  }

  const parsed = parseJson(contents.data);

  if (!parsed.ok) {
    return { valid: false, bodyPath: null };
  }

  const validation = validateRelation(validators, parsed.data, path);

  return { valid: validation.valid, bodyPath: null };
}

async function repairEventsForSave(
  projectRoot: string,
  validators: CompiledSchemaValidators,
  timestamp: IsoDateTime
): Promise<Result<RepairCanonicalStorageForSaveData>> {
  const path = ".memory/events.jsonl";
  const contents = await readUtf8FileInsideRoot(projectRoot, path);

  if (!contents.ok) {
    return ok({ recovery_files: [], repairs_applied: [] }, [
      `Events repair skipped: ${contents.error.message}`
    ]);
  }

  const lines = contents.data.split(/\n/);
  const validLines: string[] = [];
  let repaired = false;

  for (const [index, line] of lines.entries()) {
    const isLastBlankLine = index === lines.length - 1 && line === "";

    if (isLastBlankLine) {
      continue;
    }

    if (line.trim() === "" || hasConflictMarkers(line, `${path}:${index + 1}`)) {
      repaired = true;
      continue;
    }

    const parsed = parseJson(line);

    if (!parsed.ok) {
      repaired = true;
      continue;
    }

    const validation = validateEvent(validators, parsed.data, path, index + 1);

    if (!validation.valid) {
      repaired = true;
      continue;
    }

    validLines.push(line);
  }

  if (!repaired) {
    return ok({ recovery_files: [], repairs_applied: [] });
  }

  const recovered = await backupRecoveryFiles(projectRoot, [
    {
      path,
      recovery_path: recoveryPathForDirtyFile(timestamp, path)
    }
  ]);

  if (!recovered.ok) {
    return recovered;
  }

  const written = await writeTextAtomic(
    projectRoot,
    path,
    validLines.length === 0 ? "" : `${validLines.join("\n")}\n`
  );

  if (!written.ok) {
    return written;
  }

  return ok(
    {
      recovery_files: [
        {
          path,
          recovery_path: recoveryPathForDirtyFile(timestamp, path),
          reason: "repair_quarantine"
        }
      ],
      repairs_applied: [`Repaired invalid events history: ${path}`]
    },
    recovered.warnings
  );
}

async function quarantineCanonicalFile(
  projectRoot: string,
  path: string,
  timestamp: IsoDateTime
): Promise<Result<PatchRecoveryFile | null>> {
  const recoveryFile: PatchRecoveryFile = {
    path,
    recovery_path: recoveryPathForDirtyFile(timestamp, path),
    reason: "repair_quarantine"
  };
  const backedUp = await backupRecoveryFiles(projectRoot, [recoveryFile]);

  if (!backedUp.ok) {
    return backedUp;
  }

  const resolved = resolveInsideRoot(projectRoot, path);

  if (!resolved.ok) {
    return err(resolved.error, backedUp.warnings);
  }

  try {
    await rm(resolved.data, { force: true });
    return ok(recoveryFile, backedUp.warnings);
  } catch (error) {
    return err(
      memoryError("MemoryValidationFailed", "Invalid canonical file could not be quarantined.", {
        path,
        message: error instanceof Error ? error.message : String(error)
      }),
      backedUp.warnings
    );
  }
}

async function discoverCanonicalJson(projectRoot: string, pattern: string): Promise<string[]> {
  return (
    await fg(pattern, {
      cwd: projectRoot,
      dot: true,
      ignore: [".memory/index/**", ".memory/recovery/**"],
      onlyFiles: true,
      unique: true
    })
  ).sort();
}

function parseJson(contents: string): Result<unknown> {
  try {
    return ok(JSON.parse(contents) as unknown);
  } catch {
    return err(memoryError("MemoryInvalidJson", "Invalid JSON."));
  }
}

function bodyPathFromSidecar(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const bodyPath = (value as { body_path?: unknown }).body_path;

  return typeof bodyPath === "string" ? `.memory/${bodyPath}` : null;
}

function hasConflictMarkers(contents: string, path: string): boolean {
  return !detectConflictMarkersInText(contents, path).valid;
}

function createWriteState(
  objects: readonly StoredMemoryObject[],
  relations: readonly { relation: MemoryRelation }[]
): WriteState {
  return {
    objectsById: new Map(objects.map((object) => [object.sidecar.id, object])),
    relationsById: new Map(relations.map((item) => [item.relation.id, item.relation]))
  };
}

function buildWriteActions(
  plan: PatchPlan,
  state: WriteState,
  validators: CompiledSchemaValidators
): Result<PatchWriteAction[]> {
  const actions: PatchWriteAction[] = [];

  for (const change of plan.changes) {
    const nextActions = buildWriteActionsForChange(
      change,
      state,
      plan.eventAppends,
      validators
    );

    if (!nextActions.ok) {
      return nextActions;
    }

    actions.push(...nextActions.data);
  }

  return ok(actions);
}

function buildWriteActionsForChange(
  change: NormalizedPatchChange,
  state: WriteState,
  eventAppends: readonly PatchPlannedEventAppend[],
  validators: CompiledSchemaValidators
): Result<PatchWriteAction[]> {
  if (isObjectChange(change)) {
    return buildObjectWriteActions(change, state, eventAppends, validators);
  }

  return buildRelationWriteActions(change, state, eventAppends, validators);
}

function buildObjectWriteActions(
  change: ObjectPatchChange,
  state: WriteState,
  eventAppends: readonly PatchPlannedEventAppend[],
  validators: CompiledSchemaValidators
): Result<PatchWriteAction[]> {
  switch (change.op) {
    case "create_object":
      return buildCreateObjectActions(change, state, eventAppends, validators);
    case "update_object":
      return buildUpdateObjectActions(change, state, eventAppends, validators);
    case "mark_stale":
      return buildMarkStaleActions(change, state, eventAppends, validators);
    case "supersede_object":
      return buildSupersedeObjectActions(change, state, eventAppends, validators);
    case "delete_object":
      return buildDeleteObjectActions(change, state);
  }
}

function buildCreateObjectActions(
  change: NormalizedCreateObjectChange,
  state: WriteState,
  eventAppends: readonly PatchPlannedEventAppend[],
  validators: CompiledSchemaValidators
): Result<PatchWriteAction[]> {
  const timestamp = objectEventTimestamp(eventAppends, change.id, "create_object");

  if (!timestamp.ok) {
    return timestamp;
  }

  const bodyPath = toMemoryRelativePath(change.bodyPath);

  if (!bodyPath.ok) {
    return bodyPath;
  }

  const sidecarWithoutHash = buildObjectSidecarWithoutHash({
    id: change.id,
    type: change.type,
    status: change.status,
    title: change.title,
    bodyPath: bodyPath.data,
    stage: change.stage,
    anchors: change.anchors,
    tags: change.tags,
    evidence: change.evidence,
    source: change.source,
    origin: change.origin,
    createdAt: timestamp.data,
    updatedAt: timestamp.data
  });
  const sidecar = withObjectHash(sidecarWithoutHash, change.body);
  const json = validateObjectSidecar(
    sidecar,
    change.body,
    change.path,
    change.bodyPath,
    validators
  );

  if (!json.ok) {
    return json;
  }

  state.objectsById.set(change.id, {
    path: change.path,
    bodyPath: change.bodyPath,
    sidecar,
    body: change.body
  });

  return ok([
    {
      kind: "write_markdown",
      path: change.bodyPath,
      markdown: change.body
    },
    {
      kind: "write_json",
      path: change.path,
      json: json.data
    }
  ]);
}

function buildUpdateObjectActions(
  change: NormalizedUpdateObjectChange,
  state: WriteState,
  eventAppends: readonly PatchPlannedEventAppend[],
  validators: CompiledSchemaValidators
): Result<PatchWriteAction[]> {
  if (!objectUpdateTouchesMutableField(change)) {
    return ok([]);
  }

  const existing = state.objectsById.get(change.id);

  if (existing === undefined) {
    return internalError(`Planned object update has no loaded object: ${change.id}.`);
  }

  const timestamp = objectEventTimestamp(eventAppends, change.id, "update_object");

  if (!timestamp.ok) {
    return timestamp;
  }

  const body = change.body ?? existing.body;
  const sidecarWithoutHash = buildObjectSidecarWithoutHash({
    id: existing.sidecar.id,
    type: existing.sidecar.type,
    status: change.status ?? existing.sidecar.status,
    title: change.title ?? existing.sidecar.title,
    bodyPath: existing.sidecar.body_path,
    stage: change.stage ?? existing.sidecar.stage,
    anchors: change.anchors ?? existing.sidecar.anchors,
    tags: change.tags ?? existing.sidecar.tags,
    evidence: change.evidence ?? existing.sidecar.evidence,
    source: change.source ?? existing.sidecar.source,
    origin: change.origin ?? existing.sidecar.origin,
    supersededBy:
      change.superseded_by === undefined
        ? existing.sidecar.superseded_by
        : change.superseded_by,
    createdAt: existing.sidecar.created_at,
    updatedAt: timestamp.data
  });
  const sidecar = withObjectHash(sidecarWithoutHash, body);
  const json = validateObjectSidecar(
    sidecar,
    body,
    existing.path,
    existing.bodyPath,
    validators
  );

  if (!json.ok) {
    return json;
  }

  state.objectsById.set(change.id, {
    ...existing,
    sidecar,
    body
  });

  return ok([
    ...(change.body === undefined
      ? []
      : [
          {
            kind: "write_markdown" as const,
            path: existing.bodyPath,
            markdown: body
          }
        ]),
    {
      kind: "write_json",
      path: existing.path,
      json: json.data
    }
  ]);
}

function buildMarkStaleActions(
  change: NormalizedMarkStaleChange,
  state: WriteState,
  eventAppends: readonly PatchPlannedEventAppend[],
  validators: CompiledSchemaValidators
): Result<PatchWriteAction[]> {
  const existing = state.objectsById.get(change.id);

  if (existing === undefined) {
    return internalError(`Planned stale marker has no loaded object: ${change.id}.`);
  }

  const timestamp = objectEventTimestamp(eventAppends, change.id, "mark_stale");

  if (!timestamp.ok) {
    return timestamp;
  }

  return buildObjectStatusActions(
    existing,
    {
      status: "stale",
      updatedAt: timestamp.data
    },
    state,
    validators
  );
}

function buildSupersedeObjectActions(
  change: NormalizedSupersedeObjectChange,
  state: WriteState,
  eventAppends: readonly PatchPlannedEventAppend[],
  validators: CompiledSchemaValidators
): Result<PatchWriteAction[]> {
  const existing = state.objectsById.get(change.id);

  if (existing === undefined) {
    return internalError(`Planned supersede has no loaded object: ${change.id}.`);
  }

  const timestamp = objectEventTimestamp(eventAppends, change.id, "supersede_object");

  if (!timestamp.ok) {
    return timestamp;
  }

  return buildObjectStatusActions(
    existing,
    {
      status: "superseded",
      supersededBy: change.superseded_by,
      updatedAt: timestamp.data
    },
    state,
    validators
  );
}

function buildObjectStatusActions(
  existing: StoredMemoryObject,
  update: {
    status: ObjectStatus;
    updatedAt: IsoDateTime;
    supersededBy?: ObjectId | null;
  },
  state: WriteState,
  validators: CompiledSchemaValidators
): Result<PatchWriteAction[]> {
  const sidecarWithoutHash = buildObjectSidecarWithoutHash({
    id: existing.sidecar.id,
    type: existing.sidecar.type,
    status: update.status,
    title: existing.sidecar.title,
    bodyPath: existing.sidecar.body_path,
    stage: existing.sidecar.stage,
    anchors: existing.sidecar.anchors,
    tags: existing.sidecar.tags,
    evidence: existing.sidecar.evidence,
    source: existing.sidecar.source,
    origin: existing.sidecar.origin,
    supersededBy:
      update.supersededBy === undefined
        ? existing.sidecar.superseded_by
        : update.supersededBy,
    createdAt: existing.sidecar.created_at,
    updatedAt: update.updatedAt
  });
  const sidecar = withObjectHash(sidecarWithoutHash, existing.body);
  const json = validateObjectSidecar(
    sidecar,
    existing.body,
    existing.path,
    existing.bodyPath,
    validators
  );

  if (!json.ok) {
    return json;
  }

  state.objectsById.set(existing.sidecar.id, {
    ...existing,
    sidecar
  });

  return ok([
    {
      kind: "write_json",
      path: existing.path,
      json: json.data
    }
  ]);
}

function buildDeleteObjectActions(
  change: NormalizedDeleteObjectChange,
  state: WriteState
): Result<PatchWriteAction[]> {
  if (!state.objectsById.has(change.id)) {
    return internalError(`Planned object delete has no loaded object: ${change.id}.`);
  }

  state.objectsById.delete(change.id);

  return ok([
    {
      kind: "delete",
      path: change.bodyPath
    },
    {
      kind: "delete",
      path: change.path
    }
  ]);
}

function buildRelationWriteActions(
  change: RelationPatchChange,
  state: WriteState,
  eventAppends: readonly PatchPlannedEventAppend[],
  validators: CompiledSchemaValidators
): Result<PatchWriteAction[]> {
  switch (change.op) {
    case "create_relation":
      return buildCreateRelationActions(change, state, validators);
    case "update_relation":
      return buildUpdateRelationActions(change, state, eventAppends, validators);
    case "delete_relation":
      return buildDeleteRelationActions(change, state);
  }
}

function buildCreateRelationActions(
  change: NormalizedCreateRelationChange,
  state: WriteState,
  validators: CompiledSchemaValidators
): Result<PatchWriteAction[]> {
  const relation = withRelationHash({
    id: change.id,
    from: change.from,
    predicate: change.predicate,
    to: change.to,
    status: change.status,
    ...(change.confidence === undefined ? {} : { confidence: change.confidence }),
    ...(change.evidence === undefined ? {} : { evidence: change.evidence }),
    created_at: change.createdAt,
    updated_at: change.createdAt
  });
  const json = relationToJson(relation);
  const validation = validateRelation(validators, json, change.path);

  if (!validation.valid) {
    return err(schemaValidationError(validation.errors));
  }

  state.relationsById.set(change.id, relation);

  return ok([
    {
      kind: "write_json",
      path: change.path,
      json
    }
  ]);
}

function buildUpdateRelationActions(
  change: NormalizedUpdateRelationChange,
  state: WriteState,
  eventAppends: readonly PatchPlannedEventAppend[],
  validators: CompiledSchemaValidators
): Result<PatchWriteAction[]> {
  if (!relationUpdateTouchesMutableField(change)) {
    return ok([]);
  }

  const existing = state.relationsById.get(change.id);

  if (existing === undefined) {
    return internalError(`Planned relation update has no loaded relation: ${change.id}.`);
  }

  const timestamp = relationEventTimestamp(eventAppends, change.id, "update_relation");

  if (!timestamp.ok) {
    return timestamp;
  }

  const relation = withRelationHash({
    id: existing.id,
    from: existing.from,
    predicate: existing.predicate,
    to: existing.to,
    status: change.status ?? existing.status,
    ...(change.confidence === undefined
      ? optionalConfidence(existing)
      : { confidence: change.confidence }),
    ...(change.evidence === undefined
      ? optionalEvidence(existing)
      : { evidence: change.evidence }),
    created_at: existing.created_at,
    updated_at: timestamp.data
  });
  const json = relationToJson(relation);
  const validation = validateRelation(validators, json, change.path);

  if (!validation.valid) {
    return err(schemaValidationError(validation.errors));
  }

  state.relationsById.set(change.id, relation);

  return ok([
    {
      kind: "write_json",
      path: change.path,
      json
    }
  ]);
}

function buildDeleteRelationActions(
  change: NormalizedDeleteRelationChange,
  state: WriteState
): Result<PatchWriteAction[]> {
  if (!state.relationsById.has(change.id)) {
    return internalError(`Planned relation delete has no loaded relation: ${change.id}.`);
  }

  state.relationsById.delete(change.id);

  return ok([
    {
      kind: "delete",
      path: change.path
    }
  ]);
}

function buildObjectSidecarWithoutHash(
  input: ObjectSidecarInput
): Omit<MemoryObjectSidecar, "content_hash"> {
  const sidecar: Omit<MemoryObjectSidecar, "content_hash"> = {
    id: input.id,
    type: input.type,
    status: input.status,
    title: input.title,
    body_path: input.bodyPath,
    created_at: input.createdAt,
    updated_at: input.updatedAt
  };

  if (input.stage !== undefined) {
    sidecar.stage = input.stage;
  }

  if (input.anchors !== undefined && input.anchors.length > 0) {
    sidecar.anchors = [...input.anchors];
  }

  if (input.tags !== undefined) {
    sidecar.tags = [...input.tags];
  }

  if (input.evidence !== undefined) {
    sidecar.evidence = input.evidence.map(cloneEvidence);
  }

  if (input.source !== undefined) {
    sidecar.source = cloneSource(input.source);
  }

  if (input.origin !== undefined) {
    sidecar.origin = cloneSourceOrigin(input.origin);
  }

  if (input.supersededBy !== undefined) {
    sidecar.superseded_by = input.supersededBy;
  }

  return sidecar;
}

function withObjectHash(
  sidecar: Omit<MemoryObjectSidecar, "content_hash">,
  body: string
): MemoryObjectSidecar {
  const sidecarJson = objectSidecarToJson(sidecar);

  return {
    ...sidecar,
    content_hash: computeObjectContentHash(sidecarJson, body)
  };
}

function validateObjectSidecar(
  sidecar: MemoryObjectSidecar,
  body: string,
  sidecarPath: string,
  bodyPath: string,
  validators: CompiledSchemaValidators
): Result<Record<string, JsonValue>> {
  const markdownValidation = validateMarkdownBody(body, bodyPath);

  if (!markdownValidation.valid) {
    return err(schemaValidationError(markdownValidation.errors));
  }

  const json = objectSidecarToJson(sidecar);
  const validation = validateObject(validators, json, sidecarPath);

  if (!validation.valid) {
    return err(schemaValidationError(validation.errors));
  }

  return ok(json);
}

function objectSidecarToJson(
  sidecar: Omit<MemoryObjectSidecar, "content_hash"> | MemoryObjectSidecar
): Record<string, JsonValue> {
  const json: Record<string, JsonValue> = {
    id: sidecar.id,
    type: sidecar.type,
    status: sidecar.status,
    title: sidecar.title,
    body_path: sidecar.body_path,
    created_at: sidecar.created_at,
    updated_at: sidecar.updated_at
  };

  if (sidecar.stage !== undefined) {
    json.stage = sidecar.stage;
  }

  if (sidecar.anchors !== undefined) {
    json.anchors = [...sidecar.anchors];
  }

  if (sidecar.tags !== undefined) {
    json.tags = [...sidecar.tags];
  }

  if (sidecar.evidence !== undefined) {
    json.evidence = sidecar.evidence.map(evidenceToJson);
  }

  if (sidecar.source !== undefined) {
    json.source = sourceToJson(sidecar.source);
  }

  if (sidecar.origin !== undefined) {
    json.origin = sourceOriginToJson(sidecar.origin);
  }

  if (sidecar.superseded_by !== undefined) {
    json.superseded_by = sidecar.superseded_by;
  }

  if ("content_hash" in sidecar) {
    json.content_hash = sidecar.content_hash;
  }

  return json;
}

function sourceToJson(source: Source): Record<string, JsonValue> {
  const json: Record<string, JsonValue> = {
    kind: source.kind
  };

  if (source.task !== undefined) {
    json.task = source.task;
  }

  if (source.commit !== undefined) {
    json.commit = source.commit;
  }

  return json;
}

function cloneSourceOrigin(origin: SourceOrigin): SourceOrigin {
  return {
    kind: origin.kind,
    locator: origin.locator,
    ...(origin.captured_at === undefined ? {} : { captured_at: origin.captured_at }),
    ...(origin.digest === undefined ? {} : { digest: origin.digest }),
    ...(origin.media_type === undefined ? {} : { media_type: origin.media_type })
  };
}

function sourceOriginToJson(origin: SourceOrigin): Record<string, JsonValue> {
  return {
    kind: origin.kind,
    locator: origin.locator,
    ...(origin.captured_at === undefined ? {} : { captured_at: origin.captured_at }),
    ...(origin.digest === undefined ? {} : { digest: origin.digest }),
    ...(origin.media_type === undefined ? {} : { media_type: origin.media_type })
  };
}

function evidenceToJson(evidence: Evidence): Record<string, JsonValue> {
  return {
    kind: evidence.kind,
    id: evidence.id
  };
}

function relationToJson(relation: RelationJsonInput): Record<string, JsonValue> {
  const json: Record<string, JsonValue> = {
    id: relation.id,
    from: relation.from,
    predicate: relation.predicate,
    to: relation.to,
    status: relation.status,
    created_at: relation.created_at,
    updated_at: relation.updated_at
  };

  if (relation.confidence !== undefined) {
    json.confidence = relation.confidence;
  }

  if (relation.evidence !== undefined) {
    json.evidence = relation.evidence.map(evidenceToJson);
  }

  if (relation.content_hash !== undefined) {
    json.content_hash = relation.content_hash;
  }

  return json;
}

function withRelationHash(relation: Omit<MemoryRelation, "content_hash">): MemoryRelation {
  return {
    ...relation,
    content_hash: computeRelationContentHash(relationToJson(relation))
  };
}

function buildPlannedEvents(
  eventAppends: readonly PatchPlannedEventAppend[],
  validators: CompiledSchemaValidators
): Result<MemoryEvent[]> {
  const events: MemoryEvent[] = [];

  for (const append of eventAppends) {
    const eventInput = plannedEventInput(append);

    if (!eventInput.ok) {
      return eventInput;
    }

    const event = buildWriteEvent(eventInput.data);
    const validation = validateBuiltEvent(validators, event);

    if (!validation.ok) {
      return validation;
    }

    events.push(validation.data);
  }

  return ok(events);
}

function plannedEventInput(
  append: PatchPlannedEventAppend
): Result<Parameters<typeof buildWriteEvent>[0]> {
  if (isMemoryOperation(append.operation)) {
    if (append.id === undefined) {
      return internalError(`Planned memory event is missing an object id: ${append.operation}.`);
    }

    return ok({
      operation: append.operation,
      id: append.id,
      actor: append.actor,
      timestamp: append.timestamp,
      ...(append.reason === undefined ? {} : { reason: append.reason })
    });
  }

  if (append.relationId === undefined) {
    return internalError(`Planned relation event is missing a relation id: ${append.operation}.`);
  }

  return ok({
    operation: append.operation,
    relationId: append.relationId,
    actor: append.actor,
    timestamp: append.timestamp,
    ...(append.reason === undefined ? {} : { reason: append.reason })
  });
}

async function applyWriteAction(
  projectRoot: string,
  action: PatchWriteAction
): Promise<Result<void>> {
  if (action.kind === "write_json") {
    return writeJsonAtomic(projectRoot, action.path, action.json);
  }

  if (action.kind === "write_markdown") {
    return writeMarkdownAtomic(projectRoot, action.path, action.markdown);
  }

  const resolved = resolveInsideRoot(projectRoot, action.path);

  if (!resolved.ok) {
    return resolved;
  }

  try {
    await rm(resolved.data, { force: true });
    return ok(undefined);
  } catch (error) {
    return err(
      memoryError("MemoryValidationFailed", "Canonical file could not be deleted.", {
        path: action.path,
        message: error instanceof Error ? error.message : String(error)
      })
    );
  }
}

async function backupRecoveryFiles(
  projectRoot: string,
  files: readonly { path: string; recovery_path: string }[]
): Promise<Result<void>> {
  const warnings: string[] = [];

  for (const file of files) {
    const source = resolveInsideRoot(projectRoot, file.path);

    if (!source.ok) {
      warnings.push(`Recovery backup skipped for ${file.path}: ${source.error.message}`);
      continue;
    }

    const destination = resolveInsideRoot(projectRoot, file.recovery_path);

    if (!destination.ok) {
      warnings.push(`Recovery backup skipped for ${file.path}: ${destination.error.message}`);
      continue;
    }

    try {
      const stat = await lstat(source.data);

      if (!stat.isFile()) {
        warnings.push(`Recovery backup skipped for ${file.path}: path is not a regular file.`);
        continue;
      }

      await mkdir(dirname(destination.data), { recursive: true });
      await copyFile(source.data, destination.data);
    } catch (error) {
      warnings.push(
        `Recovery backup skipped for ${file.path}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return ok(undefined, warnings);
}

function objectUpdateTouchesMutableField(change: NormalizedUpdateObjectChange): boolean {
  return (
    change.status !== undefined ||
    change.title !== undefined ||
    change.body !== undefined ||
    change.stage !== undefined ||
    change.anchors !== undefined ||
    change.tags !== undefined ||
    change.evidence !== undefined ||
    change.source !== undefined ||
    change.origin !== undefined ||
    change.superseded_by !== undefined
  );
}

function relationUpdateTouchesMutableField(change: NormalizedUpdateRelationChange): boolean {
  return (
    change.status !== undefined ||
    change.confidence !== undefined ||
    change.evidence !== undefined
  );
}

function objectEventTimestamp(
  eventAppends: readonly PatchPlannedEventAppend[],
  id: ObjectId,
  operation: MemoryPatchOperation
): Result<IsoDateTime> {
  const event = eventAppends.find(
    (append) => append.operation === operation && append.id === id
  );

  if (event === undefined) {
    return internalError(`Missing planned memory event timestamp for ${operation}:${id}.`);
  }

  return ok(event.timestamp);
}

function relationEventTimestamp(
  eventAppends: readonly PatchPlannedEventAppend[],
  relationId: RelationId,
  operation: RelationPatchOperation
): Result<IsoDateTime> {
  const event = eventAppends.find(
    (append) => append.operation === operation && append.relationId === relationId
  );

  if (event === undefined) {
    return internalError(
      `Missing planned relation event timestamp for ${operation}:${relationId}.`
    );
  }

  return ok(event.timestamp);
}

function toMemoryRelativePath(path: string): Result<string> {
  const prefix = ".memory/";

  if (!path.startsWith(prefix)) {
    return internalError(`Planned object body path is not under .memory/: ${path}.`);
  }

  return ok(path.slice(prefix.length));
}

function optionalConfidence(relation: MemoryRelation): { confidence: RelationConfidence } | {} {
  return relation.confidence === undefined ? {} : { confidence: relation.confidence };
}

function optionalEvidence(relation: MemoryRelation): { evidence: Evidence[] } | {} {
  return relation.evidence === undefined ? {} : { evidence: relation.evidence };
}

function cloneSource(source: Source): Source {
  return {
    kind: source.kind,
    ...(source.task === undefined ? {} : { task: source.task }),
    ...(source.commit === undefined ? {} : { commit: source.commit })
  };
}

function cloneEvidence(evidence: Evidence): Evidence {
  return {
    kind: evidence.kind,
    id: evidence.id
  };
}

function isObjectChange(change: NormalizedPatchChange): change is ObjectPatchChange {
  switch (change.op) {
    case "create_object":
    case "update_object":
    case "mark_stale":
    case "supersede_object":
    case "delete_object":
      return true;
    case "create_relation":
    case "update_relation":
    case "delete_relation":
      return false;
  }
}

function isMemoryOperation(operation: PatchOperation): operation is MemoryPatchOperation {
  switch (operation) {
    case "create_object":
    case "update_object":
    case "mark_stale":
    case "supersede_object":
    case "delete_object":
      return true;
    case "create_relation":
    case "update_relation":
    case "delete_relation":
      return false;
  }
}

function internalError<T>(message: string): Result<T> {
  return err(memoryError("MemoryInternalError", message));
}

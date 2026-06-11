import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import type { Clock } from "../core/clock.js";
import { memoryError, type MemoryErrorCode } from "../core/errors.js";
import {
  filterTrackedFiles,
  getMemoryDirtyState,
  type GitWrapperOptions
} from "../core/git.js";
import {
  generateObjectId,
  generateRelationId,
  slugify
} from "../core/ids.js";
import { err, ok, type Result } from "../core/result.js";
import { validateAnchors } from "../anchors/normalize.js";
import type {
  Actor,
  Evidence,
  FeatureStage,
  GitState,
  IsoDateTime,
  ObjectId,
  ObjectStatus,
  ObjectType,
  PatchOperation,
  Predicate,
  RelationConfidence,
  RelationId,
  RelationStatus,
  Source,
  SourceOrigin,
  ValidationIssue
} from "../core/types.js";
import { FEATURE_STAGES, PATCH_OPERATIONS } from "../core/types.js";
import {
  compileProjectSchemas,
  type CompiledSchemaValidators
} from "../validation/schemas.js";
import {
  schemaValidationError,
  validatePatch
} from "../validation/validate.js";
import type { StoredMemoryObject } from "./objects.js";
import type { StoredMemoryRelation } from "./relations.js";
import {
  readCanonicalStorage,
  type CanonicalStorageSnapshot
} from "./read.js";

const PATCH_PATH = "<patch>";
const EVENTS_PATH = ".memory/events.jsonl";
const QUESTION_STATUSES = new Set<ObjectStatus>([
  "stale",
  "superseded",
  "open",
  "closed"
]);
const NON_QUESTION_STATUSES = new Set<ObjectStatus>([
  "active",
  "stale",
  "superseded"
]);
const PATCH_OPERATION_SET = new Set<string>(PATCH_OPERATIONS);
const FEATURE_STAGE_SET = new Set<string>(FEATURE_STAGES);

export interface PlanMemoryPatchOptions extends GitWrapperOptions {
  projectRoot: string;
  patch: unknown;
  git: GitState;
  clock: Clock;
  validators?: CompiledSchemaValidators;
}

export interface PatchPlan {
  projectRoot: string;
  memoryRoot: string;
  source: Source;
  changes: NormalizedPatchChange[];
  fileWrites: PatchPlannedFileWrite[];
  fileDeletes: PatchPlannedFileDelete[];
  eventAppends: PatchPlannedEventAppend[];
  touchedFiles: string[];
  files_changed: string[];
  memory_created: ObjectId[];
  memory_updated: ObjectId[];
  memory_deleted: ObjectId[];
  relations_created: RelationId[];
  relations_updated: RelationId[];
  relations_deleted: RelationId[];
  events_appended: number;
  recovery_files: PatchRecoveryFile[];
  repairs_applied: string[];
}

export type PatchPlannedFileWriteKind = "object_body" | "object_sidecar" | "relation";
export type PatchPlannedFileDeleteKind = "object_body" | "object_sidecar" | "relation";
export type PatchRecoveryReason = "dirty_overwrite" | "dirty_delete" | "repair_quarantine";

export interface PatchRecoveryFile {
  path: string;
  recovery_path: string;
  reason: PatchRecoveryReason;
}

export interface PatchPlannedFileWrite {
  path: string;
  kind: PatchPlannedFileWriteKind;
  operation: PatchOperation;
  id?: ObjectId;
  relationId?: RelationId;
}

export interface PatchPlannedFileDelete {
  path: string;
  kind: PatchPlannedFileDeleteKind;
  operation: PatchOperation;
  id?: ObjectId;
  relationId?: RelationId;
}

export interface PatchPlannedEventAppend {
  path: typeof EVENTS_PATH;
  operation: PatchOperation;
  actor: Actor;
  timestamp: IsoDateTime;
  id?: ObjectId;
  relationId?: RelationId;
  reason?: string;
}

export type NormalizedPatchChange =
  | NormalizedCreateObjectChange
  | NormalizedUpdateObjectChange
  | NormalizedMarkStaleChange
  | NormalizedSupersedeObjectChange
  | NormalizedDeleteObjectChange
  | NormalizedCreateRelationChange
  | NormalizedUpdateRelationChange
  | NormalizedDeleteRelationChange;

export interface NormalizedCreateObjectChange {
  op: "create_object";
  id: ObjectId;
  type: ObjectType;
  status: ObjectStatus;
  title: string;
  body: string;
  stage?: FeatureStage;
  anchors?: string[];
  tags: string[];
  evidence: Evidence[];
  source: Source;
  origin?: SourceOrigin;
  path: string;
  bodyPath: string;
}

export interface NormalizedUpdateObjectChange {
  op: "update_object";
  id: ObjectId;
  path: string;
  bodyPath: string;
  status?: ObjectStatus;
  title?: string;
  body?: string;
  stage?: FeatureStage;
  anchors?: string[];
  tags?: string[];
  evidence?: Evidence[];
  source?: Source;
  origin?: SourceOrigin;
  superseded_by?: ObjectId;
}

export interface NormalizedMarkStaleChange {
  op: "mark_stale";
  id: ObjectId;
  reason: string;
  path: string;
}

export interface NormalizedSupersedeObjectChange {
  op: "supersede_object";
  id: ObjectId;
  superseded_by: ObjectId;
  reason: string;
  path: string;
}

export interface NormalizedDeleteObjectChange {
  op: "delete_object";
  id: ObjectId;
  path: string;
  bodyPath: string;
}

export interface NormalizedCreateRelationChange {
  op: "create_relation";
  id: RelationId;
  from: ObjectId;
  predicate: Predicate;
  to: ObjectId;
  status: RelationStatus;
  path: string;
  createdAt: IsoDateTime;
  confidence?: RelationConfidence;
  evidence?: Evidence[];
}

export interface NormalizedUpdateRelationChange {
  op: "update_relation";
  id: RelationId;
  path: string;
  status?: RelationStatus;
  confidence?: RelationConfidence;
  evidence?: Evidence[];
}

export interface NormalizedDeleteRelationChange {
  op: "delete_relation";
  id: RelationId;
  path: string;
}

interface RawMemoryPatch {
  source: Source;
  changes: RawPatchChange[];
}

type RawPatchChange =
  | RawCreateObjectChange
  | RawUpdateObjectChange
  | RawMarkStaleChange
  | RawSupersedeObjectChange
  | RawDeleteObjectChange
  | RawCreateRelationChange
  | RawUpdateRelationChange
  | RawDeleteRelationChange;

interface RawCreateObjectChange {
  op: "create_object";
  id?: ObjectId;
  type: ObjectType;
  status?: ObjectStatus;
  title: string;
  body: string;
  stage?: FeatureStage;
  anchors?: string[];
  tags?: string[];
  evidence?: Evidence[];
  source?: Source;
  origin?: SourceOrigin;
}

interface RawUpdateObjectChange {
  op: "update_object";
  id: ObjectId;
  status?: ObjectStatus;
  title?: string;
  body?: string;
  stage?: FeatureStage;
  anchors?: string[];
  tags?: string[];
  evidence?: Evidence[];
  source?: Source;
  origin?: SourceOrigin;
  superseded_by?: ObjectId;
}

interface RawMarkStaleChange {
  op: "mark_stale";
  id: ObjectId;
  reason: string;
}

interface RawSupersedeObjectChange {
  op: "supersede_object";
  id: ObjectId;
  superseded_by: ObjectId;
  reason: string;
}

interface RawDeleteObjectChange {
  op: "delete_object";
  id: ObjectId;
}

interface RawCreateRelationChange {
  op: "create_relation";
  id?: RelationId;
  from: ObjectId;
  predicate: Predicate;
  to: ObjectId;
  status?: RelationStatus;
  confidence?: RelationConfidence;
  evidence?: Evidence[];
}

interface RawUpdateRelationChange {
  op: "update_relation";
  id: RelationId;
  status?: RelationStatus;
  confidence?: RelationConfidence;
  evidence?: Evidence[];
}

interface RawDeleteRelationChange {
  op: "delete_relation";
  id: RelationId;
}

interface ObjectPlanningRecord {
  id: ObjectId;
  type: ObjectType;
  status: ObjectStatus;
  path: string;
  bodyPath: string;
}

interface RelationPlanningRecord {
  id: RelationId;
  from: ObjectId;
  predicate: Predicate;
  to: ObjectId;
  status: RelationStatus;
  path: string;
}

interface PlanningState {
  snapshot: CanonicalStorageSnapshot;
  source: Source;
  git: GitState;
  timestamp: IsoDateTime;
  objectsById: Map<ObjectId, ObjectPlanningRecord>;
  relationsById: Map<RelationId, RelationPlanningRecord>;
  reservedObjectIds: Set<ObjectId>;
  reservedRelationIds: Set<RelationId>;
  existingPaths: Set<string>;
  createPaths: Set<string>;
  fileWrites: PatchPlannedFileWrite[];
  fileDeletes: PatchPlannedFileDelete[];
  eventAppends: PatchPlannedEventAppend[];
  normalizedChanges: NormalizedPatchChange[];
  touchedFiles: Set<string>;
  memoryCreated: ObjectId[];
  memoryUpdated: ObjectId[];
  memoryDeleted: ObjectId[];
  relationsCreated: RelationId[];
  relationsUpdated: RelationId[];
  relationsDeleted: RelationId[];
  recoveryFiles: PatchRecoveryFile[];
  warnings: string[];
}

interface ObjectPaths {
  sidecarPath: string;
  bodyPath: string;
}

interface UnknownOperation {
  op: string;
  index: number;
}

export async function planMemoryPatch(
  options: PlanMemoryPatchOptions
): Promise<Result<PatchPlan>> {
  const projectRoot = resolve(options.projectRoot);
  const unknownOperation = findUnknownOperation(options.patch);

  if (unknownOperation !== null) {
    return err(
      memoryError("MemoryUnknownPatchOperation", "Unknown patch operation.", {
        op: unknownOperation.op,
        path: PATCH_PATH,
        field: `/changes/${unknownOperation.index}/op`
      })
    );
  }

  const validators = await getValidators(projectRoot, options.validators);

  if (!validators.ok) {
    return validators;
  }

  const patchValidation = validatePatch(validators.data, options.patch, PATCH_PATH);

  if (!patchValidation.valid) {
    return err(schemaValidationError(patchValidation.errors));
  }

  const storage = await readCanonicalStorage(projectRoot, {
    validators: validators.data
  });

  if (!storage.ok) {
    return storage;
  }

  const patch = options.patch as RawMemoryPatch;
  const state = createPlanningState(storage.data, patch.source, options.git, options.clock.nowIso());

  for (const [index, change] of patch.changes.entries()) {
    const planned = await planChange(state, change, index);

    if (!planned.ok) {
      if (isPartialRecoverablePlanningError(planned.error.code, change)) {
        state.warnings.push(
          `Skipped memory patch change ${index}: ${planned.error.message}`
        );
        continue;
      }

      return planned;
    }
  }

  const dirtyCheck = await recordDirtyTouchedRecoveries(projectRoot, state, options);

  if (!dirtyCheck.ok) {
    return dirtyCheck;
  }

  return ok(buildPlan(state), [...storage.warnings, ...state.warnings, ...dirtyCheck.warnings]);
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

function createPlanningState(
  snapshot: CanonicalStorageSnapshot,
  source: Source,
  git: GitState,
  timestamp: IsoDateTime
): PlanningState {
  const objectsById = new Map<ObjectId, ObjectPlanningRecord>();
  const relationsById = new Map<RelationId, RelationPlanningRecord>();
  const reservedObjectIds = new Set<ObjectId>();
  const reservedRelationIds = new Set<RelationId>();
  const existingPaths = new Set<string>([".memory/config.json", EVENTS_PATH]);

  for (const object of snapshot.objects) {
    const record = objectRecordFromStoredObject(object);
    objectsById.set(record.id, record);
    reservedObjectIds.add(record.id);
    existingPaths.add(record.path);
    existingPaths.add(record.bodyPath);
  }

  for (const relation of snapshot.relations) {
    const record = relationRecordFromStoredRelation(relation);
    relationsById.set(record.id, record);
    reservedRelationIds.add(record.id);
    existingPaths.add(record.path);
  }

  return {
    snapshot,
    source,
    git,
    timestamp,
    objectsById,
    relationsById,
    reservedObjectIds,
    reservedRelationIds,
    existingPaths,
    createPaths: new Set<string>(),
    fileWrites: [],
    fileDeletes: [],
    eventAppends: [],
    normalizedChanges: [],
    touchedFiles: new Set<string>(),
    memoryCreated: [],
    memoryUpdated: [],
    memoryDeleted: [],
    relationsCreated: [],
    relationsUpdated: [],
    relationsDeleted: [],
    recoveryFiles: [],
    warnings: []
  };
}

function isPartialRecoverablePlanningError(
  code: MemoryErrorCode,
  change: RawPatchChange
): boolean {
  if (code !== "MemoryObjectNotFound" && code !== "MemoryRelationNotFound") {
    return false;
  }

  return (
    change.op === "update_object" ||
    change.op === "mark_stale" ||
    change.op === "supersede_object" ||
    change.op === "delete_object" ||
    change.op === "update_relation" ||
    change.op === "delete_relation"
  );
}

function objectRecordFromStoredObject(object: StoredMemoryObject): ObjectPlanningRecord {
  return {
    id: object.sidecar.id,
    type: object.sidecar.type,
    status: object.sidecar.status,
    path: object.path,
    bodyPath: object.bodyPath
  };
}

function relationRecordFromStoredRelation(
  storedRelation: StoredMemoryRelation
): RelationPlanningRecord {
  const relation = storedRelation.relation;

  return {
    id: relation.id,
    from: relation.from,
    predicate: relation.predicate,
    to: relation.to,
    status: relation.status,
    path: storedRelation.path
  };
}

async function planChange(
  state: PlanningState,
  change: RawPatchChange,
  index: number
): Promise<Result<void>> {
  switch (change.op) {
    case "create_object":
      return planCreateObject(state, change, index);
    case "update_object":
      return planUpdateObject(state, change, index);
    case "mark_stale":
      return planMarkStale(state, change, index);
    case "supersede_object":
      return planSupersedeObject(state, change, index);
    case "delete_object":
      return planDeleteObject(state, change, index);
    case "create_relation":
      return planCreateRelation(state, change, index);
    case "update_relation":
      return planUpdateRelation(state, change, index);
    case "delete_relation":
      return planDeleteRelation(state, change, index);
  }
}

async function planCreateObject(
  state: PlanningState,
  change: RawCreateObjectChange,
  index: number
): Promise<Result<void>> {
  const id =
    change.id ??
    generateObjectId({
      type: change.type,
      title: change.title,
      existingIds: state.reservedObjectIds
    });

  if (state.reservedObjectIds.has(id)) {
    return duplicateId(id, `/changes/${index}/id`);
  }

  if (objectIdType(id) !== change.type) {
    return patchInvalid("Object id prefix must match object type.", {
      code: "ObjectIdTypeMismatch",
      message: "Object id prefix must match object type.",
      path: PATCH_PATH,
      field: `/changes/${index}/id`
    });
  }

  const status = change.status ?? defaultObjectStatus(change.type);
  const statusValidation = validateObjectStatus(change.type, status, `/changes/${index}/status`);

  if (!statusValidation.ok) {
    return statusValidation;
  }

  const stageValidation = validateObjectStage(change.type, change.stage, `/changes/${index}/stage`);

  if (!stageValidation.ok) {
    return stageValidation;
  }

  const anchors = normalizeChangeAnchors(change.anchors, `/changes/${index}/anchors`);

  if (!anchors.ok) {
    return anchors;
  }

  const paths = objectPaths(change.type, id);
  const pathValidation = await ensureCreatePathsAvailable(state, [
    paths.sidecarPath,
    paths.bodyPath
  ]);

  if (!pathValidation.ok) {
    return pathValidation;
  }

  const source = change.source ?? state.source;
  const normalized: NormalizedCreateObjectChange = {
    op: "create_object",
    id,
    type: change.type,
    status,
    title: change.title,
    body: change.body,
    ...(change.stage === undefined ? {} : { stage: change.stage }),
    ...(anchors.data === undefined ? {} : { anchors: anchors.data }),
    tags: change.tags ?? [],
    evidence: change.evidence ?? [],
    source,
    ...(change.origin === undefined ? {} : { origin: change.origin }),
    path: paths.sidecarPath,
    bodyPath: paths.bodyPath
  };

  state.normalizedChanges.push(normalized);
  state.objectsById.set(id, {
    id,
    type: change.type,
    status,
    path: paths.sidecarPath,
    bodyPath: paths.bodyPath
  });
  state.reservedObjectIds.add(id);
  recordWrite(state, {
    path: paths.bodyPath,
    kind: "object_body",
    operation: "create_object",
    id
  });
  recordWrite(state, {
    path: paths.sidecarPath,
    kind: "object_sidecar",
    operation: "create_object",
    id
  });
  recordEvent(state, {
    path: EVENTS_PATH,
    operation: "create_object",
    actor: state.source.kind,
    timestamp: state.timestamp,
    id
  });
  pushUnique(state.memoryCreated, id);

  return ok(undefined);
}

function planUpdateObject(
  state: PlanningState,
  change: RawUpdateObjectChange,
  index: number
): Result<void> {
  const object = state.objectsById.get(change.id);

  if (object === undefined) {
    return objectNotFound(change.id, `/changes/${index}/id`);
  }

  if (change.status !== undefined) {
    const statusValidation = validateObjectStatus(
      object.type,
      change.status,
      `/changes/${index}/status`
    );

    if (!statusValidation.ok) {
      return statusValidation;
    }
  }

  const stageValidation = validateObjectStage(object.type, change.stage, `/changes/${index}/stage`);

  if (!stageValidation.ok) {
    return stageValidation;
  }

  const anchors = normalizeChangeAnchors(change.anchors, `/changes/${index}/anchors`);

  if (!anchors.ok) {
    return anchors;
  }

  if (change.superseded_by !== undefined && !state.objectsById.has(change.superseded_by)) {
    return objectNotFound(change.superseded_by, `/changes/${index}/superseded_by`);
  }

  const normalized: NormalizedUpdateObjectChange = {
    op: "update_object",
    id: change.id,
    path: object.path,
    bodyPath: object.bodyPath,
    ...(change.status === undefined ? {} : { status: change.status }),
    ...(change.title === undefined ? {} : { title: change.title }),
    ...(change.body === undefined ? {} : { body: change.body }),
    ...(change.stage === undefined ? {} : { stage: change.stage }),
    ...(anchors.data === undefined ? {} : { anchors: anchors.data }),
    ...(change.tags === undefined ? {} : { tags: change.tags }),
    ...(change.evidence === undefined ? {} : { evidence: change.evidence }),
    ...(change.source === undefined ? {} : { source: change.source }),
    ...(change.origin === undefined ? {} : { origin: change.origin }),
    ...(change.superseded_by === undefined ? {} : { superseded_by: change.superseded_by })
  };
  const touchesBody = change.body !== undefined;
  const touchesSidecar =
    touchesBody ||
    change.status !== undefined ||
    change.title !== undefined ||
    change.stage !== undefined ||
    change.anchors !== undefined ||
    change.tags !== undefined ||
    change.evidence !== undefined ||
    change.source !== undefined ||
    change.origin !== undefined ||
    change.superseded_by !== undefined;

  state.normalizedChanges.push(normalized);

  if (change.status !== undefined) {
    object.status = change.status;
  }

  if (touchesBody) {
    recordWrite(state, {
      path: object.bodyPath,
      kind: "object_body",
      operation: "update_object",
      id: change.id
    });
  }

  if (touchesSidecar) {
    recordWrite(state, {
      path: object.path,
      kind: "object_sidecar",
      operation: "update_object",
      id: change.id
    });
    recordEvent(state, {
      path: EVENTS_PATH,
      operation: "update_object",
      actor: state.source.kind,
      timestamp: state.timestamp,
      id: change.id
    });
    pushUnique(state.memoryUpdated, change.id);
  }

  return ok(undefined);
}

function planMarkStale(
  state: PlanningState,
  change: RawMarkStaleChange,
  index: number
): Result<void> {
  const object = state.objectsById.get(change.id);

  if (object === undefined) {
    return objectNotFound(change.id, `/changes/${index}/id`);
  }

  state.normalizedChanges.push({
    op: "mark_stale",
    id: change.id,
    reason: change.reason,
    path: object.path
  });
  object.status = "stale";
  recordWrite(state, {
    path: object.path,
    kind: "object_sidecar",
    operation: "mark_stale",
    id: change.id
  });
  recordEvent(state, {
    path: EVENTS_PATH,
    operation: "mark_stale",
    actor: state.source.kind,
    timestamp: state.timestamp,
    id: change.id,
    reason: change.reason
  });
  pushUnique(state.memoryUpdated, change.id);

  return ok(undefined);
}

async function planSupersedeObject(
  state: PlanningState,
  change: RawSupersedeObjectChange,
  index: number
): Promise<Result<void>> {
  const object = state.objectsById.get(change.id);

  if (object === undefined) {
    return objectNotFound(change.id, `/changes/${index}/id`);
  }

  if (change.id === change.superseded_by) {
    return patchInvalid("Object cannot supersede itself.", {
      code: "ObjectSupersedesSelf",
      message: "Object cannot supersede itself.",
      path: PATCH_PATH,
      field: `/changes/${index}/superseded_by`
    });
  }

  if (!state.objectsById.has(change.superseded_by)) {
    return objectNotFound(change.superseded_by, `/changes/${index}/superseded_by`);
  }

  state.normalizedChanges.push({
    op: "supersede_object",
    id: change.id,
    superseded_by: change.superseded_by,
    reason: change.reason,
    path: object.path
  });
  object.status = "superseded";
  recordWrite(state, {
    path: object.path,
    kind: "object_sidecar",
    operation: "supersede_object",
    id: change.id
  });
  recordEvent(state, {
    path: EVENTS_PATH,
    operation: "supersede_object",
    actor: state.source.kind,
    timestamp: state.timestamp,
    id: change.id,
    reason: change.reason
  });
  pushUnique(state.memoryUpdated, change.id);

  const relation = await planSupersedesRelation(state, change.superseded_by, change.id);

  if (!relation.ok) {
    return relation;
  }

  return ok(undefined);
}

async function planSupersedesRelation(
  state: PlanningState,
  replacementId: ObjectId,
  supersededId: ObjectId
): Promise<Result<void>> {
  if (findEquivalentRelation(state, replacementId, "supersedes", supersededId) !== null) {
    return ok(undefined);
  }

  const id = generateRelationId({
    from: replacementId,
    predicate: "supersedes",
    to: supersededId,
    existingIds: state.reservedRelationIds
  });
  const path = relationPath(id);
  const pathValidation = await ensureCreatePathsAvailable(state, [path]);

  if (!pathValidation.ok) {
    return pathValidation;
  }

  state.normalizedChanges.push({
    op: "create_relation",
    id,
    from: replacementId,
    predicate: "supersedes",
    to: supersededId,
    status: "active",
    path,
    createdAt: state.timestamp
  });
  state.relationsById.set(id, {
    id,
    from: replacementId,
    predicate: "supersedes",
    to: supersededId,
    status: "active",
    path
  });
  state.reservedRelationIds.add(id);
  recordWrite(state, {
    path,
    kind: "relation",
    operation: "create_relation",
    relationId: id
  });
  pushUnique(state.relationsCreated, id);

  return ok(undefined);
}

function planDeleteObject(
  state: PlanningState,
  change: RawDeleteObjectChange,
  index: number
): Result<void> {
  const object = state.objectsById.get(change.id);

  if (object === undefined) {
    return objectNotFound(change.id, `/changes/${index}/id`);
  }

  const blockingRelation = findActiveRelationForObject(state, change.id);

  if (blockingRelation !== null) {
    return invalidRelation("Object is still referenced by an active relation.", {
      id: change.id,
      relationId: blockingRelation.id,
      field: `/changes/${index}/id`
    });
  }

  state.normalizedChanges.push({
    op: "delete_object",
    id: change.id,
    path: object.path,
    bodyPath: object.bodyPath
  });
  state.objectsById.delete(change.id);
  recordDelete(state, {
    path: object.bodyPath,
    kind: "object_body",
    operation: "delete_object",
    id: change.id
  });
  recordDelete(state, {
    path: object.path,
    kind: "object_sidecar",
    operation: "delete_object",
    id: change.id
  });
  recordEvent(state, {
    path: EVENTS_PATH,
    operation: "delete_object",
    actor: state.source.kind,
    timestamp: state.timestamp,
    id: change.id
  });
  pushUnique(state.memoryDeleted, change.id);

  return ok(undefined);
}

async function planCreateRelation(
  state: PlanningState,
  change: RawCreateRelationChange,
  index: number
): Promise<Result<void>> {
  const fromValidation = requireObjectEndpoint(state, change.from, `/changes/${index}/from`);

  if (!fromValidation.ok) {
    return fromValidation;
  }

  const toValidation = requireObjectEndpoint(state, change.to, `/changes/${index}/to`);

  if (!toValidation.ok) {
    return toValidation;
  }

  if (findEquivalentRelation(state, change.from, change.predicate, change.to) !== null) {
    return invalidRelation("Equivalent relation already exists.", {
      id: change.id ?? null,
      field: `/changes/${index}`
    });
  }

  const id =
    change.id ??
    generateRelationId({
      from: change.from,
      predicate: change.predicate,
      to: change.to,
      existingIds: state.reservedRelationIds
    });

  if (state.reservedRelationIds.has(id)) {
    return duplicateId(id, `/changes/${index}/id`);
  }

  const path = relationPath(id);
  const pathValidation = await ensureCreatePathsAvailable(state, [path]);

  if (!pathValidation.ok) {
    return pathValidation;
  }

  const status = change.status ?? "active";
  const normalized: NormalizedCreateRelationChange = {
    op: "create_relation",
    id,
    from: change.from,
    predicate: change.predicate,
    to: change.to,
    status,
    path,
    createdAt: state.timestamp,
    ...(change.confidence === undefined ? {} : { confidence: change.confidence }),
    ...(change.evidence === undefined ? {} : { evidence: change.evidence })
  };

  state.normalizedChanges.push(normalized);
  state.relationsById.set(id, {
    id,
    from: change.from,
    predicate: change.predicate,
    to: change.to,
    status,
    path
  });
  state.reservedRelationIds.add(id);
  recordWrite(state, {
    path,
    kind: "relation",
    operation: "create_relation",
    relationId: id
  });
  recordEvent(state, {
    path: EVENTS_PATH,
    operation: "create_relation",
    actor: state.source.kind,
    timestamp: state.timestamp,
    relationId: id
  });
  pushUnique(state.relationsCreated, id);

  return ok(undefined);
}

function planUpdateRelation(
  state: PlanningState,
  change: RawUpdateRelationChange,
  index: number
): Result<void> {
  const relation = state.relationsById.get(change.id);

  if (relation === undefined) {
    return relationNotFound(change.id, `/changes/${index}/id`);
  }

  const touchesRelation =
    change.status !== undefined ||
    change.confidence !== undefined ||
    change.evidence !== undefined;
  const normalized: NormalizedUpdateRelationChange = {
    op: "update_relation",
    id: change.id,
    path: relation.path,
    ...(change.status === undefined ? {} : { status: change.status }),
    ...(change.confidence === undefined ? {} : { confidence: change.confidence }),
    ...(change.evidence === undefined ? {} : { evidence: change.evidence })
  };

  state.normalizedChanges.push(normalized);

  if (change.status !== undefined) {
    relation.status = change.status;
  }

  if (touchesRelation) {
    recordWrite(state, {
      path: relation.path,
      kind: "relation",
      operation: "update_relation",
      relationId: change.id
    });
    recordEvent(state, {
      path: EVENTS_PATH,
      operation: "update_relation",
      actor: state.source.kind,
      timestamp: state.timestamp,
      relationId: change.id
    });
    pushUnique(state.relationsUpdated, change.id);
  }

  return ok(undefined);
}

function planDeleteRelation(
  state: PlanningState,
  change: RawDeleteRelationChange,
  index: number
): Result<void> {
  const relation = state.relationsById.get(change.id);

  if (relation === undefined) {
    return relationNotFound(change.id, `/changes/${index}/id`);
  }

  state.normalizedChanges.push({
    op: "delete_relation",
    id: change.id,
    path: relation.path
  });
  state.relationsById.delete(change.id);
  recordDelete(state, {
    path: relation.path,
    kind: "relation",
    operation: "delete_relation",
    relationId: change.id
  });
  recordEvent(state, {
    path: EVENTS_PATH,
    operation: "delete_relation",
    actor: state.source.kind,
    timestamp: state.timestamp,
    relationId: change.id
  });
  pushUnique(state.relationsDeleted, change.id);

  return ok(undefined);
}

async function ensureCreatePathsAvailable(
  state: PlanningState,
  paths: readonly string[]
): Promise<Result<void>> {
  for (const path of paths) {
    if (state.existingPaths.has(path) || state.createPaths.has(path)) {
      return patchInvalid("Patch would overwrite an existing canonical path.", {
        code: "PatchPathConflict",
        message: "Patch would overwrite an existing canonical path.",
        path,
        field: null
      });
    }

    const exists = await pathExists(state.snapshot.projectRoot, path);

    if (exists) {
      return patchInvalid("Patch would overwrite an existing canonical path.", {
        code: "PatchPathConflict",
        message: "Patch would overwrite an existing canonical path.",
        path,
        field: null
      });
    }
  }

  for (const path of paths) {
    state.createPaths.add(path);
  }

  return ok(undefined);
}

async function pathExists(projectRoot: string, path: string): Promise<boolean> {
  return (await lstat(resolve(projectRoot, path)).catch(() => null)) !== null;
}

async function recordDirtyTouchedRecoveries(
  projectRoot: string,
  state: PlanningState,
  options: GitWrapperOptions
): Promise<Result<void>> {
  if (!state.git.available) {
    return ok(undefined);
  }

  const dirtyState = await getMemoryDirtyState(projectRoot, options);

  if (!dirtyState.ok) {
    return dirtyState;
  }

  const dirtyTouchedFiles = dirtyState.data.files.filter((file) => state.touchedFiles.has(file));

  if (dirtyTouchedFiles.length === 0) {
    return ok(undefined);
  }

  const trackedDirtyTouchedFiles = await filterTrackedFiles(
    projectRoot,
    dirtyTouchedFiles,
    options
  );

  if (!trackedDirtyTouchedFiles.ok) {
    return trackedDirtyTouchedFiles;
  }

  const trackedDirtyOverwriteFiles = trackedDirtyTouchedFiles.data.filter(
    (file) => !isAppendOnlyDirtyTouch(state, file)
  );

  state.recoveryFiles.push(
    ...trackedDirtyOverwriteFiles.map((file) => ({
      path: file,
      recovery_path: recoveryPathForDirtyFile(state.timestamp, file),
      reason: dirtyRecoveryReason(state, file)
    }))
  );

  return ok(
    undefined,
    trackedDirtyOverwriteFiles.map(
      (file) => `Dirty Memory file will be backed up before save: ${file}`
    )
  );
}

function isAppendOnlyDirtyTouch(state: PlanningState, path: string): boolean {
  return (
    path === EVENTS_PATH &&
    state.eventAppends.some((event) => event.path === path) &&
    state.fileWrites.every((write) => write.path !== path) &&
    state.fileDeletes.every((deletion) => deletion.path !== path)
  );
}

function dirtyRecoveryReason(state: PlanningState, path: string): PatchRecoveryReason {
  return state.fileDeletes.some((deletion) => deletion.path === path)
    ? "dirty_delete"
    : "dirty_overwrite";
}

export function recoveryPathForDirtyFile(timestamp: IsoDateTime, path: string): string {
  const safeTimestamp = timestamp.replace(/[^0-9A-Za-z.-]/g, "-");
  const relativePath = path.startsWith(".memory/") ? path.slice(".memory/".length) : path;

  return `.memory/recovery/${safeTimestamp}/${relativePath}`;
}

function buildPlan(state: PlanningState): PatchPlan {
  const touchedFiles = sortedValues(state.touchedFiles);

  return {
    projectRoot: state.snapshot.projectRoot,
    memoryRoot: state.snapshot.memoryRoot,
    source: state.source,
    changes: state.normalizedChanges,
    fileWrites: state.fileWrites,
    fileDeletes: state.fileDeletes,
    eventAppends: state.eventAppends,
    touchedFiles,
    files_changed: touchedFiles,
    memory_created: state.memoryCreated,
    memory_updated: state.memoryUpdated,
    memory_deleted: state.memoryDeleted,
    relations_created: state.relationsCreated,
    relations_updated: state.relationsUpdated,
    relations_deleted: state.relationsDeleted,
    events_appended: state.eventAppends.length,
    recovery_files: state.recoveryFiles,
    repairs_applied: []
  };
}

function recordWrite(state: PlanningState, write: PatchPlannedFileWrite): void {
  state.fileWrites.push(write);
  state.touchedFiles.add(write.path);
}

function recordDelete(state: PlanningState, deletion: PatchPlannedFileDelete): void {
  state.fileDeletes.push(deletion);
  state.touchedFiles.add(deletion.path);
}

function recordEvent(state: PlanningState, event: PatchPlannedEventAppend): void {
  state.eventAppends.push(event);
  state.touchedFiles.add(event.path);
}

function pushUnique<T>(values: T[], value: T): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function objectPaths(type: ObjectType, id: ObjectId): ObjectPaths {
  const idSlug = slugFromObjectId(id);
  const basename = type === "project" ? type : `${objectDirectory(type)}/${idSlug}`;

  return {
    sidecarPath: `.memory/memory/${basename}.json`,
    bodyPath: `.memory/memory/${basename}.md`
  };
}

function objectDirectory(type: ObjectType): string {
  switch (type) {
    case "project":
      return type;
    case "feature":
      return "features";
    case "decision":
      return "decisions";
    case "gotcha":
      return "gotchas";
    case "question":
      return "questions";
  }
}

function relationPath(id: RelationId): string {
  return `.memory/relations/${id.slice("rel.".length)}.json`;
}

function objectIdType(id: ObjectId): string {
  return id.slice(0, id.indexOf("."));
}

function slugFromObjectId(id: ObjectId): string {
  const separatorIndex = id.indexOf(".");
  const slug = separatorIndex === -1 ? id : id.slice(separatorIndex + 1);

  return slugify(slug);
}

function defaultObjectStatus(type: ObjectType): ObjectStatus {
  return type === "question" ? "open" : "active";
}

function validateObjectStatus(
  type: ObjectType,
  status: ObjectStatus,
  field: string
): Result<void> {
  const allowedStatuses = type === "question" ? QUESTION_STATUSES : NON_QUESTION_STATUSES;

  if (allowedStatuses.has(status)) {
    return ok(undefined);
  }

  return patchInvalid("Object status is not allowed for this object type.", {
    code: "ObjectStatusInvalid",
    message: "Object status is not allowed for this object type.",
    path: PATCH_PATH,
    field
  });
}

function validateObjectStage(
  type: ObjectType,
  stage: FeatureStage | undefined,
  field: string
): Result<void> {
  if (stage === undefined) {
    return ok(undefined);
  }

  if (type !== "feature") {
    return patchInvalid("Stage is only allowed on feature objects.", {
      code: "ObjectStageInvalid",
      message: "Stage is only allowed on feature objects.",
      path: PATCH_PATH,
      field
    });
  }

  if (!FEATURE_STAGE_SET.has(stage)) {
    return patchInvalid("Feature stage is not supported.", {
      code: "ObjectStageInvalid",
      message: "Feature stage is not supported.",
      path: PATCH_PATH,
      field
    });
  }

  return ok(undefined);
}

function normalizeChangeAnchors(
  anchors: readonly string[] | undefined,
  field: string
): Result<string[] | undefined> {
  if (anchors === undefined) {
    return ok(undefined);
  }

  const validated = validateAnchors(anchors, field);

  if (!validated.ok) {
    return validated;
  }

  return ok(validated.data);
}

function requireObjectEndpoint(
  state: PlanningState,
  id: ObjectId,
  field: string
): Result<void> {
  if (state.objectsById.has(id)) {
    return ok(undefined);
  }

  return objectNotFound(id, field);
}

function findEquivalentRelation(
  state: PlanningState,
  from: ObjectId,
  predicate: Predicate,
  to: ObjectId
): RelationPlanningRecord | null {
  for (const relation of state.relationsById.values()) {
    if (relation.from === from && relation.predicate === predicate && relation.to === to) {
      return relation;
    }
  }

  return null;
}

function findActiveRelationForObject(
  state: PlanningState,
  id: ObjectId
): RelationPlanningRecord | null {
  for (const relation of state.relationsById.values()) {
    if (relation.status === "active" && (relation.from === id || relation.to === id)) {
      return relation;
    }
  }

  return null;
}

function findUnknownOperation(value: unknown): UnknownOperation | null {
  if (!isRecord(value) || !Array.isArray(value.changes)) {
    return null;
  }

  for (const [index, change] of value.changes.entries()) {
    if (!isRecord(change)) {
      continue;
    }

    const operation = change.op;

    if (typeof operation === "string" && !PATCH_OPERATION_SET.has(operation)) {
      return {
        op: operation,
        index
      };
    }
  }

  return null;
}

function objectNotFound<T>(id: ObjectId, field: string): Result<T> {
  return codeError("MemoryObjectNotFound", "Memory object was not found.", {
    id,
    field
  });
}

function relationNotFound<T>(id: RelationId, field: string): Result<T> {
  return codeError("MemoryRelationNotFound", "Memory relation was not found.", {
    id,
    field
  });
}

function duplicateId<T>(id: string, field: string): Result<T> {
  return codeError("MemoryDuplicateId", "Patch would create a duplicate canonical id.", {
    id,
    field
  });
}

function invalidRelation<T>(
  message: string,
  details: {
    id: string | null;
    field: string;
    relationId?: RelationId;
  }
): Result<T> {
  return err(
    memoryError("MemoryInvalidRelation", message, {
      path: PATCH_PATH,
      id: details.id,
      field: details.field,
      ...(details.relationId === undefined ? {} : { relation_id: details.relationId })
    })
  );
}

function codeError<T>(
  code: MemoryErrorCode,
  message: string,
  details: {
    id: string;
    field: string;
  }
): Result<T> {
  return err(
    memoryError(code, message, {
      path: PATCH_PATH,
      id: details.id,
      field: details.field
    })
  );
}

function patchInvalid<T>(message: string, issue: ValidationIssue): Result<T> {
  return err(memoryError("MemoryPatchInvalid", message, validationIssuesDetails([issue])));
}

function validationIssuesDetails(issues: readonly ValidationIssue[]) {
  return {
    issues: issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.path,
      field: issue.field
    }))
  };
}

function sortedValues(values: Iterable<string>): string[] {
  return [...values].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

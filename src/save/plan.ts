import { memoryError, type JsonValue } from "../core/errors.js";
import { generateObjectId, isObjectId } from "../core/ids.js";
import { err, ok, type Result } from "../core/result.js";
import type {
  Evidence,
  FeatureStage,
  ObjectId,
  ObjectType,
  Predicate,
  RelationConfidence
} from "../core/types.js";
import {
  FEATURE_STAGES,
  PREDICATES,
  RELATION_CONFIDENCES
} from "../core/types.js";
import type { CanonicalStorageSnapshot } from "../storage/read.js";
import {
  SAVE_NODE_KINDS,
  type SaveDeleteInput,
  type SaveMemoryInput,
  type SaveNodeInput,
  type SaveNodeKind,
  type SaveRelatedInput,
  type SaveStaleInput,
  type SaveSupersedeInput
} from "./types.js";

type SavePatchChange =
  | SavePatchCreateObject
  | SavePatchUpdateObject
  | SavePatchMarkStale
  | SavePatchSupersedeObject
  | SavePatchDeleteObject
  | SavePatchCreateRelation;

interface SavePatchCreateObject {
  op: "create_object";
  id: ObjectId;
  type: ObjectType;
  title: string;
  body: string;
  stage?: FeatureStage;
  anchors?: string[];
  tags?: string[];
  evidence?: Evidence[];
}

interface SavePatchUpdateObject {
  op: "update_object";
  id: ObjectId;
  title?: string;
  body?: string;
  stage?: FeatureStage;
  anchors?: string[];
  tags?: string[];
  evidence?: Evidence[];
}

interface SavePatchMarkStale {
  op: "mark_stale";
  id: ObjectId;
  reason: string;
}

interface SavePatchSupersedeObject {
  op: "supersede_object";
  id: ObjectId;
  superseded_by: ObjectId;
  reason: string;
}

interface SavePatchDeleteObject {
  op: "delete_object";
  id: ObjectId;
}

interface SavePatchCreateRelation {
  op: "create_relation";
  from: ObjectId;
  predicate: Predicate;
  to: ObjectId;
  confidence?: RelationConfidence;
}

export interface SaveMemoryPatch {
  source: {
    kind: "agent";
    task: string;
  };
  changes: SavePatchChange[];
}

export interface BuildSaveMemoryPatchOptions {
  input: unknown;
  storage: CanonicalStorageSnapshot;
}

const SAVE_NODE_KIND_SET = new Set<string>(SAVE_NODE_KINDS);
const FEATURE_STAGE_SET = new Set<string>(FEATURE_STAGES);
const PREDICATE_SET = new Set<string>(PREDICATES);
const RELATION_CONFIDENCE_SET = new Set<string>(RELATION_CONFIDENCES);
const SAVE_INPUT_FIELDS = new Set(["task", "nodes", "stale", "supersede", "delete"]);
const SAVE_NODE_FIELDS = new Set([
  "id",
  "kind",
  "title",
  "body",
  "stage",
  "anchors",
  "tags",
  "evidence",
  "related"
]);
const SAVE_RELATED_FIELDS = new Set(["predicate", "to", "confidence"]);
const SAVE_STALE_FIELDS = new Set(["id", "reason"]);
const SAVE_SUPERSEDE_FIELDS = new Set(["id", "superseded_by", "reason"]);
const SAVE_DELETE_FIELDS = new Set(["id", "reason"]);

export function buildSaveMemoryPatch(
  options: BuildSaveMemoryPatchOptions
): Result<SaveMemoryPatch> {
  const input = parseSaveMemoryInput(options.input);

  if (!input.ok) {
    return input;
  }

  const objectTypesById = new Map<ObjectId, ObjectType>(
    options.storage.objects.map((object) => [object.sidecar.id, object.sidecar.type])
  );
  const reservedObjectIds = new Set<ObjectId>(objectTypesById.keys());
  const changes: SavePatchChange[] = [];

  for (const [index, node] of (input.data.nodes ?? []).entries()) {
    const compiled = compileNode(node, index, objectTypesById, reservedObjectIds);

    if (!compiled.ok) {
      return compiled;
    }

    changes.push(...compiled.data);
  }

  for (const stale of input.data.stale ?? []) {
    changes.push({
      op: "mark_stale",
      id: stale.id,
      reason: stale.reason
    });
  }

  for (const supersede of input.data.supersede ?? []) {
    changes.push({
      op: "supersede_object",
      id: supersede.id,
      superseded_by: supersede.superseded_by,
      reason: supersede.reason
    });
  }

  for (const deletion of input.data.delete ?? []) {
    changes.push({
      op: "delete_object",
      id: deletion.id
    });
  }

  if (changes.length === 0) {
    return invalidSaveInput("Save input must include at least one memory action.", {
      field: "nodes|stale|supersede|delete"
    });
  }

  return ok({
    source: {
      kind: "agent",
      task: input.data.task
    },
    changes
  });
}

function compileNode(
  node: SaveNodeInput,
  index: number,
  objectTypesById: ReadonlyMap<ObjectId, ObjectType>,
  reservedObjectIds: Set<ObjectId>
): Result<SavePatchChange[]> {
  const field = `nodes.${index}`;
  const existingType = node.id === undefined ? undefined : objectTypesById.get(node.id);

  if (node.id !== undefined && existingType !== undefined) {
    return compileUpdateNode(node, node.id, existingType, field);
  }

  return compileCreateNode(node, field, reservedObjectIds);
}

function compileUpdateNode(
  node: SaveNodeInput,
  id: ObjectId,
  existingType: ObjectType,
  field: string
): Result<SavePatchChange[]> {
  if (node.kind !== undefined && node.kind !== existingType) {
    return invalidSaveInput("Save node kind does not match the existing object type.", {
      field: `${field}.kind`,
      id,
      existing_type: existingType
    });
  }

  if (node.stage !== undefined && existingType !== "feature") {
    return invalidSaveInput("Stage is only allowed on feature objects.", {
      field: `${field}.stage`,
      id,
      existing_type: existingType
    });
  }

  const update: SavePatchUpdateObject = {
    op: "update_object",
    id,
    ...(node.title === undefined ? {} : { title: node.title }),
    ...(node.body === undefined ? {} : { body: node.body }),
    ...(node.stage === undefined ? {} : { stage: node.stage }),
    ...(node.anchors === undefined ? {} : { anchors: node.anchors }),
    ...(node.tags === undefined ? {} : { tags: node.tags }),
    ...(node.evidence === undefined ? {} : { evidence: node.evidence })
  };
  const touchesObject =
    node.title !== undefined ||
    node.body !== undefined ||
    node.stage !== undefined ||
    node.anchors !== undefined ||
    node.tags !== undefined ||
    node.evidence !== undefined;
  const related = node.related ?? [];

  if (!touchesObject && related.length === 0) {
    return invalidSaveInput(
      "Save node update must include at least one field to change or a related link.",
      {
        field,
        id
      }
    );
  }

  return ok([
    ...(touchesObject ? [update] : []),
    ...related.map((item) => relatedRelationChange(id, item))
  ]);
}

function compileCreateNode(
  node: SaveNodeInput,
  field: string,
  reservedObjectIds: Set<ObjectId>
): Result<SavePatchChange[]> {
  const kind = resolveCreateKind(node, field);

  if (!kind.ok) {
    return kind;
  }

  if (node.title === undefined) {
    return invalidSaveInput("Save node title is required when creating memory.", {
      field: `${field}.title`
    });
  }

  if (node.body === undefined) {
    return invalidSaveInput("Save node body is required when creating memory.", {
      field: `${field}.body`
    });
  }

  if (node.stage !== undefined && kind.data !== "feature") {
    return invalidSaveInput("Stage is only allowed on feature objects.", {
      field: `${field}.stage`,
      kind: kind.data
    });
  }

  const id =
    node.id ??
    generateObjectId({
      type: kind.data,
      title: node.title,
      existingIds: reservedObjectIds
    });

  if (node.id !== undefined && objectIdType(node.id) !== kind.data) {
    return invalidSaveInput("Save node id prefix must match the node kind.", {
      field: `${field}.id`,
      id: node.id,
      kind: kind.data
    });
  }

  reservedObjectIds.add(id);

  const create: SavePatchCreateObject = {
    op: "create_object",
    id,
    type: kind.data,
    title: node.title,
    body: node.body,
    ...(node.stage === undefined ? {} : { stage: node.stage }),
    ...(node.anchors === undefined ? {} : { anchors: node.anchors }),
    ...(node.tags === undefined ? {} : { tags: node.tags }),
    ...(node.evidence === undefined ? {} : { evidence: node.evidence })
  };

  return ok([
    create,
    ...(node.related ?? []).map((item) => relatedRelationChange(id, item))
  ]);
}

function resolveCreateKind(node: SaveNodeInput, field: string): Result<SaveNodeKind> {
  if (node.kind !== undefined) {
    if (node.id !== undefined && objectIdType(node.id) !== node.kind) {
      return invalidSaveInput("Save node id prefix must match the node kind.", {
        field: `${field}.id`,
        id: node.id,
        kind: node.kind
      });
    }

    return ok(node.kind);
  }

  if (node.id !== undefined) {
    const prefix = objectIdType(node.id);

    if (isSaveNodeKind(prefix)) {
      return ok(prefix);
    }

    return invalidSaveInput(
      "Save node id does not resolve to an existing object and its prefix is not a creatable kind.",
      {
        field: `${field}.id`,
        id: node.id,
        allowed: [...SAVE_NODE_KINDS]
      }
    );
  }

  return invalidSaveInput("Save node kind is required when creating memory.", {
    field: `${field}.kind`,
    allowed: [...SAVE_NODE_KINDS]
  });
}

function relatedRelationChange(from: ObjectId, related: SaveRelatedInput): SavePatchCreateRelation {
  return {
    op: "create_relation",
    from,
    predicate: related.predicate,
    to: related.to,
    ...(related.confidence === undefined ? {} : { confidence: related.confidence })
  };
}

function parseSaveMemoryInput(value: unknown): Result<SaveMemoryInput> {
  if (!isRecord(value)) {
    return invalidSaveInput("Save input must be an object.", { field: "<input>" });
  }

  const unknownField = findUnknownField(value, SAVE_INPUT_FIELDS);

  if (unknownField !== null) {
    return unknownFieldError(unknownField);
  }

  const task = stringField(value, "task");

  if (!task.ok) {
    return task;
  }

  const nodes = optionalArray(value.nodes, "nodes", parseNodeInput);
  if (!nodes.ok) {
    return nodes;
  }

  const stale = optionalArray(value.stale, "stale", parseStaleInput);
  if (!stale.ok) {
    return stale;
  }

  const supersede = optionalArray(value.supersede, "supersede", parseSupersedeInput);
  if (!supersede.ok) {
    return supersede;
  }

  const deletions = optionalArray(value.delete, "delete", parseDeleteInput);
  if (!deletions.ok) {
    return deletions;
  }

  return ok({
    task: task.data,
    ...(nodes.data.length === 0 ? {} : { nodes: nodes.data }),
    ...(stale.data.length === 0 ? {} : { stale: stale.data }),
    ...(supersede.data.length === 0 ? {} : { supersede: supersede.data }),
    ...(deletions.data.length === 0 ? {} : { delete: deletions.data })
  });
}

function parseNodeInput(value: unknown, field: string): Result<SaveNodeInput> {
  if (!isRecord(value)) {
    return invalidSaveInput("Save node must be an object.", { field });
  }

  const unknownField = findUnknownField(value, SAVE_NODE_FIELDS, field);

  if (unknownField !== null) {
    return unknownFieldError(unknownField);
  }

  const id = optionalObjectIdField(value.id, `${field}.id`);
  if (!id.ok) {
    return id;
  }

  const kind = optionalKindField(value.kind, `${field}.kind`);
  if (!kind.ok) {
    return kind;
  }

  const title = optionalStringField(value.title, `${field}.title`);
  if (!title.ok) {
    return title;
  }

  const body = optionalStringField(value.body, `${field}.body`);
  if (!body.ok) {
    return body;
  }

  const stage = optionalStageField(value.stage, `${field}.stage`);
  if (!stage.ok) {
    return stage;
  }

  const anchors = optionalStringArray(value.anchors, `${field}.anchors`, {
    allowEmpty: true
  });
  if (!anchors.ok) {
    return anchors;
  }

  const tags = optionalStringArray(value.tags, `${field}.tags`, { allowEmpty: true });
  if (!tags.ok) {
    return tags;
  }

  const evidence = optionalEvidenceArray(value.evidence, `${field}.evidence`);
  if (!evidence.ok) {
    return evidence;
  }

  const related = optionalArray(value.related, `${field}.related`, parseRelatedInput);
  if (!related.ok) {
    return related;
  }

  return ok({
    ...(id.data === undefined ? {} : { id: id.data }),
    ...(kind.data === undefined ? {} : { kind: kind.data }),
    ...(title.data === undefined ? {} : { title: title.data }),
    ...(body.data === undefined ? {} : { body: body.data }),
    ...(stage.data === undefined ? {} : { stage: stage.data }),
    ...(anchors.data === undefined ? {} : { anchors: anchors.data }),
    ...(tags.data === undefined ? {} : { tags: tags.data }),
    ...(evidence.data === undefined ? {} : { evidence: evidence.data }),
    ...(related.data.length === 0 ? {} : { related: related.data })
  });
}

function parseRelatedInput(value: unknown, field: string): Result<SaveRelatedInput> {
  if (!isRecord(value)) {
    return invalidSaveInput("Save related item must be an object.", { field });
  }

  const unknownField = findUnknownField(value, SAVE_RELATED_FIELDS, field);

  if (unknownField !== null) {
    return unknownFieldError(unknownField);
  }

  const predicate = predicateField(value.predicate, `${field}.predicate`);
  if (!predicate.ok) {
    return predicate;
  }

  const to = objectIdField(value, "to", `${field}.to`);
  if (!to.ok) {
    return to;
  }

  const confidence = optionalConfidenceField(value.confidence, `${field}.confidence`);
  if (!confidence.ok) {
    return confidence;
  }

  return ok({
    predicate: predicate.data,
    to: to.data,
    ...(confidence.data === undefined ? {} : { confidence: confidence.data })
  });
}

function parseStaleInput(value: unknown, field: string): Result<SaveStaleInput> {
  if (!isRecord(value)) {
    return invalidSaveInput("Save stale item must be an object.", { field });
  }

  const unknownField = findUnknownField(value, SAVE_STALE_FIELDS, field);

  if (unknownField !== null) {
    return unknownFieldError(unknownField);
  }

  const id = objectIdField(value, "id", `${field}.id`);
  if (!id.ok) {
    return id;
  }

  const reason = stringField(value, "reason", `${field}.reason`);
  if (!reason.ok) {
    return reason;
  }

  return ok({ id: id.data, reason: reason.data });
}

function parseSupersedeInput(value: unknown, field: string): Result<SaveSupersedeInput> {
  if (!isRecord(value)) {
    return invalidSaveInput("Save supersede item must be an object.", { field });
  }

  const unknownField = findUnknownField(value, SAVE_SUPERSEDE_FIELDS, field);

  if (unknownField !== null) {
    return unknownFieldError(unknownField);
  }

  const id = objectIdField(value, "id", `${field}.id`);
  if (!id.ok) {
    return id;
  }

  const supersededBy = objectIdField(value, "superseded_by", `${field}.superseded_by`);
  if (!supersededBy.ok) {
    return supersededBy;
  }

  const reason = stringField(value, "reason", `${field}.reason`);
  if (!reason.ok) {
    return reason;
  }

  return ok({
    id: id.data,
    superseded_by: supersededBy.data,
    reason: reason.data
  });
}

function parseDeleteInput(value: unknown, field: string): Result<SaveDeleteInput> {
  if (!isRecord(value)) {
    return invalidSaveInput("Save delete item must be an object.", { field });
  }

  const unknownField = findUnknownField(value, SAVE_DELETE_FIELDS, field);

  if (unknownField !== null) {
    return unknownFieldError(unknownField);
  }

  const id = objectIdField(value, "id", `${field}.id`);
  if (!id.ok) {
    return id;
  }

  const reason = stringField(value, "reason", `${field}.reason`);
  if (!reason.ok) {
    return reason;
  }

  return ok({ id: id.data, reason: reason.data });
}

function optionalArray<T>(
  value: unknown,
  field: string,
  parseItem: (item: unknown, field: string) => Result<T>
): Result<T[]> {
  if (value === undefined) {
    return ok([]);
  }

  if (!Array.isArray(value)) {
    return invalidSaveInput("Save input field must be an array.", { field });
  }

  const parsed: T[] = [];

  for (const [index, item] of value.entries()) {
    const result = parseItem(item, `${field}.${index}`);

    if (!result.ok) {
      return result;
    }

    parsed.push(result.data);
  }

  return ok(parsed);
}

function stringField(
  record: Record<string, unknown>,
  key: string,
  field = key
): Result<string> {
  const value = record[key];

  if (typeof value !== "string" || value.trim() === "") {
    return invalidSaveInput("Save input field must be a non-empty string.", {
      field
    });
  }

  return ok(value.trim());
}

function optionalStringField(value: unknown, field: string): Result<string | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }

  if (typeof value !== "string" || value.trim() === "") {
    return invalidSaveInput("Save input field must be a non-empty string.", {
      field
    });
  }

  return ok(value.trim());
}

function objectIdField(
  record: Record<string, unknown>,
  key: string,
  field: string
): Result<ObjectId> {
  return objectIdValue(record[key], field);
}

function optionalObjectIdField(value: unknown, field: string): Result<ObjectId | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }

  return objectIdValue(value, field);
}

function objectIdValue(value: unknown, field: string): Result<ObjectId> {
  if (typeof value !== "string" || !isObjectId(value)) {
    return invalidSaveInput("Save input field must be a Memory object ID.", {
      field
    });
  }

  return ok(value);
}

function optionalKindField(value: unknown, field: string): Result<SaveNodeKind | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }

  if (typeof value !== "string" || !SAVE_NODE_KIND_SET.has(value)) {
    return invalidSaveInput("Save node kind is not supported.", {
      field,
      allowed: [...SAVE_NODE_KINDS]
    });
  }

  return ok(value as SaveNodeKind);
}

function optionalStageField(value: unknown, field: string): Result<FeatureStage | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }

  if (typeof value !== "string" || !FEATURE_STAGE_SET.has(value)) {
    return invalidSaveInput("Save node stage is not supported.", {
      field,
      allowed: [...FEATURE_STAGES]
    });
  }

  return ok(value as FeatureStage);
}

function predicateField(value: unknown, field: string): Result<Predicate> {
  if (typeof value !== "string" || !PREDICATE_SET.has(value)) {
    return invalidSaveInput("Save relation predicate is not supported.", {
      field,
      allowed: [...PREDICATES]
    });
  }

  return ok(value as Predicate);
}

function optionalConfidenceField(
  value: unknown,
  field: string
): Result<RelationConfidence | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }

  if (typeof value !== "string" || !RELATION_CONFIDENCE_SET.has(value)) {
    return invalidSaveInput("Save relation confidence is not supported.", {
      field,
      allowed: [...RELATION_CONFIDENCES]
    });
  }

  return ok(value as RelationConfidence);
}

function optionalStringArray(
  value: unknown,
  field: string,
  options: { allowEmpty: boolean }
): Result<string[] | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }

  if (!Array.isArray(value)) {
    return invalidSaveInput("Save input field must be an array of strings.", {
      field
    });
  }

  if (!options.allowEmpty && value.length === 0) {
    return invalidSaveInput("Save input field must not be empty.", { field });
  }

  const strings: string[] = [];

  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim() === "") {
      return invalidSaveInput("Save input array item must be a non-empty string.", {
        field: `${field}.${index}`
      });
    }

    strings.push(item.trim());
  }

  return ok([...new Set(strings)]);
}

function optionalEvidenceArray(value: unknown, field: string): Result<Evidence[] | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }

  if (!Array.isArray(value)) {
    return invalidSaveInput("Save evidence must be an array.", { field });
  }

  const evidence: Evidence[] = [];

  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      return invalidSaveInput("Save evidence item must be an object.", {
        field: `${field}.${index}`
      });
    }

    const unknownField = findUnknownField(item, new Set(["kind", "id"]), `${field}.${index}`);

    if (unknownField !== null) {
      return unknownFieldError(unknownField);
    }

    const kind = item.kind;
    const id = item.id;

    if (
      kind !== "memory" &&
      kind !== "relation" &&
      kind !== "file" &&
      kind !== "commit" &&
      kind !== "task" &&
      kind !== "source"
    ) {
      return invalidSaveInput("Save evidence kind is not supported.", {
        field: `${field}.${index}.kind`
      });
    }

    if (typeof id !== "string" || id.trim() === "") {
      return invalidSaveInput("Save evidence id must be a non-empty string.", {
        field: `${field}.${index}.id`
      });
    }

    evidence.push({ kind, id: id.trim() });
  }

  return ok(evidence);
}

function findUnknownField(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix = ""
): string | null {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      return prefix === "" ? key : `${prefix}.${key}`;
    }
  }

  return null;
}

function unknownFieldError<T>(field: string): Result<T> {
  return invalidSaveInput("Save input field is not supported.", { field });
}

function objectIdType(id: ObjectId): string {
  return id.slice(0, id.indexOf("."));
}

function isSaveNodeKind(value: string): value is SaveNodeKind {
  return SAVE_NODE_KIND_SET.has(value);
}

function invalidSaveInput<T>(message: string, details: JsonValue): Result<T> {
  return err(memoryError("MemoryValidationFailed", message, details));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

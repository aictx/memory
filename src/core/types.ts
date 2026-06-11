import type { JsonValue } from "./errors.js";

export type ObjectId = string;
export type RelationId = string;
export type ProjectId = string;
export type RelativePath = string;
export type IsoDateTime = string;
export type Sha256Hash = string;

export const OBJECT_TYPES = [
  "project",
  "feature",
  "decision",
  "gotcha",
  "question"
] as const;

export type ObjectType = (typeof OBJECT_TYPES)[number];

export const FEATURE_STAGES = [
  "idea",
  "building",
  "shipped",
  "paused",
  "dead"
] as const;

export type FeatureStage = (typeof FEATURE_STAGES)[number];

export const OBJECT_STATUSES = [
  "active",
  "stale",
  "superseded",
  "open",
  "closed"
] as const;

export type ObjectStatus = (typeof OBJECT_STATUSES)[number];

export const RELATION_STATUSES = ["active", "stale", "rejected"] as const;

export type RelationStatus = (typeof RELATION_STATUSES)[number];

export const PREDICATES = [
  "affects",
  "depends_on",
  "supersedes",
  "related_to"
] as const;

export type Predicate = (typeof PREDICATES)[number];

export const RELATION_CONFIDENCES = ["low", "medium", "high"] as const;

export type RelationConfidence = (typeof RELATION_CONFIDENCES)[number];

export const EVENT_TYPES = [
  "memory.created",
  "memory.updated",
  "memory.marked_stale",
  "memory.superseded",
  "memory.deleted",
  "relation.created",
  "relation.updated",
  "relation.deleted",
  "index.rebuilt"
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const ACTORS = ["agent", "user", "cli", "mcp", "system"] as const;

export type Actor = (typeof ACTORS)[number];
export type SourceKind = Actor;

export const ORIGIN_KINDS = ["file", "url", "user", "external"] as const;

export type OriginKind = (typeof ORIGIN_KINDS)[number];

export const PATCH_OPERATIONS = [
  "create_object",
  "update_object",
  "mark_stale",
  "supersede_object",
  "delete_object",
  "create_relation",
  "update_relation",
  "delete_relation"
] as const;

export type PatchOperation = (typeof PATCH_OPERATIONS)[number];

export interface ValidationIssue {
  code: string;
  message: string;
  path: RelativePath;
  field: string | null;
}

export interface GitState {
  available: boolean;
  branch: string | null;
  commit: string | null;
  dirty: boolean | null;
}

export interface MemoryMeta {
  project_root: string;
  memory_root: string;
  git: GitState;
}

export interface Source {
  kind: SourceKind;
  task?: string;
  commit?: string;
}

export interface SourceOrigin {
  kind: OriginKind;
  locator: string;
  captured_at?: IsoDateTime;
  digest?: Sha256Hash;
  media_type?: string;
}

export interface Evidence {
  kind: "memory" | "relation" | "file" | "commit" | "task" | "source";
  id: string;
}

export interface MemoryEvent {
  event: EventType;
  actor: Actor;
  timestamp: IsoDateTime;
  id?: ObjectId;
  relation_id?: RelationId;
  reason?: string;
  payload?: Record<string, JsonValue>;
}

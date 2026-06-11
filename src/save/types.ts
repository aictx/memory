import type {
  Evidence,
  FeatureStage,
  ObjectId,
  Predicate,
  RelationConfidence
} from "../core/types.js";

export const SAVE_NODE_KINDS = ["feature", "decision", "gotcha", "question"] as const;

export type SaveNodeKind = (typeof SAVE_NODE_KINDS)[number];

export interface SaveRelatedInput {
  predicate: Predicate;
  to: ObjectId;
  confidence?: RelationConfidence;
}

export interface SaveNodeInput {
  /** If it resolves to an existing object the node is an update; otherwise a create. */
  id?: ObjectId;
  /** Required on create (or derivable from an explicit id prefix); ignored-but-validated on update. */
  kind?: SaveNodeKind;
  /** Required on create. */
  title?: string;
  /** Required on create. */
  body?: string;
  /** Feature-only. */
  stage?: FeatureStage;
  anchors?: string[];
  tags?: string[];
  evidence?: Evidence[];
  related?: SaveRelatedInput[];
}

export interface SaveStaleInput {
  id: ObjectId;
  reason: string;
}

export interface SaveSupersedeInput {
  id: ObjectId;
  superseded_by: ObjectId;
  reason: string;
}

export interface SaveDeleteInput {
  id: ObjectId;
  reason: string;
}

export interface SaveMemoryInput {
  task: string;
  nodes?: SaveNodeInput[];
  stale?: SaveStaleInput[];
  supersede?: SaveSupersedeInput[];
  delete?: SaveDeleteInput[];
}

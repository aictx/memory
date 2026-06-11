import type {
  Evidence,
  FeatureStage,
  IsoDateTime,
  ObjectId,
  ObjectStatus,
  ObjectType,
  Sha256Hash,
  Source,
  SourceOrigin
} from "../core/types.js";

export const CURRENT_STORAGE_VERSION = 5;

export interface MemoryConfig {
  version: typeof CURRENT_STORAGE_VERSION;
  project: {
    id: string;
    name: string;
  };
  memory: {
    defaultTokenBudget: number;
    autoIndex: boolean;
  };
}

export interface MemoryObjectSidecar {
  id: ObjectId;
  type: ObjectType;
  status: ObjectStatus;
  title: string;
  body_path: string;
  stage?: FeatureStage;
  anchors?: string[];
  tags?: string[];
  evidence?: Evidence[];
  source?: Source;
  origin?: SourceOrigin;
  superseded_by?: ObjectId | null;
  content_hash: Sha256Hash;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface StoredMemoryObject {
  path: string;
  bodyPath: string;
  sidecar: MemoryObjectSidecar;
  body: string;
}

export function isMemoryConfig(value: unknown): value is MemoryConfig {
  if (!isRecord(value)) {
    return false;
  }

  const project = value.project;
  const memory = value.memory;

  return (
    value.version === CURRENT_STORAGE_VERSION &&
    isRecord(project) &&
    typeof project.id === "string" &&
    typeof project.name === "string" &&
    isRecord(memory) &&
    typeof memory.defaultTokenBudget === "number" &&
    typeof memory.autoIndex === "boolean"
  );
}

export function isMemoryObjectSidecar(value: unknown): value is MemoryObjectSidecar {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    typeof value.status === "string" &&
    typeof value.title === "string" &&
    typeof value.body_path === "string" &&
    typeof value.content_hash === "string" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

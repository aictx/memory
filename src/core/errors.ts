export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const MEMORY_ERROR_CODES = [
  "MemoryGitRequired",
  "MemoryNotInitialized",
  "MemoryAlreadyInitializedInvalid",
  "MemoryUnsupportedStorageVersion",
  "MemoryInvalidJson",
  "MemoryInvalidJsonl",
  "MemorySchemaValidationFailed",
  "MemoryValidationFailed",
  "MemoryConflictDetected",
  "MemoryDirtyMemory",
  "MemoryPatchRequired",
  "MemoryPatchInvalid",
  "MemoryUnknownPatchOperation",
  "MemoryObjectNotFound",
  "MemoryRelationNotFound",
  "MemoryDuplicateId",
  "MemoryInvalidRelation",
  "MemorySecretDetected",
  "MemoryIndexUnavailable",
  "MemoryLockBusy",
  "MemoryGitOperationFailed",
  "MemoryInternalError"
] as const;

export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];

export interface MemoryError {
  code: MemoryErrorCode;
  message: string;
  details?: JsonValue;
}

export function memoryError(
  code: MemoryErrorCode,
  message: string,
  details?: JsonValue
): MemoryError {
  return details === undefined ? { code, message } : { code, message, details };
}

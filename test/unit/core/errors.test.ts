import { describe, expect, it } from "vitest";

import { MEMORY_ERROR_CODES, memoryError } from "../../../src/core/errors.js";

describe("core errors", () => {
  it("exports the API spec error code list in order", () => {
    expect(MEMORY_ERROR_CODES).toEqual([
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
    ]);
  });

  it("constructs errors without details", () => {
    expect(memoryError("MemoryNotInitialized", "Memory is not initialized.")).toEqual({
      code: "MemoryNotInitialized",
      message: "Memory is not initialized."
    });
  });

  it("constructs errors with details", () => {
    expect(
      memoryError("MemoryInvalidJson", "Invalid JSON.", {
        path: ".memory/config.json",
        line: 1
      })
    ).toEqual({
      code: "MemoryInvalidJson",
      message: "Invalid JSON.",
      details: {
        path: ".memory/config.json",
        line: 1
      }
    });
  });
});

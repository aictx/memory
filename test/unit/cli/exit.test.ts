import { describe, expect, it } from "vitest";

import {
  CLI_EXIT_ERROR,
  CLI_EXIT_PRECONDITION,
  CLI_EXIT_SUCCESS,
  CLI_EXIT_USAGE,
  exitCodeForMemoryError
} from "../../../src/cli/exit.js";
import { memoryError, type MemoryErrorCode } from "../../../src/core/errors.js";

describe("CLI exit codes", () => {
  it("exports the API-specified numeric codes", () => {
    expect(CLI_EXIT_SUCCESS).toBe(0);
    expect(CLI_EXIT_ERROR).toBe(1);
    expect(CLI_EXIT_USAGE).toBe(2);
    expect(CLI_EXIT_PRECONDITION).toBe(3);
  });

  it("maps Git and storage precondition errors to exit 3", () => {
    const codes: MemoryErrorCode[] = [
      "MemoryGitRequired",
      "MemoryNotInitialized",
      "MemoryAlreadyInitializedInvalid",
      "MemoryUnsupportedStorageVersion",
      "MemoryConflictDetected",
      "MemoryDirtyMemory",
      "MemoryIndexUnavailable",
      "MemoryLockBusy",
      "MemoryGitOperationFailed"
    ];

    for (const code of codes) {
      expect(exitCodeForMemoryError(memoryError(code, "precondition failed"))).toBe(
        CLI_EXIT_PRECONDITION
      );
    }
  });

  it("maps validation and patch errors to exit 1", () => {
    const codes: MemoryErrorCode[] = [
      "MemoryInvalidJson",
      "MemoryInvalidJsonl",
      "MemorySchemaValidationFailed",
      "MemoryValidationFailed",
      "MemoryPatchRequired",
      "MemoryPatchInvalid",
      "MemoryUnknownPatchOperation"
    ];

    for (const code of codes) {
      expect(exitCodeForMemoryError(memoryError(code, "user-correctable error"))).toBe(
        CLI_EXIT_ERROR
      );
    }
  });

  it("maps object, relation, secret, and internal errors to exit 1", () => {
    const codes: MemoryErrorCode[] = [
      "MemoryObjectNotFound",
      "MemoryRelationNotFound",
      "MemoryDuplicateId",
      "MemoryInvalidRelation",
      "MemorySecretDetected",
      "MemoryInternalError"
    ];

    for (const code of codes) {
      expect(exitCodeForMemoryError(memoryError(code, "operation failed"))).toBe(
        CLI_EXIT_ERROR
      );
    }
  });
});

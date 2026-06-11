import { describe, expect, it } from "vitest";

import {
  ACTORS,
  EVENT_TYPES,
  FEATURE_STAGES,
  OBJECT_STATUSES,
  OBJECT_TYPES,
  ORIGIN_KINDS,
  PATCH_OPERATIONS,
  PREDICATES
} from "../../../src/core/types.js";

describe("core domain type constants", () => {
  it("exports object types from the storage spec", () => {
    expect(OBJECT_TYPES).toEqual([
      "project",
      "feature",
      "decision",
      "gotcha",
      "question"
    ]);
  });

  it("exports feature stages from the storage spec", () => {
    expect(FEATURE_STAGES).toEqual(["idea", "building", "shipped", "paused", "dead"]);
  });

  it("exports object statuses from the storage spec", () => {
    expect(OBJECT_STATUSES).toEqual(["active", "stale", "superseded", "open", "closed"]);
  });

  it("exports predicates from the storage spec", () => {
    expect(PREDICATES).toEqual(["affects", "depends_on", "supersedes", "related_to"]);
  });

  it("exports event types from the storage spec", () => {
    expect(EVENT_TYPES).toEqual([
      "memory.created",
      "memory.updated",
      "memory.marked_stale",
      "memory.superseded",
      "memory.deleted",
      "relation.created",
      "relation.updated",
      "relation.deleted",
      "index.rebuilt"
    ]);
  });

  it("exports actors and origin kinds from the specs", () => {
    expect(ACTORS).toEqual(["agent", "user", "cli", "mcp", "system"]);
    expect(ORIGIN_KINDS).toEqual(["file", "url", "user", "external"]);
  });

  it("exports patch operations from the API spec", () => {
    expect(PATCH_OPERATIONS).toEqual([
      "create_object",
      "update_object",
      "mark_stale",
      "supersede_object",
      "delete_object",
      "create_relation",
      "update_relation",
      "delete_relation"
    ]);
  });
});

import { describe, expect, it } from "vitest";

import { anchorMatchesAnyFile, verifyAnchors } from "../../../src/anchors/verify.js";
import type { FeatureStage, ObjectType } from "../../../src/core/types.js";
import type { StoredMemoryObject } from "../../../src/storage/objects.js";

function makeObject(options: {
  id: string;
  type?: ObjectType;
  stage?: FeatureStage;
  anchors?: string[];
}): StoredMemoryObject {
  return {
    path: `.memory/memory/${options.id}.json`,
    bodyPath: `.memory/memory/${options.id}.md`,
    body: `# ${options.id}\n\nBody.\n`,
    sidecar: {
      id: options.id,
      type: options.type ?? "feature",
      status: "active",
      title: options.id,
      body_path: `memory/${options.id}.md`,
      ...(options.stage === undefined ? {} : { stage: options.stage }),
      ...(options.anchors === undefined ? {} : { anchors: options.anchors }),
      content_hash: "0".repeat(64),
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z"
    }
  };
}

const files = [
  "README.md",
  "src/query/select.ts",
  "src/query/render/markdown.ts",
  "src/cli/main.ts",
  "src/.hidden/config.ts"
];

describe("anchorMatchesAnyFile", () => {
  it("matches directory-style anchors against nested files", () => {
    expect(anchorMatchesAnyFile("src/query/", files)).toBe(true);
    expect(anchorMatchesAnyFile("src/query", files)).toBe(true);
    expect(anchorMatchesAnyFile("src/missing/", files)).toBe(false);
  });

  it("matches exact file anchors exactly", () => {
    expect(anchorMatchesAnyFile("src/cli/main.ts", files)).toBe(true);
    expect(anchorMatchesAnyFile("src/cli/main", files)).toBe(false);
    expect(anchorMatchesAnyFile("cli/main.ts", files)).toBe(false);
  });

  it("matches glob anchors with dot support", () => {
    expect(anchorMatchesAnyFile("src/**/*.ts", files)).toBe(true);
    expect(anchorMatchesAnyFile("src/.hidden/*.ts", files)).toBe(true);
    expect(anchorMatchesAnyFile("src/**/*.py", files)).toBe(false);
    expect(anchorMatchesAnyFile("./src/query/*.ts", files)).toBe(true);
  });
});

describe("verifyAnchors", () => {
  it("reports matched and orphaned anchors per object", () => {
    const findings = verifyAnchors(
      [
        makeObject({
          id: "feature.query",
          stage: "building",
          anchors: ["src/query/", "src/ghost/**"]
        }),
        makeObject({ id: "feature.no-anchors", stage: "idea" }),
        makeObject({
          id: "decision.cli",
          type: "decision",
          anchors: ["src/cli/main.ts"]
        })
      ],
      files
    );

    expect(findings).toEqual([
      {
        id: "feature.query",
        matched_anchors: ["src/query/"],
        orphaned_anchors: ["src/ghost/**"]
      },
      {
        id: "decision.cli",
        matched_anchors: ["src/cli/main.ts"],
        orphaned_anchors: []
      }
    ]);
  });

  it("treats invalid anchors as orphaned", () => {
    const findings = verifyAnchors(
      [makeObject({ id: "feature.bad", stage: "idea", anchors: ["../outside"] })],
      files
    );

    expect(findings).toEqual([
      {
        id: "feature.bad",
        matched_anchors: [],
        orphaned_anchors: ["../outside"]
      }
    ]);
  });
});

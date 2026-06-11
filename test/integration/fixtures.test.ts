import { readFile } from "node:fs/promises";
import { join } from "node:path";

import fg from "fast-glob";
import { describe, expect, it } from "vitest";

import {
  computeObjectContentHash,
  computeRelationContentHash
} from "../../src/storage/hashes.js";
import { readCanonicalStorage } from "../../src/storage/read.js";
import { validateProject } from "../../src/validation/validate.js";

const fixtureRoot = join(process.cwd(), "test", "fixtures", "golden-storage");
const missingBodyHashExclusion = "invalid-missing-body/.memory/memory/project.json";

const validFixtures = [
  {
    name: "minimal-valid",
    counts: {
      objects: 1,
      relations: 0,
      events: 0
    }
  },
  {
    name: "rich-valid",
    counts: {
      objects: 5,
      relations: 3,
      events: 8
    }
  }
] as const;

const invalidFixtures = [
  ["invalid-jsonl", "EventJsonlInvalid"],
  ["invalid-missing-body", "ObjectBodyMissing"],
  ["invalid-bad-relation", "RelationEndpointMissing"],
  ["invalid-conflict-marker", "MemoryConflictDetected"]
] as const;

const expectedHashes = {
  "invalid-bad-relation/.memory/memory/project.json":
    "sha256:ab0cb677a4baf351f81ae4a991b39c6ba9944fde0891e0e92aec4f99723d6421",
  "invalid-bad-relation/.memory/relations/project-related-to-missing-gotcha.json":
    "sha256:2acd78b6f12ea30d03075f775e4e53ddf3fa41f378340839ad0c8c8c14e9bd76",
  "invalid-conflict-marker/.memory/memory/project.json":
    "sha256:08404c23bc12531a2116ff85b5ed70909eb23655fdd14d7fb4ffd04e67be68bb",
  "invalid-jsonl/.memory/memory/project.json":
    "sha256:4db04ed30f3295628ea2299e0e6d74fb1198e66381455572826bc296a629cf5e",
  "legacy-v4/.memory/memory/project.json":
    "sha256:1d88796b7e44c4ed302b6bc720a4c59b91039ecd8e74fecbaa8b8b556e148780",
  "minimal-valid/.memory/memory/project.json":
    "sha256:50d85da4b75785454395c384b7bb577d43c31b6b6adfd80b5e0dfcc62b7f9eda",
  "rich-valid/.memory/memory/decisions/storage-fixtures.json":
    "sha256:195d921aac3abf78d69b054e27b9504b2514b620606cf1045dbbe468d5aa7efa",
  "rich-valid/.memory/memory/features/golden-coverage.json":
    "sha256:f7ce54e623cf8a6c144ed8fe3f84e8d6aa2a0db9aef470e63e1bbb66bfec70df",
  "rich-valid/.memory/memory/gotchas/hashes-deterministic.json":
    "sha256:9edac4ca111f5903c82e86d67d72637e817f1f97ea8fc17a88cd20f724523816",
  "rich-valid/.memory/memory/project.json":
    "sha256:bb342b73fe023ad51238f624a617fe4fd2d29fe138ffe35cb531562fea43b41b",
  "rich-valid/.memory/memory/questions/fixture-refresh.json":
    "sha256:9fad9bd5d5252744e8cea7924ead00491178a1fbc866019979e565cfba575d33",
  "rich-valid/.memory/relations/feature-related-to-decision.json":
    "sha256:e4bcfff6f65ba5e11b9db836f03f06fdf32768b9eaf5ea834c981541add56bcd",
  "rich-valid/.memory/relations/question-related-to-decision.json":
    "sha256:5d430e8f73e9e9a3ad6a2fa8b8238029c3fba8bf3aa2f1a16ed25d139eca5e50",
  "rich-valid/.memory/relations/storage-fixtures-depends-on-hashes.json":
    "sha256:61a3ec067ec81fdfd37ce888a8ff4241a66db42bd797e4feebf87bb1c3148a24"
} as const satisfies Record<string, string>;

describe("golden storage fixtures", () => {
  it.each(validFixtures)("validates $name cleanly and reads expected counts", async (fixture) => {
    const projectRoot = projectFixtureRoot(fixture.name);
    const validation = await validateProject(projectRoot);

    expect(validation).toEqual({
      valid: true,
      errors: [],
      warnings: []
    });

    const storage = await readCanonicalStorage(projectRoot);

    expect(storage.ok).toBe(true);
    if (!storage.ok) {
      throw new Error(storage.error.message);
    }

    expect(storage.data.objects).toHaveLength(fixture.counts.objects);
    expect(storage.data.relations).toHaveLength(fixture.counts.relations);
    expect(storage.data.events).toHaveLength(fixture.counts.events);
  });

  it.each(invalidFixtures)(
    "reports only %s fixture errors as %s",
    async (fixture, expectedCode) => {
      const validation = await validateProject(projectFixtureRoot(fixture));

      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
      expect(validation.errors.every((issue) => issue.code === expectedCode)).toBe(true);
      expect(validation.warnings).toEqual([]);
    }
  );

  it("keeps committed fixture hashes deterministic", async () => {
    await expect(collectFixtureHashes()).resolves.toEqual(expectedHashes);
  });

  it("rejects the deliberate legacy-v4 fixture with the storage version gate", async () => {
    const storage = await readCanonicalStorage(projectFixtureRoot("legacy-v4"));

    expect(storage.ok).toBe(false);
    if (!storage.ok) {
      expect(storage.error.code).toBe("MemoryUnsupportedStorageVersion");
      expect(storage.error.message).toContain("memory reset");
      expect(storage.error.details).toMatchObject({
        supported_version: 5,
        found_version: 4
      });
    }
  });
});

function projectFixtureRoot(name: string): string {
  return join(fixtureRoot, name);
}

async function collectFixtureHashes(): Promise<Record<string, string>> {
  const paths = (
    await fg("**/.memory/{memory,relations}/**/*.json", {
      cwd: fixtureRoot,
      dot: true,
      onlyFiles: true,
      unique: true
    })
  ).sort();
  const hashes: Record<string, string> = {};

  for (const path of paths) {
    if (path === missingBodyHashExclusion) {
      continue;
    }

    const value = await readJsonObject(path);
    const computedHash = path.includes("/.memory/memory/")
      ? await computeFixtureObjectHash(path, value)
      : computeFixtureRelationHash(path, value);

    expect(readStringField(value, "content_hash", path)).toBe(computedHash);
    hashes[path] = computedHash;
  }

  return hashes;
}

async function computeFixtureObjectHash(
  sidecarPath: string,
  sidecar: Record<string, unknown>
): Promise<string> {
  const bodyPath = readStringField(sidecar, "body_path", sidecarPath);
  const fixture = fixtureNameForPath(sidecarPath);
  const body = await readFile(join(fixtureRoot, fixture, ".memory", bodyPath), "utf8");

  return computeObjectContentHash(sidecar, body);
}

function computeFixtureRelationHash(
  relationPath: string,
  relation: Record<string, unknown>
): string {
  readStringField(relation, "content_hash", relationPath);

  return computeRelationContentHash(relation);
}

function fixtureNameForPath(path: string): string {
  const [fixture] = path.split("/.memory/", 1);

  if (fixture === undefined || fixture.length === 0) {
    throw new Error(`Fixture path is not inside a .memory tree: ${path}`);
  }

  return fixture;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(join(fixtureRoot, path), "utf8")) as unknown;

  if (!isRecord(parsed)) {
    throw new Error(`Fixture JSON must contain one object: ${path}`);
  }

  return parsed;
}

function readStringField(
  value: Record<string, unknown>,
  field: string,
  path: string
): string {
  const fieldValue = value[field];

  if (typeof fieldValue !== "string") {
    throw new Error(`Fixture field must be a string at ${path}: ${field}`);
  }

  return fieldValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

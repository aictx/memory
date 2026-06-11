import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  computeObjectContentHash,
  computeRelationContentHash
} from "../../../src/storage/hashes.js";
import { SCHEMA_FILES } from "../../../src/validation/schemas.js";
import { validateProject } from "../../../src/validation/validate.js";

const root = process.cwd();
const tempRoots: string[] = [];
const timestamp = "2026-04-25T14:00:00+02:00";

const validConfig = {
  version: 5,
  project: {
    id: "project.billing-api",
    name: "Billing API"
  },
  memory: {
    defaultTokenBudget: 2000,
    autoIndex: true
  }
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("project validation", () => {
  it("accepts an initialized sample .memory directory", async () => {
    const projectRoot = await createValidProject();

    const result = await validateProject(projectRoot);

    expect(result).toEqual({
      valid: true,
      errors: [],
      warnings: []
    });
  });

  it("accepts gotcha and feature memory objects", async () => {
    const projectRoot = await createValidProject();
    await writeMemoryObject(projectRoot, {
      path: "memory/gotchas/webhook-duplicates.md",
      id: "gotcha.webhook-duplicates",
      type: "gotcha",
      title: "Webhook duplicates",
      body: "# Webhook duplicates\n\nNever assume webhook delivery is unique.\n"
    });
    await writeMemoryObject(projectRoot, {
      path: "memory/features/release-checklist.md",
      id: "feature.release-checklist",
      type: "feature",
      title: "Release checklist",
      body: "# Release checklist\n\nRun the release checklist before publishing.\n",
      stage: "building",
      anchors: ["scripts/release/"]
    });

    const result = await validateProject(projectRoot);

    expect(result).toEqual({
      valid: true,
      errors: [],
      warnings: []
    });
  });

  it("reports missing required canonical files and directories", async () => {
    const projectRoot = await mkdirTempRoot();
    await mkdir(join(projectRoot, ".memory"), { recursive: true });

    const result = await validateProject(projectRoot);

    expect(issueCodes(result.errors)).toEqual(
      expect.arrayContaining(["CanonicalFileMissing", "CanonicalDirectoryMissing"])
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "CanonicalFileMissing",
        path: ".memory/config.json",
        field: null
      })
    );
  });

  it("reports invalid JSON and blank or malformed JSONL with line numbers", async () => {
    const projectRoot = await createValidProject();
    await writeProjectFile(projectRoot, ".memory/memory/decisions/billing-retries.json", "{bad json");
    await writeProjectFile(
      projectRoot,
      ".memory/events.jsonl",
      [
        '{"event":"memory.created","id":"decision.billing-retries","actor":"agent","timestamp":"2026-04-25T14:00:00+02:00"}',
        "",
        "{bad json"
      ].join("\n")
    );

    const result = await validateProject(projectRoot);

    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "JsonInvalid",
        path: ".memory/memory/decisions/billing-retries.json",
        field: null
      })
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "EventJsonlBlankLine",
        path: ".memory/events.jsonl:2",
        field: null
      })
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "EventJsonlInvalid",
        path: ".memory/events.jsonl:3",
        field: null
      })
    );
  });

  it("detects duplicate object and relation identifiers", async () => {
    const projectRoot = await createValidProject();
    await writeMemoryObject(projectRoot, {
      path: "memory/decisions/duplicate.md",
      id: "decision.billing-retries",
      type: "decision",
      title: "Duplicate billing retries",
      body: "# Duplicate billing retries\n\nDuplicate.\n"
    });
    await writeRelation(projectRoot, {
      file: "duplicate-id.json",
      id: "rel.billing-retries-depends-on-idempotency",
      from: "decision.billing-retries",
      predicate: "affects",
      to: "gotcha.webhook-idempotency"
    });

    const result = await validateProject(projectRoot);

    expect(issueCodes(result.errors)).toEqual(
      expect.arrayContaining(["ObjectIdDuplicate", "RelationIdDuplicate"])
    );
  });

  it("detects duplicate equivalent relations and missing endpoints", async () => {
    const projectRoot = await createValidProject();
    await writeRelation(projectRoot, {
      file: "duplicate-equivalent.json",
      id: "rel.duplicate-equivalent",
      from: "decision.billing-retries",
      predicate: "depends_on",
      to: "gotcha.webhook-idempotency"
    });
    await writeRelation(projectRoot, {
      file: "missing-endpoint.json",
      id: "rel.missing-endpoint",
      from: "decision.missing",
      predicate: "related_to",
      to: "gotcha.webhook-idempotency"
    });

    const result = await validateProject(projectRoot);

    expect(issueCodes(result.errors)).toEqual(
      expect.arrayContaining(["RelationEquivalentDuplicate", "RelationEndpointMissing"])
    );
  });

  it("detects missing, escaping, and mismatched body paths", async () => {
    const projectRoot = await createValidProject();
    await writeObjectSidecar(projectRoot, ".memory/memory/decisions/billing-retries.json", {
      ...baseObject(
        "decision.billing-retries",
        "decision",
        "Billing retries moved to queue worker",
        "memory/decisions/missing.md"
      ),
      content_hash: `sha256:${"0".repeat(64)}`
    });
    await writeMemoryObject(projectRoot, {
      path: "memory/gotchas/escaping.md",
      id: "gotcha.escaping",
      type: "gotcha",
      title: "Escaping",
      bodyPath: "memory/../../outside.md",
      body: "# Escaping\n\nBad path.\n"
    });
    await writeMemoryObject(projectRoot, {
      path: "memory/gotchas/body.md",
      id: "gotcha.mismatch",
      type: "gotcha",
      title: "Mismatch",
      bodyPath: "memory/gotchas/not-body.md",
      body: "# Mismatch\n\nDifferent basename.\n"
    });

    const result = await validateProject(projectRoot);

    expect(issueCodes(result.errors)).toEqual(
      expect.arrayContaining([
        "ObjectBodyMissing",
        "ObjectBodyPathEscapesMemory",
        "ObjectBodyPathMismatch"
      ])
    );
  });

  it("warns for title, object hash, relation hash, related_to, and superseded issues", async () => {
    const projectRoot = await createValidProject();
    await writeMemoryObject(projectRoot, {
      path: "memory/gotchas/mismatched-title.md",
      id: "gotcha.mismatched-title",
      type: "gotcha",
      title: "JSON title",
      body: "# Markdown title\n\nBody.\n"
    });
    await writeMemoryObject(projectRoot, {
      path: "memory/gotchas/bad-hash.md",
      id: "gotcha.bad-hash",
      type: "gotcha",
      title: "Bad hash",
      body: "# Bad hash\n\nBody.\n",
      contentHash: `sha256:${"1".repeat(64)}`
    });
    await writeMemoryObject(projectRoot, {
      path: "memory/gotchas/superseded.md",
      id: "gotcha.superseded",
      type: "gotcha",
      title: "Superseded",
      body: "# Superseded\n\nBody.\n",
      status: "superseded"
    });
    await writeRelation(projectRoot, {
      file: "bad-hash.json",
      id: "rel.bad-hash",
      from: "decision.billing-retries",
      predicate: "affects",
      to: "gotcha.webhook-idempotency",
      contentHash: `sha256:${"2".repeat(64)}`
    });
    await writeRelatedToFixtures(projectRoot);

    const result = await validateProject(projectRoot);

    expect(result.errors).toEqual([]);
    expect(issueCodes(result.warnings)).toEqual(
      expect.arrayContaining([
        "ObjectTitleH1Mismatch",
        "ObjectContentHashMismatch",
        "RelationContentHashMismatch",
        "RelationRelatedToExcessive",
        "ObjectSupersededReplacementMissing"
      ])
    );
  });

  it("uses the supersedes relation target as the superseded object replacement", async () => {
    const validDirectionRoot = await createValidProject();
    await writeMemoryObject(validDirectionRoot, {
      path: "memory/gotchas/old.md",
      id: "gotcha.old",
      type: "gotcha",
      title: "Old note",
      body: "# Old note\n\nOld body.\n",
      status: "superseded"
    });
    await writeMemoryObject(validDirectionRoot, {
      path: "memory/gotchas/new.md",
      id: "gotcha.new",
      type: "gotcha",
      title: "New note",
      body: "# New note\n\nNew body.\n"
    });
    await writeRelation(validDirectionRoot, {
      file: "new-supersedes-old.json",
      id: "rel.new-supersedes-old",
      from: "gotcha.new",
      predicate: "supersedes",
      to: "gotcha.old"
    });

    const validDirection = await validateProject(validDirectionRoot);

    expect(validDirection.warnings).not.toContainEqual(
      expect.objectContaining({
        code: "ObjectSupersededReplacementMissing",
        path: ".memory/memory/gotchas/old.json"
      })
    );

    const reversedDirectionRoot = await createValidProject();
    await writeMemoryObject(reversedDirectionRoot, {
      path: "memory/gotchas/old.md",
      id: "gotcha.old",
      type: "gotcha",
      title: "Old note",
      body: "# Old note\n\nOld body.\n",
      status: "superseded"
    });
    await writeMemoryObject(reversedDirectionRoot, {
      path: "memory/gotchas/new.md",
      id: "gotcha.new",
      type: "gotcha",
      title: "New note",
      body: "# New note\n\nNew body.\n"
    });
    await writeRelation(reversedDirectionRoot, {
      file: "old-supersedes-new.json",
      id: "rel.old-supersedes-new",
      from: "gotcha.old",
      predicate: "supersedes",
      to: "gotcha.new"
    });

    const reversedDirection = await validateProject(reversedDirectionRoot);

    expect(reversedDirection.warnings).toContainEqual(
      expect.objectContaining({
        code: "ObjectSupersededReplacementMissing",
        path: ".memory/memory/gotchas/old.json"
      })
    );
  });

  it("rejects removed v4 scope metadata as schema violations", async () => {
    const projectRoot = await createValidProject();
    await writeMemoryObject(projectRoot, {
      path: "memory/gotchas/legacy-scope.md",
      id: "gotcha.legacy-scope",
      type: "gotcha",
      title: "Legacy scope",
      body: "# Legacy scope\n\nBody.\n",
      scope: {
        kind: "project",
        project: "project.billing-api",
        branch: null,
        task: null
      }
    });

    const result = await validateProject(projectRoot);

    expect(result.valid).toBe(false);
    expect(issueCodes(result.errors)).toContain("SchemaAdditionalProperty");
  });

  it("surfaces conflict markers and block or warn secret findings", async () => {
    const projectRoot = await createValidProject();
    await writeProjectFile(
      projectRoot,
      ".memory/memory/gotchas/conflict.md",
      ["# Conflict", "<<<<<<< HEAD"].join("\n")
    );
    await writeMemoryObject(projectRoot, {
      path: "memory/gotchas/block-secret.md",
      id: "gotcha.block-secret",
      type: "gotcha",
      title: "Block secret",
      body: `# Block secret\n\nsk-${"a".repeat(20)}\n`
    });
    await writeMemoryObject(projectRoot, {
      path: "memory/gotchas/warn-secret.md",
      id: "gotcha.warn-secret",
      type: "gotcha",
      title: "Warn secret",
      body: `# Warn secret\n\nAuthorization: Bearer ${"a".repeat(20)}\n`
    });

    const result = await validateProject(projectRoot);

    expect(issueCodes(result.errors)).toEqual(
      expect.arrayContaining(["MemoryConflictDetected", "MemorySecretDetected"])
    );
    expect(issueCodes(result.warnings)).toContain("MemorySecretWarning");
  });

  it("rejects symlinked Markdown bodies without reporting them as missing", async () => {
    const projectRoot = await createValidProject();
    const sidecarPath = ".memory/memory/decisions/billing-retries.json";
    const bodyPath = join(projectRoot, ".memory/memory/decisions/billing-retries.md");
    const outsidePath = join(projectRoot, "outside.md");
    await writeFile(outsidePath, "# Outside\n\nOutside body.\n", "utf8");
    await rm(bodyPath);
    await symlink(outsidePath, bodyPath);

    const result = await validateProject(projectRoot);

    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "ObjectBodyPathUnsafe",
        path: ".memory/memory/decisions/billing-retries.md"
      })
    );
    expect(result.errors).not.toContainEqual(
      expect.objectContaining({
        code: "ObjectBodyMissing",
        path: sidecarPath
      })
    );
  });
});

async function createValidProject(): Promise<string> {
  const projectRoot = await mkdirTempRoot();
  await mkdir(join(projectRoot, ".memory", "schema"), { recursive: true });
  await mkdir(join(projectRoot, ".memory", "relations"), { recursive: true });

  for (const file of Object.values(SCHEMA_FILES)) {
    await copyFile(
      join(root, "src", "schemas", file),
      join(projectRoot, ".memory", "schema", file)
    );
  }

  await writeProjectFile(projectRoot, ".memory/config.json", stableJson(validConfig));
  await writeMemoryObject(projectRoot, {
    path: "memory/decisions/billing-retries.md",
    id: "decision.billing-retries",
    type: "decision",
    title: "Billing retries moved to queue worker",
    body: "# Billing retries moved to queue worker\n\nRetries run in the worker.\n"
  });
  await writeMemoryObject(projectRoot, {
    path: "memory/gotchas/webhook-idempotency.md",
    id: "gotcha.webhook-idempotency",
    type: "gotcha",
    title: "Webhook idempotency",
    body: "# Webhook idempotency\n\nWebhook processing is idempotent.\n"
  });
  await writeRelation(projectRoot, {
    file: "billing-retries-depends-on-idempotency.json",
    id: "rel.billing-retries-depends-on-idempotency",
    from: "decision.billing-retries",
    predicate: "depends_on",
    to: "gotcha.webhook-idempotency"
  });
  await writeProjectFile(
    projectRoot,
    ".memory/events.jsonl",
    `${JSON.stringify({
      event: "memory.created",
      id: "decision.billing-retries",
      actor: "agent",
      timestamp
    })}\n`
  );

  return projectRoot;
}

async function writeRelatedToFixtures(projectRoot: string): Promise<void> {
  const ids = ["one", "two", "three", "four", "five", "six"];

  for (const id of ids) {
    await writeMemoryObject(projectRoot, {
      path: `memory/gotchas/${id}.md`,
      id: `gotcha.${id}`,
      type: "gotcha",
      title: `Note ${id}`,
      body: `# Note ${id}\n\nBody.\n`
    });
  }

  for (let index = 1; index < ids.length; index += 1) {
    await writeRelation(projectRoot, {
      file: `related-${ids[index]}.json`,
      id: `rel.related-${ids[index]}`,
      from: "gotcha.one",
      predicate: "related_to",
      to: `gotcha.${ids[index]}`
    });
  }
}

async function writeMemoryObject(
  projectRoot: string,
  options: {
    path: string;
    id: string;
    type: string;
    title: string;
    body: string;
    bodyPath?: string;
    status?: string;
    stage?: string;
    anchors?: string[];
    scope?: Record<string, unknown>;
    contentHash?: string;
  }
): Promise<void> {
  const bodyPath = options.bodyPath ?? options.path;
  const sidecar = baseObject(options.id, options.type, options.title, bodyPath);
  sidecar.status = options.status ?? "active";

  if (options.stage !== undefined) {
    sidecar.stage = options.stage;
  }

  if (options.anchors !== undefined) {
    sidecar.anchors = options.anchors;
  }

  if (options.scope !== undefined) {
    sidecar.scope = options.scope;
  }

  const sidecarWithHash = {
    ...sidecar,
    content_hash: options.contentHash ?? computeObjectContentHash(sidecar, options.body)
  };

  await writeProjectFile(projectRoot, `.memory/${options.path}`, options.body);
  await writeObjectSidecar(
    projectRoot,
    `.memory/${options.path.replace(/\.md$/, ".json")}`,
    sidecarWithHash
  );
}

async function writeRelation(
  projectRoot: string,
  options: {
    file: string;
    id: string;
    from: string;
    predicate: string;
    to: string;
    contentHash?: string;
  }
): Promise<void> {
  const relation = {
    id: options.id,
    from: options.from,
    predicate: options.predicate,
    to: options.to,
    status: "active",
    created_at: timestamp,
    updated_at: timestamp
  };
  const relationWithHash = {
    ...relation,
    content_hash: options.contentHash ?? computeRelationContentHash(relation)
  };

  await writeProjectFile(
    projectRoot,
    `.memory/relations/${options.file}`,
    stableJson(relationWithHash)
  );
}

function baseObject(
  id: string,
  type: string,
  title: string,
  bodyPath: string
): Record<string, unknown> {
  return {
    id,
    type,
    status: "active",
    title,
    body_path: bodyPath,
    tags: [],
    source: {
      kind: "agent"
    },
    superseded_by: null,
    created_at: timestamp,
    updated_at: timestamp
  };
}

async function writeObjectSidecar(
  projectRoot: string,
  path: string,
  value: Record<string, unknown>
): Promise<void> {
  await writeProjectFile(projectRoot, path, stableJson(value));
}

async function mkdirTempRoot(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "memory-project-validation-"));
  tempRoots.push(projectRoot);
  return projectRoot;
}

async function writeProjectFile(
  projectRoot: string,
  path: string,
  contents: string
): Promise<void> {
  const absolutePath = join(projectRoot, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, "utf8");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function issueCodes(issues: readonly { code: string }[]): string[] {
  return issues.map((issue) => issue.code);
}

import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readCanonicalStorage } from "../../../src/storage/read.js";
import { SCHEMA_FILES } from "../../../src/validation/schemas.js";

const repoRoot = process.cwd();
const tempRoots: string[] = [];
const hash = `sha256:${"0".repeat(64)}`;
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

const validObject = {
  id: "decision.billing-retries",
  type: "decision",
  status: "active",
  title: "Billing retries moved to queue worker",
  body_path: "memory/decisions/billing-retries.md",
  anchors: ["src/billing/retries.ts"],
  tags: ["billing", "stripe"],
  content_hash: hash,
  created_at: timestamp,
  updated_at: timestamp
};

const validRelation = {
  id: "rel.billing-retries-depends-on-idempotency",
  from: "decision.billing-retries",
  predicate: "depends_on",
  to: "gotcha.webhook-idempotency",
  status: "active",
  confidence: "high",
  content_hash: hash,
  created_at: timestamp,
  updated_at: timestamp
};

const createdEvent = {
  event: "memory.created",
  id: "decision.billing-retries",
  actor: "agent",
  timestamp,
  payload: {
    title: "Billing retries moved to queue worker"
  }
};

const relationEvent = {
  event: "relation.created",
  relation_id: "rel.billing-retries-depends-on-idempotency",
  actor: "agent",
  timestamp,
  payload: {
    from: "decision.billing-retries",
    predicate: "depends_on",
    to: "gotcha.webhook-idempotency"
  }
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("readCanonicalStorage", () => {
  it("loads config, objects with Markdown bodies, relations, and events", async () => {
    const projectRoot = await createReadableProject();

    const result = await readCanonicalStorage(projectRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.config).toEqual(validConfig);
    expect(result.data.objects).toHaveLength(1);
    expect(result.data.objects[0]).toEqual({
      path: ".memory/memory/decisions/billing-retries.json",
      bodyPath: ".memory/memory/decisions/billing-retries.md",
      sidecar: validObject,
      body: "# Billing retries moved to queue worker\n\nRetries run in the queue worker."
    });
    expect(result.data.relations).toEqual([
      {
        path: ".memory/relations/billing-retries-depends-on-idempotency.json",
        relation: validRelation
      }
    ]);
    expect(result.data.events.map((event) => event.line)).toEqual([1, 2]);
    expect(result.data.events.map((event) => event.event)).toEqual([
      "memory.created",
      "relation.created"
    ]);
  });

  it("reports invalid config JSON", async () => {
    const projectRoot = await createReadableProject();
    await writeProjectFile(projectRoot, ".memory/config.json", "{bad json");

    const result = await readCanonicalStorage(projectRoot);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemoryInvalidJson");
      expect(JSON.stringify(result.error.details)).toContain(".memory/config.json");
    }
  });

  it("reports invalid object JSON", async () => {
    const projectRoot = await createReadableProject();
    await writeProjectFile(projectRoot, ".memory/memory/decisions/billing-retries.json", "{bad json");

    const result = await readCanonicalStorage(projectRoot);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemoryInvalidJson");
      expect(JSON.stringify(result.error.details)).toContain(
        ".memory/memory/decisions/billing-retries.json"
      );
    }
  });

  it("reports invalid relation JSON", async () => {
    const projectRoot = await createReadableProject();
    await writeProjectFile(
      projectRoot,
      ".memory/relations/billing-retries-depends-on-idempotency.json",
      "{bad json"
    );

    const result = await readCanonicalStorage(projectRoot);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemoryInvalidJson");
      expect(JSON.stringify(result.error.details)).toContain(
        ".memory/relations/billing-retries-depends-on-idempotency.json"
      );
    }
  });

  it("reports invalid JSONL syntax with the event line path", async () => {
    const projectRoot = await createReadableProject();
    await writeProjectFile(projectRoot, ".memory/events.jsonl", `${JSON.stringify(createdEvent)}\n{bad json\n`);

    const result = await readCanonicalStorage(projectRoot);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemoryInvalidJsonl");
      expect(JSON.stringify(result.error.details)).toContain(".memory/events.jsonl:2");
    }
  });

  it("reports blank JSONL lines as errors", async () => {
    const projectRoot = await createReadableProject();
    await writeProjectFile(
      projectRoot,
      ".memory/events.jsonl",
      `${JSON.stringify(createdEvent)}\n\n${JSON.stringify(relationEvent)}\n`
    );

    const result = await readCanonicalStorage(projectRoot);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemoryInvalidJsonl");
      expect(JSON.stringify(result.error.details)).toContain(".memory/events.jsonl:2");
    }
  });

  it("reports non-object JSONL lines as errors", async () => {
    const projectRoot = await createReadableProject();
    await writeProjectFile(projectRoot, ".memory/events.jsonl", `"not an event object"\n`);

    const result = await readCanonicalStorage(projectRoot);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemoryInvalidJsonl");
      expect(JSON.stringify(result.error.details)).toContain(".memory/events.jsonl:1");
    }
  });

  it("accepts an empty events file", async () => {
    const projectRoot = await createReadableProject();
    await writeProjectFile(projectRoot, ".memory/events.jsonl", "");

    const result = await readCanonicalStorage(projectRoot);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.events).toEqual([]);
    }
  });

  it("accepts a trailing newline after the last JSONL event", async () => {
    const projectRoot = await createReadableProject();
    await writeProjectFile(projectRoot, ".memory/events.jsonl", `${JSON.stringify(createdEvent)}\n`);

    const result = await readCanonicalStorage(projectRoot);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.events.map((event) => event.line)).toEqual([1]);
    }
  });

  it("rejects symlinked Markdown bodies", async () => {
    const projectRoot = await createReadableProject();
    const bodyPath = join(projectRoot, ".memory/memory/decisions/billing-retries.md");
    const outsidePath = join(projectRoot, "outside.md");
    await writeProjectFile(projectRoot, "outside.md", "# Outside\n\nOutside body.\n");
    await rm(bodyPath);
    await symlink(outsidePath, bodyPath);

    const result = await readCanonicalStorage(projectRoot);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemoryValidationFailed");
    }
  });

  it("rejects symlinked canonical JSON files", async () => {
    const projectRoot = await createReadableProject();
    const objectPath = join(projectRoot, ".memory/memory/decisions/billing-retries.json");
    const outsidePath = join(projectRoot, "outside-object.json");
    await writeJsonProjectFile(projectRoot, "outside-object.json", validObject);
    await rm(objectPath);
    await symlink(outsidePath, objectPath);

    const result = await readCanonicalStorage(projectRoot);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemoryValidationFailed");
    }
  });

  it("reports schema-invalid events with a line-qualified path", async () => {
    const projectRoot = await createReadableProject();
    await writeProjectFile(
      projectRoot,
      ".memory/events.jsonl",
      `${JSON.stringify({ event: "memory.created", actor: "agent", timestamp })}\n`
    );

    const result = await readCanonicalStorage(projectRoot);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemorySchemaValidationFailed");
      expect(JSON.stringify(result.error.details)).toContain(".memory/events.jsonl:1");
    }
  });

  it("ignores generated directories", async () => {
    const projectRoot = await createReadableProject();
    await writeProjectFile(projectRoot, ".memory/index/generated.json", "{bad json");
    await writeProjectFile(projectRoot, ".memory/context/generated.json", "{bad json");

    const result = await readCanonicalStorage(projectRoot);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.objects).toHaveLength(1);
      expect(result.data.relations).toHaveLength(1);
    }
  });
});

async function createReadableProject(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "memory-read-"));
  tempRoots.push(projectRoot);
  await mkdir(join(projectRoot, ".memory", "schema"), { recursive: true });

  for (const schemaFile of Object.values(SCHEMA_FILES)) {
    await copyFile(
      join(repoRoot, "src", "schemas", schemaFile),
      join(projectRoot, ".memory", "schema", schemaFile)
    );
  }

  await writeJsonProjectFile(projectRoot, ".memory/config.json", validConfig);
  await writeJsonProjectFile(projectRoot, ".memory/memory/decisions/billing-retries.json", validObject);
  await writeProjectFile(
    projectRoot,
    ".memory/memory/decisions/billing-retries.md",
    "# Billing retries moved to queue worker\r\n\r\nRetries run in the queue worker."
  );
  await writeJsonProjectFile(
    projectRoot,
    ".memory/relations/billing-retries-depends-on-idempotency.json",
    validRelation
  );
  await writeProjectFile(
    projectRoot,
    ".memory/events.jsonl",
    `${JSON.stringify(createdEvent)}\n${JSON.stringify(relationEvent)}\n`
  );

  return projectRoot;
}

async function writeJsonProjectFile(
  projectRoot: string,
  path: string,
  value: Record<string, unknown>
): Promise<void> {
  await writeProjectFile(projectRoot, path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeProjectFile(projectRoot: string, path: string, contents: string): Promise<void> {
  const absolutePath = join(projectRoot, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, "utf8");
}

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const scriptPath = join(repoRoot, "scripts", "build-viewer-demo-data.mjs");
const committedSeedPath = join(repoRoot, "src", "viewer", "demo-data.generated.json");
const tempRoots: string[] = [];
const expectedMemoryIds = [
  "decision.cloud-sync",
  "decision.local-first-storage",
  "feature.filtered-views",
  "feature.quick-add",
  "feature.recurring-tasks",
  "gotcha.filter-count-drift",
  "project.todo-app",
  "question.recurring-scope"
];
const expectedRelations = [
  ["decision.local-first-storage", "affects", "project.todo-app"],
  ["feature.quick-add", "depends_on", "decision.local-first-storage"],
  ["feature.filtered-views", "depends_on", "decision.local-first-storage"],
  ["gotcha.filter-count-drift", "affects", "feature.filtered-views"],
  ["question.recurring-scope", "affects", "feature.recurring-tasks"],
  ["feature.recurring-tasks", "related_to", "feature.quick-add"],
  ["decision.local-first-storage", "supersedes", "decision.cloud-sync"]
] as const;
const allowedPredicates = new Set(["affects", "depends_on", "supersedes", "related_to"]);
const allowedTypes = new Set(["project", "feature", "decision", "gotcha", "question"]);
const allowedStages = new Set(["idea", "building", "shipped", "paused", "dead"]);

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("viewer demo data seed", () => {
  it("generates deterministic sanitized product-graph demo data", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "memory-demo-data-"));
    tempRoots.push(tempRoot);
    const outFile = join(tempRoot, "demo-data.json");

    await execFileAsync(process.execPath, [scriptPath, "--out", outFile], {
      cwd: repoRoot
    });

    const first = await readFile(outFile, "utf8");
    const committed = await readFile(committedSeedPath, "utf8");

    await execFileAsync(process.execPath, [scriptPath, "--out", outFile], {
      cwd: repoRoot
    });

    const second = await readFile(outFile, "utf8");
    const data = JSON.parse(second) as {
      meta: { project_root: string; memory_root: string };
      seed: { memory_ids: string[]; source: string };
      projects: { projects: Array<{ registry_id: string; project_root: string }> };
      bootstrap: {
        project: { id: string; name: string };
        objects: Array<{
          id: string;
          type: string;
          status: string;
          stage: string | null;
          anchors: string[];
          superseded_by: string | null;
        }>;
        relations: Array<{ id: string; from: string; predicate: string; to: string; status: string }>;
        counts: {
          objects: number;
          relations: number;
          stale_objects: number;
          superseded_objects: number;
          active_relations: number;
        };
      };
    };
    const serialized = JSON.stringify(data);
    const objectIds = data.bootstrap.objects.map((object) => object.id).sort();
    const relationEndpointIds = new Set(
      data.bootstrap.relations.flatMap((relation) => [relation.from, relation.to])
    );
    const features = data.bootstrap.objects.filter((object) => object.type === "feature");
    const relationTriples = new Set(data.bootstrap.relations.map(relationTripleKey));

    expect(second).toBe(first);
    expect(second).toBe(committed);
    expect([...data.seed.memory_ids].sort()).toEqual(expectedMemoryIds);
    expect(data.seed.source).toBe("synthetic-todo-app-product-graph");
    expect(data.bootstrap.project).toEqual({
      id: "project.todo-app",
      name: "Todo App"
    });
    expect(objectIds).toEqual(expectedMemoryIds);

    for (const object of data.bootstrap.objects) {
      expect(allowedTypes).toContain(object.type);

      if (object.type === "feature") {
        expect(object.stage).not.toBeNull();
      } else {
        expect(object.stage).toBeNull();
      }

      if (object.stage !== null) {
        expect(allowedStages).toContain(object.stage);
      }
    }

    expect(features.length).toBeGreaterThanOrEqual(2);
    expect(features.some((feature) => feature.anchors.length > 0)).toBe(true);
    expect(
      data.bootstrap.objects.find((object) => object.id === "decision.cloud-sync")
    ).toMatchObject({
      status: "superseded",
      superseded_by: "decision.local-first-storage"
    });
    expect(
      data.bootstrap.objects.find((object) => object.id === "question.recurring-scope")?.status
    ).toBe("open");

    for (const relation of data.bootstrap.relations) {
      expect(allowedPredicates).toContain(relation.predicate);
    }
    for (const relation of expectedRelations) {
      expect(relationTriples).toContain(relation.join("\0"));
    }

    expect(data.bootstrap.counts).toEqual({
      objects: data.bootstrap.objects.length,
      relations: data.bootstrap.relations.length,
      stale_objects: 0,
      superseded_objects: 1,
      active_relations: data.bootstrap.relations.length
    });
    expect(data.meta.project_root).toBe("demo://todo-app");
    expect(data.meta.memory_root).toBe("demo://todo-app/.memory");
    expect(data.projects.projects).toHaveLength(1);
    expect(data.projects.projects[0]).toMatchObject({
      registry_id: "demo",
      project_root: "demo://todo-app"
    });
    expect(data.bootstrap.relations.length).toBeGreaterThan(0);
    for (const id of relationEndpointIds) {
      expect(objectIds).toContain(id);
    }
    expect(componentSizes(objectIds, data.bootstrap.relations)).toEqual([expectedMemoryIds.length]);

    expect(serialized).not.toContain(repoRoot);
    expect(serialized).not.toMatch(/\/Users\//);
    expect(serialized).not.toMatch(/\/home\//);
    expect(serialized).not.toMatch(/\.memory\/(?:index|context|\.backup|\.lock|exports|recovery)\b/);
    expect(serialized).not.toMatch(/sk_(?:live|test)_[A-Za-z0-9]{16,}/);
    expect(serialized).not.toMatch(/ghp_[A-Za-z0-9_]{20,}/);
    expect(serialized).not.toMatch(
      /(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'][^"'\s]{12,}["']/i
    );
  });
});

function relationTripleKey(relation: { from: string; predicate: string; to: string }): string {
  return [relation.from, relation.predicate, relation.to].join("\0");
}

function componentSizes(objectIds: readonly string[], relations: ReadonlyArray<{ from: string; to: string }>): number[] {
  const graph = new Map(objectIds.map((id) => [id, new Set<string>()]));

  for (const relation of relations) {
    graph.get(relation.from)?.add(relation.to);
    graph.get(relation.to)?.add(relation.from);
  }

  const seen = new Set<string>();
  const sizes: number[] = [];

  for (const id of objectIds) {
    if (seen.has(id)) {
      continue;
    }

    const stack = [id];
    let size = 0;

    while (stack.length > 0) {
      const current = stack.pop();

      if (current === undefined || seen.has(current)) {
        continue;
      }

      seen.add(current);
      size += 1;

      for (const next of graph.get(current) ?? []) {
        if (!seen.has(next)) {
          stack.push(next);
        }
      }
    }

    sizes.push(size);
  }

  return sizes.sort((left, right) => right - left);
}

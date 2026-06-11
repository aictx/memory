#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_OUT_FILE = "src/viewer/demo-data.generated.json";
const DEMO_REGISTRY_ID = "demo";
const DEMO_TOKEN = "demo";
const DEMO_PROJECT_ID = "project.todo-app";
const DEMO_PROJECT_NAME = "Todo App";
const DEMO_PROJECT_ROOT = "demo://todo-app";
const DEMO_MEMORY_ROOT = "demo://todo-app/.memory";
const CREATED_AT = "2026-05-12T09:00:00+02:00";
const UPDATED_AT = "2026-05-13T15:30:00+02:00";

const SECRET_PATTERNS = [
  /sk_(?:live|test)_[A-Za-z0-9]{16,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9_]{20,}/,
  /(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'][^"'\s]{12,}["']/i,
  /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i
];

const LOCAL_STATE_PATTERNS = [
  /\.memory\/(?:index|context|\.backup|\.lock|exports|recovery)\b/,
  /\/Users\/[^"'\s`)]+/,
  /\/home\/[^"'\s`)]+/
];

const OBJECT_FIXTURES = [
  object("project.todo-app", "project", "active", "Todo App", "memory/project.md", [
    "# Todo App",
    "",
    "A small personal productivity app for capturing tasks quickly, organizing them by status, and reviewing what needs attention today.",
    "",
    "Local-first by design: no accounts, no backend, and no surprise data loss after refresh."
  ], {
    tags: ["project", "todo"]
  }),
  object("feature.quick-add", "feature", "active", "Quick add", "memory/features/quick-add.md", [
    "# Quick add",
    "",
    "Quick add accepts a non-empty task title, trims whitespace, creates an active task, and clears the input after save."
  ], {
    stage: "shipped",
    anchors: ["src/components/TaskComposer.tsx"],
    tags: ["capture", "tasks"]
  }),
  object("feature.filtered-views", "feature", "active", "Filtered task views", "memory/features/filtered-views.md", [
    "# Filtered task views",
    "",
    "The list supports all, active, completed, and overdue views. Counts must match the same predicate used to render each view."
  ], {
    stage: "building",
    anchors: ["src/components/TaskFilters.tsx", "src/storage/tasks.ts"],
    tags: ["filters", "tasks"]
  }),
  object("feature.recurring-tasks", "feature", "active", "Recurring tasks", "memory/features/recurring-tasks.md", [
    "# Recurring tasks",
    "",
    "Possible follow-up feature: tasks that re-create themselves on a schedule. Not started; scope is still an open question."
  ], {
    stage: "idea",
    tags: ["scope", "tasks"]
  }),
  object("decision.local-first-storage", "decision", "active", "Local-first storage", "memory/decisions/local-first-storage.md", [
    "# Local-first storage",
    "",
    "Task state lives in a small client-side store that persists a normalized task list to localStorage and ignores malformed saved records on load.",
    "",
    "Do not add a hosted database or login flow; offline behavior is the product."
  ], {
    anchors: ["src/storage/tasks.ts"],
    tags: ["architecture", "storage"]
  }),
  object("decision.cloud-sync", "decision", "superseded", "Cloud sync backend", "memory/decisions/cloud-sync.md", [
    "# Cloud sync backend",
    "",
    "An early plan to sync tasks through a hosted backend. Abandoned in favor of local-first storage."
  ], {
    tags: ["architecture", "storage"],
    supersededBy: "decision.local-first-storage"
  }),
  object("gotcha.filter-count-drift", "gotcha", "active", "Filter counts can drift", "memory/gotchas/filter-count-drift.md", [
    "# Filter counts can drift",
    "",
    "Do not compute filter badges with a different predicate than the rendered list. This caused completed tasks to appear in the active count before."
  ], {
    anchors: ["src/components/TaskFilters.tsx"],
    tags: ["filters"]
  }),
  object("question.recurring-scope", "question", "open", "Recurring task scope", "memory/questions/recurring-scope.md", [
    "# Recurring task scope",
    "",
    "Should recurring tasks be part of the Todo App, or should the app stay focused on one-off personal tasks for the first release?"
  ], {
    tags: ["scope"]
  })
];

const RELATION_FIXTURES = [
  relation("rel.local-first-storage-affects-project", "decision.local-first-storage", "affects", "project.todo-app"),
  relation("rel.quick-add-depends-on-local-first-storage", "feature.quick-add", "depends_on", "decision.local-first-storage"),
  relation("rel.filtered-views-depends-on-local-first-storage", "feature.filtered-views", "depends_on", "decision.local-first-storage"),
  relation("rel.filter-count-drift-affects-filtered-views", "gotcha.filter-count-drift", "affects", "feature.filtered-views"),
  relation("rel.recurring-scope-affects-recurring-tasks", "question.recurring-scope", "affects", "feature.recurring-tasks"),
  relation("rel.recurring-tasks-related-to-quick-add", "feature.recurring-tasks", "related_to", "feature.quick-add"),
  relation("rel.local-first-storage-supersedes-cloud-sync", "decision.local-first-storage", "supersedes", "decision.cloud-sync")
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = resolve(args.projectRoot ?? process.cwd());
  const outFile = resolve(projectRoot, args.out ?? DEFAULT_OUT_FILE);
  const data = buildDemoData();

  await assertDemoDataIsSafe(data, projectRoot);
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function buildDemoData() {
  const objects = OBJECT_FIXTURES.map(summarizeObject);
  const objectIds = new Set(objects.map((object) => object.id));
  const relations = RELATION_FIXTURES.map(summarizeRelation).filter(
    (relation) => objectIds.has(relation.from) && objectIds.has(relation.to)
  );
  const bootstrap = {
    project: {
      id: DEMO_PROJECT_ID,
      name: DEMO_PROJECT_NAME
    },
    objects,
    relations,
    counts: {
      objects: objects.length,
      relations: relations.length,
      stale_objects: objects.filter((object) => object.status === "stale").length,
      superseded_objects: objects.filter((object) => object.status === "superseded").length,
      active_relations: relations.filter((relation) => relation.status === "active").length
    },
    storage_warnings: []
  };
  const meta = {
    project_root: DEMO_PROJECT_ROOT,
    memory_root: DEMO_MEMORY_ROOT,
    git: {
      available: true,
      branch: "main",
      commit: "todo-demo-seed",
      dirty: false
    }
  };
  const projects = {
    registry_path: "demo://todo-app/projects.json",
    projects: [
      {
        registry_id: DEMO_REGISTRY_ID,
        project: bootstrap.project,
        project_root: DEMO_PROJECT_ROOT,
        memory_root: DEMO_MEMORY_ROOT,
        source: "manual",
        registered_at: CREATED_AT,
        last_seen_at: UPDATED_AT,
        current: true,
        available: true,
        counts: bootstrap.counts,
        git: meta.git,
        warnings: []
      }
    ],
    counts: {
      projects: 1,
      available: 1,
      unavailable: 0
    },
    current_project_registry_id: DEMO_REGISTRY_ID
  };

  return {
    version: 1,
    token: DEMO_TOKEN,
    registry_id: DEMO_REGISTRY_ID,
    seed: {
      memory_ids: objects.map((item) => item.id),
      source: "synthetic-todo-app-product-graph"
    },
    meta,
    projects,
    bootstrap
  };
}

function object(id, type, status, title, bodyPath, lines, options = {}) {
  return {
    id,
    type,
    status,
    title,
    body_path: bodyPath,
    stage: options.stage ?? null,
    anchors: options.anchors ?? [],
    tags: options.tags ?? [],
    evidence: options.evidence ?? [],
    superseded_by: options.supersededBy ?? null,
    body: `${lines.join("\n").trim()}\n`
  };
}

function relation(id, from, predicate, to) {
  return {
    id,
    from,
    predicate,
    to,
    status: "active",
    confidence: "high",
    evidence: [{ kind: "memory", id: from }]
  };
}

function summarizeObject(fixture) {
  return {
    id: fixture.id,
    type: fixture.type,
    status: fixture.status,
    title: fixture.title,
    body_path: `.memory/${fixture.body_path}`,
    json_path: `.memory/${fixture.body_path.replace(/\.md$/u, ".json")}`,
    stage: fixture.stage,
    anchors: [...fixture.anchors],
    tags: [...fixture.tags].sort(),
    evidence: [...fixture.evidence].sort(compareEvidence),
    source: {
      kind: "system",
      task: "Curated public Todo App demo seed"
    },
    origin: null,
    superseded_by: fixture.superseded_by,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    body: fixture.body
  };
}

function summarizeRelation(fixture) {
  return {
    id: fixture.id,
    from: fixture.from,
    predicate: fixture.predicate,
    to: fixture.to,
    status: fixture.status,
    confidence: fixture.confidence,
    evidence: [...fixture.evidence].sort(compareEvidence),
    content_hash: null,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    json_path: `.memory/relations/${fixture.id.replace(/^rel\./u, "")}.json`
  };
}

async function assertDemoDataIsSafe(data, projectRoot) {
  const serialized = JSON.stringify(data);

  if (serialized.includes(projectRoot)) {
    throw new Error("Demo data includes the local project root.");
  }

  for (const pattern of [...SECRET_PATTERNS, ...LOCAL_STATE_PATTERNS]) {
    if (pattern.test(serialized)) {
      throw new Error(`Demo data failed safety check: ${pattern}`);
    }
  }
}

function parseArgs(args) {
  const parsed = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--out") {
      parsed.out = requiredValue(args, index, arg);
      index += 1;
    } else if (arg === "--project-root") {
      parsed.projectRoot = requiredValue(args, index, arg);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function requiredValue(args, index, flag) {
  const value = args[index + 1];

  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function compareEvidence(left, right) {
  return `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

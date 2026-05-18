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
const DEFAULT_TOKEN_BUDGET = 6000;
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
    "The project should stay understandable to any developer opening the public demo."
  ], {
    tags: ["project", "todo"],
    facets: { category: "project-description" }
  }),
  object("synthesis.product-intent", "synthesis", "active", "Product intent", "memory/syntheses/product-intent.md", [
    "# Product intent",
    "",
    "The Todo App helps a single user keep a trustworthy short list of work without account setup or network dependency.",
    "",
    "Useful output means fast capture, clear completion state, and no surprise data loss after refresh."
  ], {
    tags: ["product-intent", "synthesis"],
    facets: { category: "product-intent" },
    evidence: [{ kind: "source", id: "source.product-brief" }]
  }),
  object("synthesis.feature-map", "synthesis", "active", "Feature map", "memory/syntheses/feature-map.md", [
    "# Feature map",
    "",
    "- Quick add creates a task from a single text input.",
    "- Filtered views separate all, active, completed, and overdue tasks.",
    "- Local persistence keeps tasks available after reload.",
    "- Empty states explain the current filter without sending the user to documentation."
  ], {
    tags: ["features", "synthesis"],
    facets: { category: "feature-map" },
    evidence: [{ kind: "source", id: "source.product-brief" }]
  }),
  object("synthesis.repository-map", "synthesis", "active", "Repository map", "memory/syntheses/repository-map.md", [
    "# Repository map",
    "",
    "Application code lives under `src/`, reusable UI pieces live under `src/components/`, and persistence helpers live under `src/storage/`.",
    "",
    "Tests mirror those areas under `test/` with browser coverage for task creation and filtering."
  ], {
    tags: ["repository-map", "synthesis"],
    facets: { category: "file-layout", applies_to: ["src/", "src/components/", "src/storage/", "test/"] },
    evidence: [{ kind: "source", id: "source.readme" }]
  }),
  object("architecture.local-first-todo-app", "architecture", "active", "Local-first todo architecture", "memory/architecture/local-first-todo-app.md", [
    "# Local-first todo architecture",
    "",
    "The app keeps task state in a small client-side store and persists a normalized task list to localStorage.",
    "",
    "Rendering code reads from the store; persistence code only serializes and validates task records."
  ], {
    tags: ["architecture", "local-first"],
    facets: { category: "architecture", applies_to: ["src/storage/", "src/App.tsx"] },
    evidence: [{ kind: "source", id: "source.readme" }]
  }),
  object("synthesis.stack-and-tooling", "synthesis", "active", "Stack and tooling", "memory/syntheses/stack-and-tooling.md", [
    "# Stack and tooling",
    "",
    "The demo Todo App uses TypeScript, Vite, and Vitest. Browser behavior is covered with Playwright-style flow tests.",
    "",
    "Package scripts are the preferred interface for build, test, and lint checks."
  ], {
    tags: ["stack", "tooling", "synthesis"],
    facets: { category: "stack", applies_to: ["package.json", "vite.config.ts", "vitest.config.ts"] },
    evidence: [{ kind: "source", id: "source.package-json" }]
  }),
  object("synthesis.conventions-quality", "synthesis", "active", "Conventions and quality bar", "memory/syntheses/conventions-quality.md", [
    "# Conventions and quality bar",
    "",
    "Keep task mutations explicit, preserve keyboard access for every task action, and keep empty states tied to the active filter.",
    "",
    "Avoid adding accounts, sync, or collaboration features unless the product scope changes."
  ], {
    tags: ["convention", "quality", "synthesis"],
    facets: { category: "convention", applies_to: ["src/components/", "test/"] },
    evidence: [{ kind: "source", id: "source.product-brief" }]
  }),
  object("constraint.offline-first", "constraint", "active", "Stay offline first", "memory/constraints/offline-first.md", [
    "# Stay offline first",
    "",
    "Task creation, completion, filtering, and persistence must work without a backend service.",
    "",
    "Do not add a hosted database or login flow to satisfy demo requirements."
  ], {
    tags: ["offline", "business-rule"],
    facets: { category: "business-rule", applies_to: ["src/storage/"] },
    evidence: [{ kind: "source", id: "source.product-brief" }]
  }),
  object("concept.quick-add", "concept", "active", "Quick add", "memory/concepts/quick-add.md", [
    "# Quick add",
    "",
    "Quick add accepts a non-empty task title, trims whitespace, creates an active task, and clears the input after save."
  ], {
    tags: ["feature", "tasks"],
    facets: { category: "product-feature", applies_to: ["src/components/TaskComposer.tsx"] }
  }),
  object("concept.filtered-views", "concept", "active", "Filtered task views", "memory/concepts/filtered-views.md", [
    "# Filtered task views",
    "",
    "The list supports all, active, completed, and overdue views. Counts must match the same predicate used to render each view."
  ], {
    tags: ["feature", "filters"],
    facets: { category: "product-feature", applies_to: ["src/components/TaskFilters.tsx"] }
  }),
  object("fact.storage-localstorage", "fact", "active", "LocalStorage persistence", "memory/facts/storage-localstorage.md", [
    "# LocalStorage persistence",
    "",
    "The task store writes a JSON array of task records to localStorage and ignores malformed saved records on load."
  ], {
    tags: ["storage", "debugging"],
    facets: { category: "debugging-fact", applies_to: ["src/storage/tasks.ts"], load_modes: ["debugging", "review"] }
  }),
  object("workflow.local-development", "workflow", "active", "Local development workflow", "memory/workflows/local-development.md", [
    "# Local development workflow",
    "",
    "Run `pnpm install`, `pnpm dev`, and then open the Vite URL. Use the browser flow before changing persistence behavior."
  ], {
    tags: ["workflow", "development"],
    facets: { category: "workflow", load_modes: ["onboarding", "coding"] },
    evidence: [{ kind: "source", id: "source.package-json" }]
  }),
  object("workflow.post-task-verification", "workflow", "active", "Post-task verification", "memory/workflows/post-task-verification.md", [
    "# Post-task verification",
    "",
    "Before finishing Todo App work, run `pnpm test`, `pnpm run typecheck`, and a browser check for add, complete, filter, and reload behavior."
  ], {
    tags: ["testing", "verification", "workflow"],
    facets: { category: "testing", applies_to: ["test/", "src/storage/tasks.ts"], load_modes: ["coding", "review"] },
    evidence: [{ kind: "source", id: "source.package-json" }]
  }),
  object("gotcha.completed-filter-counts", "gotcha", "active", "Completed filter counts can drift", "memory/gotchas/completed-filter-counts.md", [
    "# Completed filter counts can drift",
    "",
    "Do not compute filter badges with a different predicate than the rendered list. This caused completed tasks to appear in the active count before."
  ], {
    tags: ["gotcha", "filters"],
    facets: { category: "gotcha", applies_to: ["src/components/TaskFilters.tsx"], load_modes: ["debugging", "review"] }
  }),
  object("question.recurring-tasks", "question", "open", "Recurring task scope", "memory/questions/recurring-tasks.md", [
    "# Recurring task scope",
    "",
    "Should recurring tasks be part of the Todo App, or should the app stay focused on one-off personal tasks for the first release?"
  ], {
    tags: ["question", "scope"],
    facets: { category: "open-question" }
  }),
  object("synthesis.agent-guidance", "synthesis", "active", "Agent guidance", "memory/syntheses/agent-guidance.md", [
    "# Agent guidance",
    "",
    "Load Memory before non-trivial Todo App work. Preserve the offline-first scope, keep UI behavior keyboard accessible, and verify persistence after reload."
  ], {
    tags: ["agents", "guidance", "synthesis"],
    facets: { category: "agent-guidance", applies_to: ["AGENTS.md"] },
    evidence: [{ kind: "source", id: "source.agent-guidance" }]
  }),
  object("source.product-brief", "source", "active", "Source: docs/product-brief.md", "memory/sources/product-brief.md", [
    "# Source: docs/product-brief.md",
    "",
    "The product brief describes a local-first Todo App for quick capture, filtering, and dependable reload behavior."
  ], {
    tags: ["source", "product"],
    facets: { category: "source", applies_to: ["docs/product-brief.md"] },
    evidence: [{ kind: "file", id: "docs/product-brief.md" }]
  }),
  object("source.package-json", "source", "active", "Source: package.json", "memory/sources/package-json.md", [
    "# Source: package.json",
    "",
    "The package manifest records TypeScript, Vite, Vitest, and the package scripts used for local development and verification."
  ], {
    tags: ["source", "package"],
    facets: { category: "source", applies_to: ["package.json"] },
    evidence: [{ kind: "file", id: "package.json" }]
  }),
  object("source.readme", "source", "active", "Source: README.md", "memory/sources/readme.md", [
    "# Source: README.md",
    "",
    "The README explains the Todo App repository layout, local development path, and browser behavior users should expect."
  ], {
    tags: ["source", "readme"],
    facets: { category: "source", applies_to: ["README.md"] },
    evidence: [{ kind: "file", id: "README.md" }]
  }),
  object("source.agent-guidance", "source", "active", "Source: AGENTS.md", "memory/sources/agent-guidance.md", [
    "# Source: AGENTS.md",
    "",
    "Agent instructions require loading memory before substantial Todo App changes and saving only durable project knowledge."
  ], {
    tags: ["source", "agents"],
    facets: { category: "source", applies_to: ["AGENTS.md"] },
    evidence: [{ kind: "file", id: "AGENTS.md" }]
  })
];

const RELATION_FIXTURES = [
  relation("rel.project-todo-app-implements-concept-quick-add", "project.todo-app", "implements", "concept.quick-add"),
  relation("rel.project-todo-app-implements-concept-filtered-views", "project.todo-app", "implements", "concept.filtered-views"),
  relation("rel.synthesis-product-intent-summarizes-project-todo-app", "synthesis.product-intent", "summarizes", "project.todo-app"),
  relation("rel.synthesis-feature-map-documents-project-todo-app", "synthesis.feature-map", "documents", "project.todo-app"),
  relation("rel.synthesis-repository-map-documents-project-todo-app", "synthesis.repository-map", "documents", "project.todo-app"),
  relation("rel.architecture-local-first-todo-app-documents-project-todo-app", "architecture.local-first-todo-app", "documents", "project.todo-app"),
  relation("rel.synthesis-stack-and-tooling-documents-project-todo-app", "synthesis.stack-and-tooling", "documents", "project.todo-app"),
  relation("rel.synthesis-conventions-quality-documents-project-todo-app", "synthesis.conventions-quality", "documents", "project.todo-app"),
  relation("rel.synthesis-agent-guidance-documents-project-todo-app", "synthesis.agent-guidance", "documents", "project.todo-app"),
  relation("rel.workflow-local-development-supports-project-todo-app", "workflow.local-development", "supports", "project.todo-app"),
  relation("rel.workflow-post-task-verification-supports-project-todo-app", "workflow.post-task-verification", "supports", "project.todo-app"),
  relation("rel.constraint-offline-first-affects-project-todo-app", "constraint.offline-first", "affects", "project.todo-app"),
  relation("rel.synthesis-product-intent-derived-from-source-product-brief", "synthesis.product-intent", "derived_from", "source.product-brief"),
  relation("rel.synthesis-feature-map-derived-from-source-product-brief", "synthesis.feature-map", "derived_from", "source.product-brief"),
  relation("rel.question-recurring-tasks-challenges-synthesis-feature-map", "question.recurring-tasks", "challenges", "synthesis.feature-map"),
  relation("rel.synthesis-feature-map-summarizes-concept-quick-add", "synthesis.feature-map", "summarizes", "concept.quick-add"),
  relation("rel.synthesis-feature-map-summarizes-concept-filtered-views", "synthesis.feature-map", "summarizes", "concept.filtered-views"),
  relation("rel.synthesis-repository-map-derived-from-source-readme", "synthesis.repository-map", "derived_from", "source.readme"),
  relation("rel.architecture-local-first-derived-from-source-readme", "architecture.local-first-todo-app", "derived_from", "source.readme"),
  relation("rel.synthesis-stack-and-tooling-derived-from-source-package-json", "synthesis.stack-and-tooling", "derived_from", "source.package-json"),
  relation("rel.synthesis-conventions-quality-derived-from-source-product-brief", "synthesis.conventions-quality", "derived_from", "source.product-brief"),
  relation("rel.workflow-local-development-derived-from-source-package-json", "workflow.local-development", "derived_from", "source.package-json"),
  relation("rel.workflow-post-task-verification-derived-from-source-package-json", "workflow.post-task-verification", "derived_from", "source.package-json"),
  relation("rel.constraint-offline-first-derived-from-source-product-brief", "constraint.offline-first", "derived_from", "source.product-brief"),
  relation("rel.gotcha-completed-filter-counts-affects-concept-filtered-views", "gotcha.completed-filter-counts", "affects", "concept.filtered-views"),
  relation("rel.concept-filtered-views-depends-on-fact-storage-localstorage", "concept.filtered-views", "depends_on", "fact.storage-localstorage"),
  relation("rel.synthesis-agent-guidance-derived-from-source-agent-guidance", "synthesis.agent-guidance", "derived_from", "source.agent-guidance"),
  relation("rel.constraint-offline-first-requires-fact-storage-localstorage", "constraint.offline-first", "requires", "fact.storage-localstorage")
];

const ROLE_DEFINITIONS = [
  role("product-intent", "Product Intent", "What this project is for and what useful output means.", ["synthesis.product-intent"]),
  role("capability-map", "Capability Map", "Features, outputs, commands, APIs, or generation capabilities.", ["synthesis.feature-map", "concept.quick-add", "concept.filtered-views"]),
  role("repository-map", "Repository Map", "Where important code, docs, tests, assets, and configs live.", ["synthesis.repository-map"]),
  role("architecture-patterns", "Architecture / Patterns", "How the project is organized and which design patterns matter.", ["architecture.local-first-todo-app"]),
  role("stack-tooling", "Stack / Tooling", "Languages, frameworks, package managers, build tools, and runtime constraints.", ["synthesis.stack-and-tooling"]),
  role("conventions-quality", "Conventions / Quality Bar", "Project-specific coding, design, review, and quality expectations.", ["synthesis.conventions-quality", "constraint.offline-first"]),
  role("workflows-howtos", "Workflows / How-tos", "Reusable setup, release, debugging, migration, generation, or maintenance procedures.", ["workflow.local-development", "workflow.post-task-verification"]),
  role("verification", "Verification", "Commands and checks agents should run before claiming work is done.", ["workflow.post-task-verification"]),
  role("gotchas-risks", "Gotchas / Risks", "Known traps, fragile areas, abandoned approaches, or recurring failure modes.", ["gotcha.completed-filter-counts"]),
  role("open-questions", "Open Questions", "Important unknowns agents should not guess.", ["question.recurring-tasks"]),
  role("sources-provenance", "Sources / Provenance", "Source records and provenance relations backing durable memory.", ["source.product-brief", "source.package-json", "source.readme", "source.agent-guidance"]),
  role("agent-guidance", "Agent Guidance", "Project-specific operating rules for AI coding agents.", ["synthesis.agent-guidance"]),
  role("branch-handoff", "Branch Handoff", "Current branch continuity for unfinished work.", [], { optional: true })
];

const LENS_DEFINITIONS = [
  lens("project-map", "Project Map", "Default overview for purpose, capabilities, layout, stack, and operating norms.", [
    "product-intent",
    "capability-map",
    "repository-map",
    "architecture-patterns",
    "stack-tooling",
    "conventions-quality",
    "workflows-howtos",
    "verification",
    "gotchas-risks",
    "open-questions",
    "agent-guidance"
  ]),
  lens("current-work", "Current Work", "Open scope questions and verification context for the next Todo App change.", [
    "open-questions",
    "verification",
    "gotchas-risks"
  ]),
  lens("review-risk", "Review / Risk", "Quality expectations, verification, risks, and unresolved questions.", [
    "conventions-quality",
    "verification",
    "gotchas-risks",
    "open-questions"
  ]),
  lens("provenance", "Provenance", "Source records and relation chains that explain where durable memory came from.", [
    "sources-provenance",
    "product-intent",
    "capability-map",
    "architecture-patterns"
  ]),
  lens("maintenance", "Maintenance", "Coverage gaps, stale memory, supersessions, and conflicts that need cleanup.", [
    "product-intent",
    "capability-map",
    "repository-map",
    "architecture-patterns",
    "stack-tooling",
    "conventions-quality",
    "workflows-howtos",
    "verification",
    "gotchas-risks",
    "open-questions",
    "sources-provenance",
    "agent-guidance",
    "branch-handoff"
  ])
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
  const roleCoverage = buildRoleCoverage(relations);
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
      source_objects: objects.filter((object) => object.type === "source").length,
      synthesis_objects: objects.filter((object) => object.type === "synthesis").length,
      active_relations: relations.filter((relation) => relation.status === "active").length
    },
    role_coverage: roleCoverage,
    lenses: buildLenses(objects, relations, roleCoverage),
    audit_findings: [],
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
      source: "synthetic-todo-app-memory"
    },
    defaults: {
      token_budget: DEFAULT_TOKEN_BUDGET,
      mode: "coding"
    },
    meta,
    projects,
    bootstrap
  };
}

function object(id, type, status, title, bodyPath, lines, options = {}) {
  const origin =
    options.origin ??
    (type === "source"
      ? sourceOriginFromEvidence(options.evidence ?? [])
      : null);

  return {
    id,
    type,
    status,
    title,
    body_path: bodyPath,
    tags: options.tags ?? [],
    facets: options.facets ?? null,
    evidence: options.evidence ?? [],
    origin,
    body: `${lines.join("\n").trim()}\n`
  };
}

function sourceOriginFromEvidence(evidence) {
  const fileEvidence = evidence.find((item) => item.kind === "file");

  if (fileEvidence === undefined) {
    return null;
  }

  const mediaType = mediaTypeForPath(fileEvidence.id);

  return {
    kind: "file",
    locator: fileEvidence.id,
    captured_at: CREATED_AT,
    ...(mediaType === undefined ? {} : { media_type: mediaType })
  };
}

function mediaTypeForPath(path) {
  const lower = path.toLowerCase();

  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return "text/markdown";
  }
  if (lower.endsWith(".txt")) {
    return "text/plain";
  }
  if (lower.endsWith(".json")) {
    return "application/json";
  }
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return "text/html";
  }

  return undefined;
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

function role(key, label, description, memoryIds, options = {}) {
  return {
    key,
    label,
    description,
    memoryIds,
    optional: options.optional === true
  };
}

function lens(name, title, description, roleKeys) {
  return {
    name,
    title,
    description,
    roleKeys
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
    scope: {
      kind: "project",
      project: DEMO_PROJECT_ID,
      branch: null,
      task: null
    },
    tags: [...fixture.tags].sort(),
    facets: fixture.facets,
    evidence: [...fixture.evidence].sort(compareEvidence),
    source: {
      kind: "system",
      task: "Curated public Todo App demo seed"
    },
    origin: fixture.origin,
    superseded_by: null,
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

function buildRoleCoverage(relations) {
  const roles = ROLE_DEFINITIONS.map((definition) => {
    const relationIds = relations
      .filter(
        (relation) =>
          definition.memoryIds.includes(relation.from) ||
          definition.memoryIds.includes(relation.to) ||
          (definition.key === "sources-provenance" &&
            ["derived_from", "supports", "summarizes", "documents"].includes(relation.predicate))
      )
      .map((relation) => relation.id)
      .sort();
    const status = definition.memoryIds.length === 0 ? "missing" : "populated";

    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      status,
      optional: definition.optional,
      memory_ids: [...definition.memoryIds].sort(),
      relation_ids: relationIds,
      gap: definition.optional && status === "missing"
        ? null
        : status === "missing"
          ? `${definition.label} is missing. Add source-backed memory when the project provides enough evidence.`
          : null
    };
  });
  const counts = {
    populated: 0,
    thin: 0,
    missing: 0,
    stale: 0,
    conflicted: 0
  };

  for (const item of roles) {
    counts[item.status] += 1;
  }

  return {
    roles,
    counts
  };
}

function buildLenses(objects, relations, roleCoverage) {
  const objectsById = new Map(objects.map((item) => [item.id, item]));
  const rolesByKey = new Map(roleCoverage.roles.map((item) => [item.key, item]));

  return LENS_DEFINITIONS.map((definition) => {
    const lensRoles = definition.roleKeys.map((key) => rolesByKey.get(key)).filter(Boolean);
    const includedIds = uniqueSorted(lensRoles.flatMap((item) => item.memory_ids));
    const relationList = relations.filter(
      (relation) => includedIds.includes(relation.from) || includedIds.includes(relation.to)
    );
    const generatedGaps = lensRoles.flatMap((item) => item.gap === null ? [] : [item.gap]);

    return {
      name: definition.name,
      title: definition.title,
      markdown: renderLensMarkdown({
        definition,
        roles: lensRoles,
        objects: includedIds.map((id) => objectsById.get(id)).filter(Boolean),
        relations: relationList,
        generatedGaps
      }),
      role_coverage: roleCoverage,
      included_memory_ids: includedIds,
      relation_ids: relationList.map((relation) => relation.id).sort(),
      relations: relationList,
      generated_gaps: generatedGaps
    };
  });
}

function renderLensMarkdown({ definition, roles, objects, relations, generatedGaps }) {
  const lines = [
    `# ${definition.title}`,
    "",
    definition.description,
    "",
    "## Role coverage",
    "",
    ...roles.map((item) => `- ${item.label}: ${item.status}${item.optional ? " (optional)" : ""}`),
    ""
  ];

  if (generatedGaps.length > 0) {
    lines.push("## Generated gaps", "", ...generatedGaps.map((gap) => `- ${gap}`), "");
  }

  for (const item of objects) {
    lines.push(`## ${item.title}`, "");
    lines.push(`Memory: \`${item.id}\` (${item.type}, ${item.status})`);
    lines.push("");
    lines.push(excerptBody(item.body));
    lines.push("");
  }

  if (relations.length > 0) {
    lines.push(
      "## Relation context",
      "",
      ...relations.map((item) => `- \`${item.from}\` ${item.predicate} \`${item.to}\` (${item.status})`),
      ""
    );
  }

  return `${trimTrailingBlankLines(lines).join("\n")}\n`;
}

function excerptBody(body) {
  return body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function trimTrailingBlankLines(lines) {
  const result = [...lines];

  while (result.at(-1) === "") {
    result.pop();
  }

  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

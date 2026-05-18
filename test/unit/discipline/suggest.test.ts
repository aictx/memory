import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapCandidateFiles,
  buildSuggestBootstrapPatchProposal,
  buildSuggestBootstrapPacket,
  buildSuggestAfterTaskPacket,
  buildSuggestFromDiffPacket
} from "../../../src/discipline/suggest.js";
import type { AuditFinding } from "../../../src/discipline/audit.js";
import type { ObjectId, ObjectStatus, ObjectType } from "../../../src/core/types.js";
import type { MemoryObjectSidecar, StoredMemoryObject } from "../../../src/storage/objects.js";
import type { CanonicalStorageSnapshot } from "../../../src/storage/read.js";
import type { MemoryRelation, StoredMemoryRelation } from "../../../src/storage/relations.js";
import { SCHEMA_FILES, compileProjectSchemas } from "../../../src/validation/schemas.js";
import { validatePatch } from "../../../src/validation/validate.js";

const tempRoots: string[] = [];
const TIMESTAMP = "2026-04-25T14:00:00+02:00";

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("suggest discipline packets", () => {
  it("builds deterministic from-diff packets from changed files and canonical memory", () => {
    const storage = storageSnapshot({
      objects: [
        memoryObject({
          id: "decision.webhook-retries",
          type: "decision",
          status: "active",
          title: "Webhook retries",
          body: "Webhook retries are handled by src/billing/webhook.ts."
        }),
        memoryObject({
          id: "constraint.billing-idempotency",
          type: "constraint",
          status: "active",
          title: "Billing idempotency",
          body: "Billing operations must be idempotent.",
          tags: ["billing"]
        }),
        memoryObject({
          id: "note.queue",
          type: "note",
          status: "active",
          title: "Queue",
          body: "Async jobs use the project queue."
        }),
        memoryObject({
          id: "gotcha.old-webhook",
          type: "gotcha",
          status: "stale",
          title: "Old webhook gotcha",
          body: "Old notes mention src/billing/webhook.ts."
        }),
        memoryObject({
          id: "fact.unrelated",
          type: "fact",
          status: "active",
          title: "Unrelated",
          body: "This memory should not match."
        })
      ],
      relations: [
        relation({
          id: "rel.worker-affects-billing",
          from: "note.queue",
          to: "constraint.billing-idempotency",
          fileEvidence: "src/billing/worker.ts"
        })
      ]
    });

    const packet = buildSuggestFromDiffPacket({
      changedFiles: [
        "src/billing/worker.ts",
        "src/billing/webhook.ts",
        "src/billing/webhook.ts"
      ],
      storage
    });

    expect(packet).toEqual({
      mode: "from_diff",
      changed_files: ["src/billing/webhook.ts", "src/billing/worker.ts"],
      related_memory_ids: [
        "constraint.billing-idempotency",
        "decision.webhook-retries",
        "gotcha.old-webhook",
        "note.queue"
      ],
      possible_stale_ids: [
        "constraint.billing-idempotency",
        "decision.webhook-retries"
      ],
      recommended_memory: ["synthesis", "decision", "constraint", "gotcha", "workflow", "fact"],
      recommended_evidence: [
        { kind: "file", id: "src/billing/webhook.ts" },
        { kind: "file", id: "src/billing/worker.ts" }
      ],
      recommended_relations: [
        {
          from: "decision.webhook-retries",
          predicate: "requires",
          to: "constraint.billing-idempotency",
          reason: "Related memory overlaps changed files but has no direct relation."
        }
      ],
      agent_checklist: [
        "Create memory only for durable future value.",
        "Prefer updating, marking stale, or superseding existing memory over creating duplicates.",
        "Use current code, tests, manifests, and user instructions as evidence.",
        "Right-size memory: atomic for precise claims, source for provenance, synthesis for compact area-level understanding.",
        "Treat failure, confusion, user correction, and memory conflicts as signals to repair durable memory.",
        "Save nothing if the work produced no durable future value."
      ]
    });
  });

  it("ranks bootstrap candidate files and ignores generated or hidden Memory files", async () => {
    const projectRoot = await createTempRoot("memory-discipline-bootstrap-rank-");
    await writeProjectFile(projectRoot, "README.md", "# Test\n");
    await writeProjectFile(projectRoot, "package.json", "{}\n");
    await writeProjectFile(projectRoot, "docs/guide.md", "# Guide\n");
    await writeProjectFile(projectRoot, "src/z.ts", "export const z = 1;\n");
    await writeProjectFile(projectRoot, "test/a.test.ts", "import { it } from 'vitest';\n");
    await writeProjectFile(projectRoot, "dist/generated.ts", "ignored\n");
    await writeProjectFile(projectRoot, ".memory/memory/project.md", "ignored\n");
    await writeProjectFile(projectRoot, "node_modules/pkg/index.js", "ignored\n");

    await expect(bootstrapCandidateFiles(projectRoot)).resolves.toEqual([
      "README.md",
      "package.json",
      "docs/guide.md",
      "src/z.ts",
      "test/a.test.ts"
    ]);
  });

  it("builds bootstrap packets with bootstrap recommendations and existing matches", async () => {
    const projectRoot = await createTempRoot("memory-discipline-bootstrap-packet-");
    await writeProjectFile(projectRoot, "README.md", "# Test\n");
    await writeProjectFile(projectRoot, "docs/guide.md", "# Guide\n");
    const storage = storageSnapshot({
      objects: [
        memoryObject({
          id: "workflow.guide",
          type: "workflow",
          status: "active",
          title: "Guide workflow",
          body: "The bootstrap guide lives in docs/guide.md."
        })
      ],
      relations: []
    });

    const packet = await buildSuggestBootstrapPacket({
      projectRoot,
      storage
    });

    expect(packet.mode).toBe("bootstrap");
    expect(packet.changed_files).toEqual(["README.md", "docs/guide.md"]);
    expect(packet.related_memory_ids).toEqual(["workflow.guide"]);
    expect(packet.possible_stale_ids).toEqual(["workflow.guide"]);
    expect(packet.recommended_memory).toEqual([
      "project",
      "architecture",
      "source",
      "synthesis",
      "workflow",
      "constraint",
      "gotcha",
      "decision"
    ]);
    expect(packet.agent_checklist).toContain(
      "During setup, capture explicit product features in a maintained feature-map synthesis backed by source records; mark removed or replaced feature memories stale or superseded."
    );
  });

  it("builds after-task packets with recommended facets and save/no-save checklist", () => {
    const storage = storageSnapshot({
      objects: [
        memoryObject({
          id: "decision.webhook-retries",
          type: "decision",
          status: "active",
          title: "Webhook retries",
          body: "Webhook retry behavior references src/billing/webhook.ts."
        })
      ],
      relations: []
    });

    const packet = buildSuggestAfterTaskPacket({
      task: "Refactor webhook tests",
      changedFiles: ["src/billing/webhook.ts", "test/billing/webhook.test.ts"],
      storage
    });

    expect(packet.mode).toBe("after_task");
    expect(packet.task).toBe("Refactor webhook tests");
    expect(packet.changed_files).toEqual([
      "src/billing/webhook.ts",
      "test/billing/webhook.test.ts"
    ]);
    expect(packet.related_memory_ids).toEqual(["decision.webhook-retries"]);
    expect(packet.recommended_evidence).toEqual([
      { kind: "file", id: "src/billing/webhook.ts" },
      { kind: "file", id: "test/billing/webhook.test.ts" }
    ]);
    expect(packet.recommended_facets).toEqual(
      expect.arrayContaining([
        "testing",
        "decision-rationale",
        "abandoned-attempt",
        "domain",
        "bounded-context",
        "capability",
        "business-rule"
      ])
    );
    expect(packet.recommended_facets).not.toContain("unresolved-conflict");
    expect(packet.save_decision_checklist).toContain(
      "Save memory only when the task produced durable future value."
    );
    expect(packet.save_decision_checklist).toContain(
      "Back durable synthesis memory with source evidence or source provenance relations when possible."
    );
    expect(packet.recommended_actions?.[0]).toMatchObject({
      action: "update_existing",
      confidence: "high",
      target_id: "decision.webhook-retries"
    });
    expect(packet.recommended_actions?.some((action) => action.action === "save_nothing")).toBe(
      true
    );
  });

  it("adds repair candidates from audit findings and ranks repair actions before new memory", () => {
    const storage = storageSnapshot({
      objects: [
        memoryObject({
          id: "source.readme",
          type: "source",
          status: "active",
          title: "Source README",
          body: "README source record references README.md."
        }),
        memoryObject({
          id: "decision.retry",
          type: "decision",
          status: "active",
          title: "Retry behavior",
          body: "Retry behavior is documented in src/retry.ts."
        })
      ],
      relations: []
    });
    const auditFindings: AuditFinding[] = [
      {
        severity: "warning",
        rule: "source_origin_outdated",
        memory_id: "source.readme",
        message: "Source origin digest no longer matches.",
        evidence: [{ kind: "file", id: "README.md" }]
      },
      {
        severity: "info",
        rule: "possibly_stale_changed_reference",
        memory_id: "decision.retry",
        message: "Referenced file changed repeatedly.",
        evidence: [{ kind: "file", id: "src/retry.ts" }]
      }
    ];

    const packet = buildSuggestAfterTaskPacket({
      task: "Add a product feature and repair stale memory",
      changedFiles: ["src/feature.ts"],
      storage,
      auditFindings
    });

    expect(packet.repair_candidates).toEqual([
      expect.objectContaining({
        target_id: "source.readme",
        rule: "source_origin_outdated",
        suggested_action: "update_existing",
        confidence: "high"
      }),
      expect.objectContaining({
        target_id: "decision.retry",
        rule: "possibly_stale_changed_reference",
        suggested_action: "update_existing",
        confidence: "medium"
      })
    ]);
    expect(packet.related_memory_ids).toEqual(["decision.retry", "source.readme"]);
    expect(packet.possible_stale_ids).toEqual(["decision.retry", "source.readme"]);
    expect(packet.recommended_actions?.[0]).toMatchObject({
      action: "update_existing",
      target_id: "source.readme",
      confidence: "high"
    });
    expect(packet.recommended_actions?.[1]).toMatchObject({
      action: "update_existing",
      target_id: "decision.retry"
    });
    expect(packet.recommended_actions?.findIndex((action) => action.action === "create_memory"))
      .toBeGreaterThan(1);
  });

  it("ranks save-nothing first when no durable after-task signal is detected", () => {
    const storage = storageSnapshot({
      objects: [],
      relations: []
    });

    const packet = buildSuggestAfterTaskPacket({
      task: "Summarize recent discussion",
      changedFiles: [],
      storage
    });

    expect(packet.recommended_actions?.[0]).toMatchObject({
      rank: 1,
      action: "save_nothing",
      confidence: "high"
    });
    expect(packet.recommended_actions?.[0]?.remember_template).toBeUndefined();
  });

  it("prefers workflow memory and facets for reusable how-to procedure tasks", () => {
    const storage = storageSnapshot({
      objects: [],
      relations: []
    });

    const packet = buildSuggestAfterTaskPacket({
      task: "Document how to run the release smoke test checklist",
      changedFiles: ["docs/release-runbook.md", "package.json"],
      storage
    });

    expect(packet.recommended_memory[0]).toBe("workflow");
    expect(packet.recommended_facets?.[0]).toBe("workflow");
    expect(packet.remember_template?.memories?.[0]).toMatchObject({
      kind: "workflow",
      category: "workflow",
      applies_to: ["docs/release-runbook.md", "package.json"],
      evidence: [
        { kind: "file", id: "docs/release-runbook.md" },
        { kind: "file", id: "package.json" }
      ]
    });
    expect(packet.recommended_actions?.[0]).toMatchObject({
      action: "create_memory",
      memory_kind: "workflow",
      category: "workflow",
      confidence: "high",
      remember_template: {
        task: "Document how to run the release smoke test checklist",
        memories: [
          {
            kind: "workflow",
            title: "",
            body: "",
            category: "workflow",
            applies_to: ["docs/release-runbook.md", "package.json"],
            evidence: [
              { kind: "file", id: "docs/release-runbook.md" },
              { kind: "file", id: "package.json" }
            ]
          }
        ]
      }
    });
  });

  it("recommends unresolved-conflict facets for conflict and correction task signals", () => {
    const storage = storageSnapshot({
      objects: [],
      relations: []
    });

    const packet = buildSuggestAfterTaskPacket({
      task: "Capture corrections for stale assumptions and conflicts",
      changedFiles: [],
      storage
    });

    expect(packet.recommended_facets).toContain("unresolved-conflict");
    expect(packet.recommended_actions?.[0]).toMatchObject({
      action: "create_memory",
      memory_kind: "question",
      category: "unresolved-conflict",
      confidence: "high"
    });
  });

  it("recommends gotcha memory for repeated failure and debugging lessons", () => {
    const storage = storageSnapshot({
      objects: [],
      relations: []
    });

    const packet = buildSuggestAfterTaskPacket({
      task: "Capture root cause for broken export retry regression",
      changedFiles: ["src/export/retry.ts"],
      storage
    });

    expect(packet.recommended_actions?.[0]).toMatchObject({
      action: "create_memory",
      memory_kind: "gotcha",
      category: "gotcha",
      confidence: "high"
    });
  });

  it("recommends unresolved-conflict facets for active conflicting related memory", () => {
    const storage = storageSnapshot({
      objects: [
        memoryObject({
          id: "decision.webhook-worker",
          type: "decision",
          status: "active",
          title: "Webhook worker retries",
          body: "Webhook worker retry behavior references src/billing/webhook.ts."
        }),
        memoryObject({
          id: "decision.webhook-handler",
          type: "decision",
          status: "active",
          title: "Webhook handler retries",
          body: "Webhook handler retry behavior references src/billing/webhook.ts."
        })
      ],
      relations: [
        relation({
          id: "rel.webhook-worker-conflicts-handler",
          from: "decision.webhook-worker",
          predicate: "conflicts_with",
          to: "decision.webhook-handler"
        })
      ]
    });

    const packet = buildSuggestAfterTaskPacket({
      task: "Resolve webhook retry behavior",
      changedFiles: ["src/billing/webhook.ts"],
      storage
    });

    expect(packet.recommended_facets).toContain("unresolved-conflict");
    expect(packet.save_decision_checklist).toContain(
      "Use unresolved-conflict questions when current evidence cannot resolve contradictory active memory."
    );
    expect(packet.recommended_actions?.[0]).toMatchObject({
      action: "mark_stale",
      confidence: "high",
      target_id: "decision.webhook-handler"
    });
    expect(packet.recommended_actions?.some((action) => action.action === "supersede_existing")).toBe(
      true
    );
  });

  it("recommends synthesis memory and product-feature facets for feature work", () => {
    const storage = storageSnapshot({
      objects: [],
      relations: []
    });

    const packet = buildSuggestAfterTaskPacket({
      task: "Add a customer dashboard product feature",
      changedFiles: ["app/dashboard/page.tsx"],
      storage
    });

    expect(packet.recommended_memory).toContain("synthesis");
    expect(packet.recommended_facets).toContain("product-feature");
    expect(packet.recommended_facets).toContain("capability");
    expect(packet.recommended_evidence).toEqual([
      { kind: "file", id: "app/dashboard/page.tsx" }
    ]);
    expect(packet.recommended_actions?.[0]).toMatchObject({
      action: "create_memory",
      memory_kind: "synthesis",
      category: "feature-map",
      confidence: "medium"
    });
    expect(packet.recommended_actions?.[0]?.remember_template).toMatchObject({
      memories: [
        {
          kind: "synthesis",
          category: "feature-map",
          applies_to: ["app/dashboard/page.tsx"],
          evidence: [{ kind: "file", id: "app/dashboard/page.tsx" }]
        }
      ]
    });
  });

  it("builds a conservative schema-valid bootstrap patch from deterministic evidence", async () => {
    const projectRoot = await createTempRoot("memory-discipline-bootstrap-patch-");
    await writeProjectFile(
      projectRoot,
      "README.md",
      "# Billing API\n\nHandles recurring billing and webhook processing for Stripe.\n"
    );
    await writeJsonProjectFile(projectRoot, "package.json", {
      name: "@example/billing-api",
      description: "Billing API for Stripe webhook processing.",
      type: "module",
      packageManager: "pnpm@10.0.0",
      engines: {
        node: ">=22"
      },
      scripts: {
        build: "tsc --noEmit",
        test: "vitest run"
      },
      devDependencies: {
        vitest: "^4.0.0"
      }
    });
    await writeProjectFile(projectRoot, "tsconfig.json", "{}\n");
    await writeProjectFile(projectRoot, "src/index.ts", "export const value = 1;\n");
    await writeProjectFile(projectRoot, "test/index.test.ts", "import { it } from 'vitest';\n");
    await writeBundledSchemas(projectRoot);
    const storage = storageSnapshot({
      objects: [
        initialProjectObject("project.billing-api", "Billing API"),
        initialArchitectureObject("project.billing-api")
      ],
      relations: [],
      projectId: "project.billing-api",
      projectName: "Billing API"
    });

    const proposal = await buildSuggestBootstrapPatchProposal({
      projectRoot,
      storage
    });

    expect(proposal.proposed).toBe(true);
    expect(proposal.patch).not.toBeNull();
    expect(proposal.reason).toBeNull();
    expect(proposal.packet.mode).toBe("bootstrap");
    expect(proposal.patch?.changes.map((change) => change.op)).toEqual(
      expect.arrayContaining(["update_object", "create_relation", "create_object"])
    );
    expect(proposal.patch?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: "update_object", id: "project.billing-api" }),
        expect.objectContaining({ op: "update_object", id: "architecture.current" }),
        expect.objectContaining({
          op: "create_relation",
          id: "rel.project-billing-api-related-to-architecture-current",
          from: "project.billing-api",
          predicate: "related_to",
          to: "architecture.current",
          status: "active",
          confidence: "high"
        }),
        expect.objectContaining({
          op: "create_object",
          id: "source.readme",
          type: "source",
          facets: expect.objectContaining({ category: "source" }),
          origin: {
            kind: "file",
            locator: "README.md",
            digest: await fileDigest(projectRoot, "README.md"),
            media_type: "text/markdown"
          }
        }),
        expect.objectContaining({
          op: "create_object",
          id: "source.package-json",
          type: "source",
          facets: expect.objectContaining({ category: "source" }),
          origin: {
            kind: "file",
            locator: "package.json",
            digest: await fileDigest(projectRoot, "package.json"),
            media_type: "application/json"
          }
        }),
        expect.objectContaining({
          op: "create_object",
          id: "synthesis.product-intent",
          type: "synthesis",
          facets: expect.objectContaining({ category: "product-intent" }),
          evidence: expect.arrayContaining([
            { kind: "source", id: "source.readme" },
            { kind: "source", id: "source.package-json" }
          ])
        }),
        expect.objectContaining({
          op: "create_relation",
          from: "synthesis.product-intent",
          predicate: "derived_from",
          to: "source.readme",
          evidence: [{ kind: "source", id: "source.readme" }]
        }),
        expect.objectContaining({ op: "create_object", id: "workflow.package-scripts" }),
        expect.objectContaining({
          op: "create_object",
          id: "workflow.post-task-verification",
          facets: expect.objectContaining({ category: "testing" })
        }),
        expect.objectContaining({ op: "create_object", id: "constraint.node-engine" }),
        expect.objectContaining({ op: "create_object", id: "constraint.package-manager" })
      ])
    );
    const validators = await compileProjectSchemas(projectRoot);
    expect(validators.ok).toBe(true);
    if (validators.ok && proposal.patch !== null) {
      expect(validatePatch(validators.data, proposal.patch).valid).toBe(true);
    }
  });

  it("creates a source-backed feature-map synthesis from explicit README feature bullets", async () => {
    const projectRoot = await createTempRoot("memory-discipline-bootstrap-features-");
    await writeProjectFile(
      projectRoot,
      "README.md",
      [
        "# Billing API",
        "",
        "Handles recurring billing for Stripe.",
        "",
        "## Features",
        "",
        "- Customer dashboard: Shows subscription status and invoices.",
        "- Webhook event log for support teams.",
        ""
      ].join("\n")
    );
    await writeBundledSchemas(projectRoot);
    const storage = storageSnapshot({
      objects: [
        initialProjectObject("project.billing-api", "Billing API"),
        initialArchitectureObject("project.billing-api")
      ],
      relations: [projectArchitectureRelation("project.billing-api")],
      projectId: "project.billing-api",
      projectName: "Billing API"
    });

    const proposal = await buildSuggestBootstrapPatchProposal({
      projectRoot,
      storage
    });

    expect(proposal.proposed).toBe(true);
    expect(proposal.packet.recommended_memory).toContain("synthesis");
    expect(proposal.packet.recommended_facets).toEqual(["product-feature"]);
    expect(proposal.patch?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: "create_object",
          id: "source.readme",
          type: "source",
          evidence: [{ kind: "file", id: "README.md" }]
        }),
        expect.objectContaining({
          op: "create_object",
          id: "synthesis.feature-map",
          type: "synthesis",
          title: "Feature map",
          tags: ["synthesis", "features"],
          facets: {
            category: "feature-map",
            applies_to: ["README.md"],
            load_modes: ["coding", "onboarding"]
          },
          evidence: [{ kind: "source", id: "source.readme" }]
        }),
        expect.objectContaining({
          op: "create_relation",
          from: "synthesis.feature-map",
          predicate: "derived_from",
          to: "source.readme",
          status: "active",
          confidence: "high",
          evidence: [{ kind: "source", id: "source.readme" }]
        })
      ])
    );
    const featureMap = proposal.patch?.changes.find(
      (change) => change.op === "create_object" && change.id === "synthesis.feature-map"
    );
    expect(featureMap?.op === "create_object" ? featureMap.body : "").toContain(
      "Customer dashboard"
    );
    expect(featureMap?.op === "create_object" ? featureMap.body : "").toContain(
      "Webhook event log"
    );

    const validators = await compileProjectSchemas(projectRoot);
    expect(validators.ok).toBe(true);
    if (validators.ok && proposal.patch !== null) {
      expect(validatePatch(validators.data, proposal.patch).valid).toBe(true);
    }
  });

  it("creates verification and convention memory from agent guidance while ignoring generated Memory blocks", async () => {
    const projectRoot = await createTempRoot("memory-discipline-bootstrap-agent-guidance-");
    await writeProjectFile(
      projectRoot,
      "README.md",
      "# Billing API\n\nHandles recurring billing for Stripe.\n"
    );
    await writeJsonProjectFile(projectRoot, "package.json", {
      packageManager: "pnpm@10.0.0",
      scripts: {
        typecheck: "tsc --noEmit",
        test: "vitest run"
      }
    });
    await writeProjectFile(
      projectRoot,
      "AGENTS.md",
      [
        "# Agent instructions",
        "",
        "## Code Conventions",
        "",
        "- Prefer small TypeScript modules.",
        "- Avoid default exports in source files.",
        "- After changes, run `pnpm run lint`.",
        "",
        "<!-- memory:start -->",
        "## Memory",
        "- Never use generated convention text.",
        "- Run `pnpm run generated`.",
        "<!-- memory:end -->",
        ""
      ].join("\n")
    );
    await writeBundledSchemas(projectRoot);
    const storage = storageSnapshot({
      objects: [
        initialProjectObject("project.billing-api", "Billing API"),
        initialArchitectureObject("project.billing-api")
      ],
      relations: [projectArchitectureRelation("project.billing-api")],
      projectId: "project.billing-api",
      projectName: "Billing API"
    });

    const proposal = await buildSuggestBootstrapPatchProposal({
      projectRoot,
      storage
    });

    expect(proposal.proposed).toBe(true);
    expect(proposal.packet.recommended_facets).toEqual(["testing", "convention"]);
    const verification = proposal.patch?.changes.find(
      (change) => change.op === "create_object" && change.id === "workflow.post-task-verification"
    );
    expect(verification).toEqual(
      expect.objectContaining({
        facets: expect.objectContaining({ category: "testing" }),
        evidence: expect.arrayContaining([
          { kind: "file", id: "package.json" },
          { kind: "file", id: "AGENTS.md" }
        ])
      })
    );
    expect(verification?.op === "create_object" ? verification.body : "").toContain(
      "`pnpm run lint`"
    );
    expect(verification?.op === "create_object" ? verification.body : "").not.toContain(
      "generated"
    );

    const conventions = proposal.patch?.changes.find(
      (change) => change.op === "create_object" && change.id === "constraint.code-conventions"
    );
    expect(conventions).toEqual(
      expect.objectContaining({
        facets: {
          category: "convention",
          applies_to: ["AGENTS.md"],
          load_modes: ["coding", "review"]
        },
        evidence: [{ kind: "file", id: "AGENTS.md" }]
      })
    );
    expect(conventions?.op === "create_object" ? conventions.body : "").toContain(
      "Prefer small TypeScript modules."
    );
    expect(conventions?.op === "create_object" ? conventions.body : "").not.toContain(
      "generated convention"
    );

    const validators = await compileProjectSchemas(projectRoot);
    expect(validators.ok).toBe(true);
    if (validators.ok && proposal.patch !== null) {
      expect(validatePatch(validators.data, proposal.patch).valid).toBe(true);
    }
  });

  it("summarizes package bins, CLI commands, and route files in the feature-map synthesis", async () => {
    const projectRoot = await createTempRoot("memory-discipline-bootstrap-code-features-");
    await writeProjectFile(projectRoot, "README.md", "# Billing App\n");
    await writeJsonProjectFile(projectRoot, "package.json", {
      name: "billing-app",
      bin: {
        billing: "dist/cli.js"
      }
    });
    await writeProjectFile(
      projectRoot,
      "src/cli/commands/sync.ts",
      [
        "export function registerSync(program) {",
        "  program",
        "    .command(\"sync\")",
        "    .description(\"Synchronize billing data.\");",
        "}",
        ""
      ].join("\n")
    );
    await writeProjectFile(
      projectRoot,
      "app/dashboard/page.tsx",
      "export default function Page() {}\n"
    );
    await writeBundledSchemas(projectRoot);
    const storage = storageSnapshot({
      objects: [
        initialProjectObject("project.billing-app", "Billing App"),
        initialArchitectureObject("project.billing-app")
      ],
      relations: [projectArchitectureRelation("project.billing-app")],
      projectId: "project.billing-app",
      projectName: "Billing App"
    });

    const proposal = await buildSuggestBootstrapPatchProposal({
      projectRoot,
      storage
    });

    expect(proposal.proposed).toBe(true);
    expect(proposal.packet.recommended_memory).toContain("synthesis");
    expect(proposal.packet.recommended_facets).toEqual(["product-feature"]);
    expect(proposal.patch?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "source.package-json",
          type: "source",
          evidence: [{ kind: "file", id: "package.json" }]
        }),
        expect.objectContaining({
          id: "synthesis.feature-map",
          type: "synthesis",
          facets: expect.objectContaining({ category: "feature-map" }),
          evidence: expect.arrayContaining([
            { kind: "source", id: "source.package-json" }
          ])
        }),
        expect.objectContaining({
          op: "create_relation",
          from: "synthesis.feature-map",
          predicate: "derived_from",
          to: "source.package-json"
        })
      ])
    );
    const featureMap = proposal.patch?.changes.find(
      (change) => change.op === "create_object" && change.id === "synthesis.feature-map"
    );
    expect(featureMap?.op === "create_object" ? featureMap.body : "").toContain(
      "CLI binary billing"
    );
    expect(featureMap?.op === "create_object" ? featureMap.body : "").toContain(
      "CLI command sync"
    );
    expect(featureMap?.op === "create_object" ? featureMap.body : "").toContain(
      "Route /dashboard"
    );

    const validators = await compileProjectSchemas(projectRoot);
    expect(validators.ok).toBe(true);
    if (validators.ok && proposal.patch !== null) {
      expect(validatePatch(validators.data, proposal.patch).valid).toBe(true);
    }
  });

  it("links existing feature-map syntheses to source records during bootstrap when provenance is missing", async () => {
    const projectRoot = await createTempRoot("memory-discipline-bootstrap-existing-feature-");
    await writeProjectFile(
      projectRoot,
      "README.md",
      [
        "# Billing API",
        "",
        "## Features",
        "",
        "- Customer dashboard: Shows subscription status and invoices.",
        ""
      ].join("\n")
    );
    await writeBundledSchemas(projectRoot);
    const storage = storageSnapshot({
      objects: [
        memoryObject({
          id: "project.billing-api",
          type: "project",
          status: "active",
          title: "Billing API",
          body: "Existing project memory."
        }),
        memoryObject({
          id: "source.readme",
          type: "source",
          status: "active",
          title: "Source: README.md",
          body: "Existing README source."
        }),
        memoryObject({
          id: "synthesis.feature-map",
          type: "synthesis",
          status: "active",
          title: "Feature map",
          body: "Existing feature map."
        })
      ],
      relations: [],
      projectId: "project.billing-api",
      projectName: "Billing API"
    });

    const proposal = await buildSuggestBootstrapPatchProposal({
      projectRoot,
      storage
    });

    expect(proposal.proposed).toBe(true);
    expect(proposal.patch?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        op: "update_object",
        id: "source.readme",
        origin: {
          kind: "file",
          locator: "README.md",
          digest: await fileDigest(projectRoot, "README.md"),
          media_type: "text/markdown"
        }
      }),
      {
        op: "create_relation",
        id: "rel.synthesis-feature-map-derived-from-source-readme",
        from: "synthesis.feature-map",
        predicate: "derived_from",
        to: "source.readme",
        status: "active",
        confidence: "high",
        evidence: [{ kind: "source", id: "source.readme" }]
      },
      expect.objectContaining({
        op: "create_relation",
        from: "synthesis.feature-map",
        predicate: "documents",
        to: "project.billing-api"
      })
    ]));

    const validators = await compileProjectSchemas(projectRoot);
    expect(validators.ok).toBe(true);
    if (validators.ok && proposal.patch !== null) {
      expect(validatePatch(validators.data, proposal.patch).valid).toBe(true);
    }
  });

  it("repairs source origin without duplicating existing source-backed syntheses during bootstrap", async () => {
    const projectRoot = await createTempRoot("memory-discipline-bootstrap-linked-feature-");
    await writeProjectFile(
      projectRoot,
      "README.md",
      [
        "# Billing API",
        "",
        "## Features",
        "",
        "- Customer dashboard: Shows subscription status and invoices.",
        ""
      ].join("\n")
    );
    const storage = storageSnapshot({
      objects: [
        memoryObject({
          id: "project.billing-api",
          type: "project",
          status: "active",
          title: "Billing API",
          body: "Existing project memory."
        }),
        memoryObject({
          id: "source.readme",
          type: "source",
          status: "active",
          title: "Source: README.md",
          body: "Existing README source."
        }),
        memoryObject({
          id: "synthesis.feature-map",
          type: "synthesis",
          status: "active",
          title: "Feature map",
          body: "Existing feature map."
        })
      ],
      relations: [provenanceRelation("synthesis.feature-map", "source.readme")],
      projectId: "project.billing-api",
      projectName: "Billing API"
    });

    const proposal = await buildSuggestBootstrapPatchProposal({
      projectRoot,
      storage
    });

    expect(proposal.proposed).toBe(true);
    expect(proposal.patch?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        op: "update_object",
        id: "source.readme",
        origin: {
          kind: "file",
          locator: "README.md",
          digest: await fileDigest(projectRoot, "README.md"),
          media_type: "text/markdown"
        }
      }),
      expect.objectContaining({
        op: "create_relation",
        from: "synthesis.feature-map",
        predicate: "documents",
        to: "project.billing-api"
      })
    ]));
  });

  it("avoids duplicate bootstrap memories when deterministic objects already exist", async () => {
    const projectRoot = await createTempRoot("memory-discipline-bootstrap-duplicates-");
    await writeJsonProjectFile(projectRoot, "package.json", {
      description: "Billing API for Stripe webhook processing.",
      packageManager: "pnpm@10.0.0",
      engines: {
        node: ">=22"
      },
      scripts: {
        build: "tsc --noEmit"
      }
    });
    await writeProjectFile(projectRoot, "src/index.ts", "export const value = 1;\n");
    const storage = storageSnapshot({
      objects: [
        initialProjectObject("project.billing-api", "Billing API"),
        initialArchitectureObject("project.billing-api"),
        memoryObject({
          id: "workflow.package-scripts",
          type: "workflow",
          status: "active",
          title: "Package scripts",
          body: "Existing package script workflow."
        }),
        memoryObject({
          id: "workflow.post-task-verification",
          type: "workflow",
          status: "active",
          title: "Post-task verification",
          body: "Existing post-task verification workflow."
        }),
        memoryObject({
          id: "constraint.node-engine",
          type: "constraint",
          status: "active",
          title: "Node engine requirement",
          body: "Existing Node constraint."
        }),
        memoryObject({
          id: "constraint.package-manager",
          type: "constraint",
          status: "active",
          title: "Package manager",
          body: "Existing package manager constraint."
        }),
        memoryObject({
          id: "source.package-json",
          type: "source",
          status: "active",
          title: "Source: package.json",
          body: "Existing package source."
        }),
        memoryObject({
          id: "synthesis.product-intent",
          type: "synthesis",
          status: "active",
          title: "Product intent",
          body: "Existing product intent."
        }),
        memoryObject({
          id: "synthesis.agent-guidance",
          type: "synthesis",
          status: "active",
          title: "Agent guidance",
          body: "Existing agent guidance synthesis."
        }),
        memoryObject({
          id: "synthesis.repository-map",
          type: "synthesis",
          status: "active",
          title: "Repository map",
          body: "Existing repository map synthesis."
        }),
        memoryObject({
          id: "synthesis.stack-and-tooling",
          type: "synthesis",
          status: "active",
          title: "Stack and tooling",
          body: "Existing stack and tooling synthesis."
        }),
        memoryObject({
          id: "synthesis.conventions-quality",
          type: "synthesis",
          status: "active",
          title: "Conventions and quality bar",
          body: "Existing conventions and quality synthesis."
        })
      ],
      relations: [
        projectArchitectureRelation("project.billing-api"),
        provenanceRelation("synthesis.product-intent", "source.package-json"),
        provenanceRelation("synthesis.repository-map", "source.package-json"),
        provenanceRelation("synthesis.stack-and-tooling", "source.package-json"),
        provenanceRelation("synthesis.conventions-quality", "source.package-json")
      ],
      projectId: "project.billing-api",
      projectName: "Billing API"
    });

    const proposal = await buildSuggestBootstrapPatchProposal({
      projectRoot,
      storage
    });

    expect(proposal.patch?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: "update_object", id: "project.billing-api" }),
      expect.objectContaining({
        op: "update_object",
        id: "source.package-json",
        origin: {
          kind: "file",
          locator: "package.json",
          digest: await fileDigest(projectRoot, "package.json"),
          media_type: "application/json"
        }
      }),
      expect.objectContaining({
        op: "create_relation",
        from: "synthesis.product-intent",
        predicate: "summarizes",
        to: "project.billing-api"
      }),
      expect.objectContaining({
        op: "create_relation",
        from: "workflow.package-scripts",
        predicate: "supports",
        to: "project.billing-api"
      })
    ]));
  });

  it("proposes the missing starter relation for older initialized projects", async () => {
    const projectRoot = await createTempRoot("memory-discipline-bootstrap-starter-relation-");
    await writeProjectFile(projectRoot, "README.md", "# Tiny\n");
    const storage = storageSnapshot({
      objects: [
        initialProjectObject("project.tiny", "Tiny"),
        initialArchitectureObject("project.tiny")
      ],
      relations: [],
      projectId: "project.tiny",
      projectName: "Tiny"
    });

    const proposal = await buildSuggestBootstrapPatchProposal({
      projectRoot,
      storage
    });

    expect(proposal.proposed).toBe(true);
    expect(proposal.patch?.changes).toEqual(
      expect.arrayContaining([
        {
          op: "create_relation",
          id: "rel.project-tiny-related-to-architecture-current",
          from: "project.tiny",
          predicate: "related_to",
          to: "architecture.current",
          status: "active",
          confidence: "high"
        }
      ])
    );
  });

  it("adds deterministic file origin to bootstrap source records for lockfiles and agent guidance", async () => {
    const projectRoot = await createTempRoot("memory-discipline-bootstrap-origin-");
    await writeProjectFile(projectRoot, "README.md", "# Billing Agent\n");
    await writeJsonProjectFile(projectRoot, "package.json", {
      name: "billing-agent",
      scripts: {
        test: "vitest run"
      }
    });
    await writeProjectFile(projectRoot, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    await writeProjectFile(
      projectRoot,
      "AGENTS.md",
      [
        "# Agent instructions",
        "",
        "## Code Conventions",
        "",
        "- Prefer source-backed memory.",
        "- After changes, run `pnpm run test`.",
        ""
      ].join("\n")
    );
    const storage = storageSnapshot({
      objects: [
        initialProjectObject("project.billing-agent", "Billing Agent"),
        initialArchitectureObject("project.billing-agent")
      ],
      relations: [projectArchitectureRelation("project.billing-agent")],
      projectId: "project.billing-agent",
      projectName: "Billing Agent"
    });

    const proposal = await buildSuggestBootstrapPatchProposal({
      projectRoot,
      storage
    });

    expect(proposal.proposed).toBe(true);
    expect(proposal.patch?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: "create_object",
          id: "source.pnpm-lock-yaml",
          type: "source",
          origin: {
            kind: "file",
            locator: "pnpm-lock.yaml",
            digest: await fileDigest(projectRoot, "pnpm-lock.yaml")
          }
        }),
        expect.objectContaining({
          op: "create_object",
          id: "source.agents",
          type: "source",
          origin: {
            kind: "file",
            locator: "AGENTS.md",
            digest: await fileDigest(projectRoot, "AGENTS.md"),
            media_type: "text/markdown"
          }
        })
      ])
    );
  });

  it("creates only source records for small repos without confident synthesis evidence", async () => {
    const projectRoot = await createTempRoot("memory-discipline-bootstrap-minimal-");
    await writeProjectFile(projectRoot, "README.md", "# Tiny\n");
    await writeJsonProjectFile(projectRoot, "package.json", {});
    await writeProjectFile(projectRoot, "src/index.ts", "export const value = 1;\n");
    const storage = storageSnapshot({
      objects: [
        initialProjectObject("project.tiny", "Tiny"),
        initialArchitectureObject("project.tiny")
      ],
      relations: [projectArchitectureRelation("project.tiny")],
      projectId: "project.tiny",
      projectName: "Tiny"
    });

    const proposal = await buildSuggestBootstrapPatchProposal({
      projectRoot,
      storage
    });

    expect(proposal.proposed).toBe(true);
    expect(proposal.reason).toBeNull();
    expect(proposal.patch?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: "create_object", id: "source.readme", type: "source" }),
        expect.objectContaining({
          op: "create_object",
          id: "source.package-json",
          type: "source",
          origin: {
            kind: "file",
            locator: "package.json",
            digest: await fileDigest(projectRoot, "package.json"),
            media_type: "application/json"
          }
        })
      ])
    );
    expect(proposal.patch?.changes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: "create_object", id: "synthesis.product-intent" }),
        expect.objectContaining({ op: "create_object", id: "synthesis.feature-map" })
      ])
    );
    expect(proposal.packet.changed_files).toEqual(
      expect.arrayContaining(["README.md", "package.json", "src/index.ts"])
    );
  });
});

function storageSnapshot(options: {
  objects: StoredMemoryObject[];
  relations: StoredMemoryRelation[];
  projectId?: string;
  projectName?: string;
}): CanonicalStorageSnapshot {
  return {
    projectRoot: "/repo",
    memoryRoot: "/repo/.memory",
    config: {
      version: 1,
      project: {
        id: options.projectId ?? "project.test",
        name: options.projectName ?? "Test"
      },
      memory: {
        defaultTokenBudget: 6000,
        autoIndex: true,
        saveContextPacks: false
      },
      git: {
        trackContextPacks: false
      }
    },
    objects: options.objects,
    relations: options.relations,
    events: []
  };
}

function initialProjectObject(projectId: ObjectId, title: string): StoredMemoryObject {
  const body = `# ${title}\n\nProject-level memory for ${title}.\n`;

  return {
    path: ".memory/memory/project.json",
    bodyPath: ".memory/memory/project.md",
    sidecar: {
      id: projectId,
      type: "project",
      status: "active",
      title,
      body_path: "memory/project.md",
      scope: {
        kind: "project",
        project: projectId,
        branch: null,
        task: null
      },
      tags: [],
      source: {
        kind: "system"
      },
      superseded_by: null,
      content_hash: "sha256:test",
      created_at: TIMESTAMP,
      updated_at: TIMESTAMP
    },
    body
  };
}

function initialArchitectureObject(projectId: ObjectId): StoredMemoryObject {
  return {
    path: ".memory/memory/architecture.json",
    bodyPath: ".memory/memory/architecture.md",
    sidecar: {
      id: "architecture.current",
      type: "architecture",
      status: "active",
      title: "Current Architecture",
      body_path: "memory/architecture.md",
      scope: {
        kind: "project",
        project: projectId,
        branch: null,
        task: null
      },
      tags: [],
      source: {
        kind: "system"
      },
      superseded_by: null,
      content_hash: "sha256:test",
      created_at: TIMESTAMP,
      updated_at: TIMESTAMP
    },
    body: "# Current Architecture\n\nArchitecture memory starts here.\n"
  };
}

function projectArchitectureRelation(projectId: ObjectId): StoredMemoryRelation {
  const id = `rel.${projectId.replace(".", "-")}-related-to-architecture-current`;
  const relationData: MemoryRelation = {
    id,
    from: projectId,
    predicate: "related_to",
    to: "architecture.current",
    status: "active",
    confidence: "high",
    content_hash: "sha256:relation",
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP
  };

  return {
    path: `.memory/relations/${id.slice("rel.".length)}.json`,
    relation: relationData
  };
}

function provenanceRelation(from: ObjectId, to: ObjectId): StoredMemoryRelation {
  const id = `rel.${from.replace(".", "-")}-derived-from-${to.replace(".", "-")}`;
  const relationData: MemoryRelation = {
    id,
    from,
    predicate: "derived_from",
    to,
    status: "active",
    confidence: "high",
    evidence: [{ kind: "source", id: to }],
    content_hash: "sha256:relation",
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP
  };

  return {
    path: `.memory/relations/${id.slice("rel.".length)}.json`,
    relation: relationData
  };
}

function memoryObject(options: {
  id: ObjectId;
  type: ObjectType;
  status: ObjectStatus;
  title: string;
  body: string;
  tags?: string[];
}): StoredMemoryObject {
  const slug = options.id.slice(options.id.indexOf(".") + 1);
  const sidecar: MemoryObjectSidecar = {
    id: options.id,
    type: options.type,
    status: options.status,
    title: options.title,
    body_path: `memory/${slug}.md`,
    scope: {
      kind: "project",
      project: "proj.test",
      branch: null,
      task: null
    },
    tags: options.tags ?? [],
    source: {
      kind: "agent"
    },
    superseded_by: null,
    content_hash: "sha256:test",
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP
  };

  return {
    path: `.memory/memory/${slug}.json`,
    bodyPath: `.memory/${sidecar.body_path}`,
    sidecar,
    body: options.body
  };
}

function relation(options: {
  id: string;
  from: ObjectId;
  to: ObjectId;
  predicate?: MemoryRelation["predicate"];
  fileEvidence?: string;
}): StoredMemoryRelation {
  const relationData: MemoryRelation = {
    id: options.id,
    from: options.from,
    predicate: options.predicate ?? "affects",
    to: options.to,
    status: "active",
    confidence: "medium",
    ...(options.fileEvidence === undefined
      ? {}
      : { evidence: [{ kind: "file", id: options.fileEvidence }] }),
    content_hash: "sha256:relation",
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP
  };

  return {
    path: `.memory/relations/${options.id}.json`,
    relation: relationData
  };
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resolvedRoot = await realpath(root);
  tempRoots.push(resolvedRoot);
  return resolvedRoot;
}

async function writeProjectFile(
  projectRoot: string,
  relativePath: string,
  contents: string
): Promise<void> {
  const target = join(projectRoot, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

async function writeJsonProjectFile(
  projectRoot: string,
  relativePath: string,
  value: unknown
): Promise<void> {
  await writeProjectFile(projectRoot, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function fileDigest(projectRoot: string, relativePath: string): Promise<string> {
  const bytes = await readFile(join(projectRoot, relativePath));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function writeBundledSchemas(projectRoot: string): Promise<void> {
  for (const schemaFile of Object.values(SCHEMA_FILES)) {
    const schema = await readFile(join(process.cwd(), "src", "schemas", schemaFile), "utf8");
    await writeProjectFile(projectRoot, `.memory/schema/${schemaFile}`, schema);
  }
}

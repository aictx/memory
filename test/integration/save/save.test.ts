import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fg from "fast-glob";
import { afterEach, describe, expect, it } from "vitest";

import {
  initProject,
  inspectMemory,
  queryMemory,
  saveMemory,
  saveMemoryPatch
} from "../../../src/app/operations.js";
import { runSubprocess } from "../../../src/core/subprocess.js";
import { computeObjectContentHash } from "../../../src/storage/hashes.js";
import { readCanonicalStorage } from "../../../src/storage/read.js";
import { validateProject } from "../../../src/validation/validate.js";
import {
  createFixedTestClock,
  FIXED_TIMESTAMP,
  FIXED_TIMESTAMP_NEXT_MINUTE
} from "../../fixtures/time.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("saveMemory intent verb", () => {
  it("creates a feature with stage and anchors that inspect exposes", async () => {
    const projectRoot = await createInitializedProject("memory-save-intent-feature-");

    const result = await saveMemory({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      input: {
        task: "Record search feature",
        nodes: [
          {
            kind: "feature",
            title: "Index search",
            body: "# Index search\n\nSQLite-backed search over memory nodes.\n",
            stage: "building",
            anchors: ["src/index/search.ts", "./src/index/"],
            tags: ["search"]
          }
        ]
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.dry_run).toBe(false);
    expect(result.data.memory_created).toEqual(["feature.index-search"]);
    expect(result.data.index_updated).toBe(true);

    const inspected = await inspectMemory({
      cwd: projectRoot,
      id: "feature.index-search"
    });

    expect(inspected.ok).toBe(true);
    if (inspected.ok) {
      expect(inspected.data.object).toMatchObject({
        id: "feature.index-search",
        type: "feature",
        status: "active",
        stage: "building",
        anchors: ["src/index/search.ts", "src/index/"],
        tags: ["search"]
      });
    }
  });

  it("updates an existing node by id", async () => {
    const projectRoot = await createInitializedProject("memory-save-intent-update-");

    const created = await saveMemory({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      input: createGotchaInput("gotcha.retry-behavior", "Retry behavior", "Initial body.")
    });
    expect(created.ok).toBe(true);

    const updated = await saveMemory({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      input: {
        task: "Refine retry knowledge",
        nodes: [
          {
            id: "gotcha.retry-behavior",
            body: "# Retry behavior\n\nRetries are processed by the queue worker only.\n"
          }
        ]
      }
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) {
      return;
    }

    expect(updated.data.memory_created).toEqual([]);
    expect(updated.data.memory_updated).toEqual(["gotcha.retry-behavior"]);

    const inspected = await inspectMemory({
      cwd: projectRoot,
      id: "gotcha.retry-behavior"
    });
    expect(inspected.ok).toBe(true);
    if (inspected.ok) {
      expect(inspected.data.object.body).toContain("queue worker only");
    }
  });

  it("marks stale, supersedes, and deletes nodes", async () => {
    const projectRoot = await createInitializedProject("memory-save-intent-lifecycle-");

    const created = await saveMemory({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      input: {
        task: "Seed lifecycle nodes",
        nodes: [
          {
            id: "gotcha.stale-me",
            kind: "gotcha",
            title: "Stale me",
            body: "Old knowledge.\n"
          },
          {
            id: "decision.old-design",
            kind: "decision",
            title: "Old design",
            body: "Old design decision.\n"
          },
          {
            id: "decision.new-design",
            kind: "decision",
            title: "New design",
            body: "New design decision.\n"
          },
          {
            id: "gotcha.delete-me",
            kind: "gotcha",
            title: "Delete me",
            body: "Accidental import.\n"
          }
        ]
      }
    });
    expect(created.ok).toBe(true);

    const result = await saveMemory({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      input: {
        task: "Apply lifecycle transitions",
        stale: [{ id: "gotcha.stale-me", reason: "Behavior changed." }],
        supersede: [
          {
            id: "decision.old-design",
            superseded_by: "decision.new-design",
            reason: "New design replaces the old one."
          }
        ],
        delete: [{ id: "gotcha.delete-me", reason: "Accidental import." }]
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.memory_updated).toEqual(
      expect.arrayContaining(["gotcha.stale-me", "decision.old-design"])
    );
    expect(result.data.memory_deleted).toEqual(["gotcha.delete-me"]);
    expect(result.data.relations_created).toEqual([
      "rel.decision-new-design-supersedes-decision-old-design"
    ]);

    const storage = await readCanonicalStorage(projectRoot);
    expect(storage.ok).toBe(true);
    if (storage.ok) {
      const byId = new Map(
        storage.data.objects.map((object) => [object.sidecar.id, object.sidecar])
      );
      expect(byId.get("gotcha.stale-me")?.status).toBe("stale");
      expect(byId.get("decision.old-design")?.status).toBe("superseded");
      expect(byId.get("decision.old-design")?.superseded_by).toBe("decision.new-design");
      expect(byId.has("gotcha.delete-me")).toBe(false);
    }
  });

  it("creates related edges from node input", async () => {
    const projectRoot = await createInitializedProject("memory-save-intent-related-");

    const seeded = await saveMemory({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      input: {
        task: "Seed relation target",
        nodes: [
          {
            id: "feature.billing",
            kind: "feature",
            title: "Billing",
            body: "Billing feature.\n"
          }
        ]
      }
    });
    expect(seeded.ok).toBe(true);

    const result = await saveMemory({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      input: {
        task: "Link decision to feature",
        nodes: [
          {
            kind: "decision",
            title: "Retries in worker",
            body: "Retries run in the worker.\n",
            related: [
              {
                predicate: "affects",
                to: "feature.billing",
                confidence: "high"
              }
            ]
          }
        ]
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.memory_created).toEqual(["decision.retries-in-worker"]);
    expect(result.data.relations_created).toEqual([
      "rel.decision-retries-in-worker-affects-feature-billing"
    ]);

    const inspected = await inspectMemory({
      cwd: projectRoot,
      id: "decision.retries-in-worker"
    });
    expect(inspected.ok).toBe(true);
    if (inspected.ok) {
      expect(inspected.data.relations.outgoing).toEqual([
        expect.objectContaining({
          predicate: "affects",
          to: "feature.billing",
          confidence: "high"
        })
      ]);
    }
  });

  it("rejects creating nodes with kind project", async () => {
    const projectRoot = await createInitializedProject("memory-save-intent-project-kind-");
    const before = await readCanonicalSnapshot(projectRoot);

    const result = await saveMemory({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      input: {
        task: "Try to create a second project node",
        nodes: [
          {
            kind: "project",
            title: "Another project",
            body: "Not allowed.\n"
          }
        ]
      }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemoryValidationFailed");
      expect(JSON.stringify(result.error.details)).toContain("kind");
    }
    await expect(readCanonicalSnapshot(projectRoot)).resolves.toEqual(before);
  });

  it("rejects unsupported and mismatched create kinds", async () => {
    const projectRoot = await createInitializedProject("memory-save-intent-bad-kind-");

    const unknownKind = await saveMemory({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      input: {
        task: "Use a removed kind",
        nodes: [
          {
            kind: "constraint",
            title: "Old taxonomy kind",
            body: "The constraint kind no longer exists.\n"
          }
        ]
      }
    });

    expect(unknownKind.ok).toBe(false);
    if (!unknownKind.ok) {
      expect(unknownKind.error.code).toBe("MemoryValidationFailed");
    }

    const mismatchedId = await saveMemory({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      input: {
        task: "Use an id whose prefix mismatches the kind",
        nodes: [
          {
            id: "gotcha.mismatch",
            kind: "decision",
            title: "Mismatch",
            body: "Prefix and kind disagree.\n"
          }
        ]
      }
    });

    expect(mismatchedId.ok).toBe(false);
    if (!mismatchedId.ok) {
      expect(mismatchedId.error.code).toBe("MemoryValidationFailed");
    }
  });

  it("rejects stage on non-feature nodes", async () => {
    const projectRoot = await createInitializedProject("memory-save-intent-stage-");

    const onCreate = await saveMemory({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      input: {
        task: "Stage a decision",
        nodes: [
          {
            kind: "decision",
            title: "Staged decision",
            body: "Decisions have no stage.\n",
            stage: "shipped"
          }
        ]
      }
    });

    expect(onCreate.ok).toBe(false);
    if (!onCreate.ok) {
      expect(onCreate.error.code).toBe("MemoryValidationFailed");
      expect(onCreate.error.message).toContain("Stage is only allowed on feature objects.");
    }

    const seeded = await saveMemory({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      input: createGotchaInput("gotcha.no-stage", "No stage", "Gotchas have no stage.\n")
    });
    expect(seeded.ok).toBe(true);

    const onUpdate = await saveMemory({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      input: {
        task: "Stage a gotcha",
        nodes: [
          {
            id: "gotcha.no-stage",
            stage: "paused"
          }
        ]
      }
    });

    expect(onUpdate.ok).toBe(false);
    if (!onUpdate.ok) {
      expect(onUpdate.error.code).toBe("MemoryValidationFailed");
      expect(onUpdate.error.message).toContain("Stage is only allowed on feature objects.");
    }
  });

  it("rejects absolute and traversal anchors", async () => {
    const projectRoot = await createInitializedProject("memory-save-intent-anchors-");
    const before = await readCanonicalSnapshot(projectRoot);

    for (const anchor of ["/etc/passwd", "../outside.ts", ".memory/events.jsonl"]) {
      const result = await saveMemory({
        cwd: projectRoot,
        clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
        input: {
          task: "Anchor a feature outside the repo",
          nodes: [
            {
              kind: "feature",
              title: "Bad anchors",
              body: "Anchors must stay repo-relative.\n",
              anchors: [anchor]
            }
          ]
        }
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("MemoryValidationFailed");
        expect(JSON.stringify(result.error.details)).toContain("anchor");
      }
    }

    await expect(readCanonicalSnapshot(projectRoot)).resolves.toEqual(before);
  });

  it("plans dry runs without writing canonical memory", async () => {
    const projectRoot = await createInitializedProject("memory-save-intent-dry-run-");
    const before = await readCanonicalSnapshot(projectRoot);

    const result = await saveMemory({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      dryRun: true,
      input: createGotchaInput("gotcha.preview", "Preview", "This is only planned.\n")
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.dry_run).toBe(true);
    expect(result.data.memory_created).toEqual(["gotcha.preview"]);
    expect(result.data.index_updated).toBe(false);
    await expect(readCanonicalSnapshot(projectRoot)).resolves.toEqual(before);
  });

  it("rejects empty save input without actions", async () => {
    const projectRoot = await createInitializedProject("memory-save-intent-empty-");

    const result = await saveMemory({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      input: {
        task: "No actions"
      }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemoryValidationFailed");
      expect(result.error.message).toContain("at least one memory action");
    }
  });
});

describe("saveMemoryPatch", () => {
  it("writes canonical files, appends events, updates hashes, and updates search index", async () => {
    const projectRoot = await createInitializedProject("memory-save-local-");

    const result = await saveMemoryPatch({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      patch: {
        source: {
          kind: "agent",
          task: "Save retry follow up"
        },
        changes: [
          {
            op: "create_object",
            type: "gotcha",
            title: "Retry follow up",
            body: "# Retry follow up\n\nQueue worker retry details are saved for later tasks.\n",
            tags: ["retry", "worker"]
          }
        ]
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data).toMatchObject({
      files_changed: [
        ".memory/events.jsonl",
        ".memory/memory/gotchas/retry-follow-up.json",
        ".memory/memory/gotchas/retry-follow-up.md"
      ],
      memory_created: ["gotcha.retry-follow-up"],
      memory_updated: [],
      memory_deleted: [],
      relations_created: [],
      relations_updated: [],
      relations_deleted: [],
      events_appended: 1,
      index_updated: true
    });

    const storage = await readCanonicalStorage(projectRoot);
    expect(storage.ok).toBe(true);
    if (!storage.ok) {
      return;
    }

    const saved = storage.data.objects.find(
      (object) => object.sidecar.id === "gotcha.retry-follow-up"
    );
    expect(saved).toBeDefined();
    if (saved === undefined) {
      return;
    }

    expect(saved.body).toBe(
      "# Retry follow up\n\nQueue worker retry details are saved for later tasks.\n"
    );
    expect(saved.sidecar).toEqual(
      expect.objectContaining({
        id: "gotcha.retry-follow-up",
        type: "gotcha",
        status: "active",
        title: "Retry follow up",
        tags: ["retry", "worker"],
        source: {
          kind: "agent",
          task: "Save retry follow up"
        },
        created_at: FIXED_TIMESTAMP_NEXT_MINUTE,
        updated_at: FIXED_TIMESTAMP_NEXT_MINUTE
      })
    );

    const { content_hash: _contentHash, ...sidecarWithoutHash } = saved.sidecar;
    expect(saved.sidecar.content_hash).toBe(
      computeObjectContentHash(sidecarWithoutHash, saved.body)
    );

    const validation = await validateProject(projectRoot);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);

    const queried = await queryMemory({
      cwd: projectRoot,
      question: "Queue worker retry"
    });

    expect(queried.ok).toBe(true);
    if (queried.ok) {
      expect(queried.data.included_ids).toContain("gotcha.retry-follow-up");
    }
  });

  it("quarantines canonical conflict markers before applying the patch", async () => {
    const projectRoot = await createInitializedProject("memory-save-conflict-marker-");
    await writeFile(
      join(projectRoot, ".memory", "memory", "project.md"),
      "<<<<<<< HEAD\n# Project\n=======\n# Other project\n>>>>>>> branch\n",
      "utf8"
    );
    const result = await saveMemoryPatch({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      patch: createGotchaPatch("Saved despite conflict", "This should still be written.")
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.memory_created).toEqual(["gotcha.saved-despite-conflict"]);
      expect(result.data.repairs_applied).toEqual(
        expect.arrayContaining([
          "Quarantined invalid memory object body: .memory/memory/project.md"
        ])
      );
    }
    await expect(
      access(join(projectRoot, ".memory", "memory", "gotchas", "saved-despite-conflict.md"))
    ).resolves.toBeUndefined();
    await expect(access(join(projectRoot, ".memory", "memory", "project.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs invalid events history before appending new save events", async () => {
    const projectRoot = await createInitializedProject("memory-save-invalid-events-");
    const invalidEvents = "{bad json\n";
    await writeFile(join(projectRoot, ".memory", "events.jsonl"), invalidEvents, "utf8");

    const result = await saveMemoryPatch({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      patch: createGotchaPatch("Saved after invalid events", "This should still be written.")
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.memory_created).toEqual(["gotcha.saved-after-invalid-events"]);
      expect(result.data.repairs_applied).toEqual([
        "Repaired invalid events history: .memory/events.jsonl"
      ]);
    }
    await expect(
      access(join(projectRoot, ".memory", "memory", "gotchas", "saved-after-invalid-events.md"))
    ).resolves.toBeUndefined();
    await expect(readFile(join(projectRoot, ".memory", "events.jsonl"), "utf8"))
      .resolves.toContain('"id":"gotcha.saved-after-invalid-events"');
  });

  it("rejects block-level secrets in patches without leaking the secret", async () => {
    const projectRoot = await createInitializedProject("memory-save-secret-");
    const before = await readCanonicalSnapshot(projectRoot);
    const secret = `sk-${"a".repeat(20)}`;

    const result = await saveMemoryPatch({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      patch: createGotchaPatch("Do not save secret", `The key was ${secret}.`)
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemorySecretDetected");
      expect(JSON.stringify(result.error.details)).not.toContain(secret);
    }
    await expect(
      access(join(projectRoot, ".memory", "memory", "gotchas", "do-not-save-secret.md"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readCanonicalSnapshot(projectRoot)).resolves.toEqual(before);
  });

  it("leaves Git changes uncommitted after a successful save", async () => {
    const repo = await createRepo("memory-save-git-");
    const initialized = await initProject({
      cwd: repo,
      clock: createFixedTestClock(FIXED_TIMESTAMP)
    });
    expect(initialized.ok).toBe(true);
    await git(repo, ["add", ".gitignore", ".memory"]);
    await git(repo, ["commit", "-m", "Initialize memory"]);
    const commitBefore = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const result = await saveMemoryPatch({
      cwd: repo,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      patch: createGotchaPatch("Git save note", "Save should not create a commit.")
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(commitBefore);
    expect(result.meta.git.available).toBe(true);
    expect(result.meta.git.commit).toBe(commitBefore);
    expect(result.meta.git.dirty).toBe(true);

    const status = await git(repo, ["status", "--porcelain=v1", "-uall", "--", ".memory"]);
    expect(status).toContain(".memory/events.jsonl");
    expect(status).toContain(".memory/memory/gotchas/git-save-note.md");
    expect(status).toContain(".memory/memory/gotchas/git-save-note.json");
  });

  it("appends to valid dirty tracked events history during a Git-backed save", async () => {
    const repo = await createRepo("memory-save-dirty-events-");
    const initialized = await initProject({
      cwd: repo,
      clock: createFixedTestClock(FIXED_TIMESTAMP)
    });
    expect(initialized.ok).toBe(true);
    await git(repo, ["add", ".gitignore", ".memory"]);
    await git(repo, ["commit", "-m", "Initialize memory"]);
    const projectId = await readProjectObjectId(repo);
    const priorEvent = `{"actor":"agent","event":"memory.updated","id":"${projectId}","timestamp":"2026-04-25T14:00:00+02:00"}\n`;
    await writeFile(join(repo, ".memory", "events.jsonl"), priorEvent, "utf8");

    const result = await saveMemoryPatch({
      cwd: repo,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      patch: createGotchaPatch("Dirty events save note", "Save should append after prior events.")
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data).toMatchObject({
      memory_created: ["gotcha.dirty-events-save-note"],
      events_appended: 1
    });
    const events = await readFile(join(repo, ".memory", "events.jsonl"), "utf8");
    expect(events).toContain(priorEvent.trim());
    expect(events).toContain('"id":"gotcha.dirty-events-save-note"');
    expect(events.indexOf(priorEvent.trim())).toBeLessThan(
      events.indexOf('"id":"gotcha.dirty-events-save-note"')
    );
  });

  it("backs up dirty touched canonical files instead of blocking a Git-backed save", async () => {
    const repo = await createRepo("memory-save-dirty-overwrite-");
    const initialized = await initProject({
      cwd: repo,
      clock: createFixedTestClock(FIXED_TIMESTAMP)
    });
    expect(initialized.ok).toBe(true);
    await git(repo, ["add", ".gitignore", ".memory"]);
    await git(repo, ["commit", "-m", "Initialize memory"]);
    const projectId = await readProjectObjectId(repo);
    const dirtyBody = "# Project\n\nDirty local edit.\n";
    await writeFile(join(repo, ".memory", "memory", "project.md"), dirtyBody, "utf8");

    const result = await saveMemoryPatch({
      cwd: repo,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      patch: {
        source: {
          kind: "agent",
          task: "Update project memory"
        },
        changes: [
          {
            op: "update_object",
            id: projectId,
            body: "# Project\n\nSaved project update.\n"
          }
        ]
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.memory_updated).toEqual([projectId]);
    expect(result.data.recovery_files).toEqual([
      expect.objectContaining({
        path: ".memory/memory/project.md",
        reason: "dirty_overwrite"
      })
    ]);
    await expect(
      readFile(join(repo, result.data.recovery_files[0]?.recovery_path ?? ""), "utf8")
    ).resolves.toBe(dirtyBody);
    await expect(readFile(join(repo, ".memory", "memory", "project.md"), "utf8"))
      .resolves.toContain("Saved project update.");
  });

  it("restores tracked deleted Memory storage before saving new memory", async () => {
    const repo = await createRepo("memory-save-deleted-storage-");
    const initialized = await initProject({
      cwd: repo,
      clock: createFixedTestClock(FIXED_TIMESTAMP)
    });
    expect(initialized.ok).toBe(true);
    await git(repo, ["add", ".gitignore", ".memory"]);
    await git(repo, ["commit", "-m", "Initialize memory"]);
    const storageBeforeDelete = await readCanonicalStorage(repo);
    expect(storageBeforeDelete.ok).toBe(true);
    const originalIds = storageBeforeDelete.ok
      ? storageBeforeDelete.data.objects.map((object) => object.sidecar.id)
      : [];
    await rm(join(repo, ".memory"), { recursive: true, force: true });

    const result = await saveMemoryPatch({
      cwd: repo,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      patch: createGotchaPatch("Deleted storage save", "Save should restore Memory first.")
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.warnings).toContain(
      "Memory storage was restored from HEAD before writing because tracked .memory files were deleted."
    );
    expect(result.data.memory_created).toEqual(["gotcha.deleted-storage-save"]);
    await expect(
      readFile(join(repo, ".memory", "memory", "gotchas", "deleted-storage-save.md"), "utf8")
    ).resolves.toContain("Save should restore Memory first.");
    const validation = await validateProject(repo);
    expect(validation.valid).toBe(true);
    const storage = await readCanonicalStorage(repo);
    expect(storage.ok).toBe(true);
    if (storage.ok) {
      expect(
        originalIds.every((id) =>
          storage.data.objects.some((object) => object.sidecar.id === id)
        )
      )
        .toBe(true);
    }
  });

  it("quarantines unrelated malformed memory and still saves new memory", async () => {
    const projectRoot = await createInitializedProject("memory-save-repair-invalid-");
    await mkdir(join(projectRoot, ".memory", "memory", "gotchas"), { recursive: true });
    await writeFile(
      join(projectRoot, ".memory", "memory", "gotchas", "broken.json"),
      "{not json\n",
      "utf8"
    );

    const result = await saveMemoryPatch({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      patch: createGotchaPatch("Repair keeps saving", "New memory should still be written.")
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.memory_created).toEqual(["gotcha.repair-keeps-saving"]);
    expect(result.data.repairs_applied).toEqual(
      expect.arrayContaining([
        "Quarantined invalid memory object sidecar: .memory/memory/gotchas/broken.json"
      ])
    );
    await expect(
      access(join(projectRoot, ".memory", "memory", "gotchas", "broken.json"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(projectRoot, result.data.recovery_files[0]?.recovery_path ?? ""), "utf8")
    ).resolves.toBe("{not json\n");
  });
});

function createGotchaPatch(title: string, body: string) {
  return {
    source: {
      kind: "agent",
      task: "Save integration test"
    },
    changes: [
      {
        op: "create_object",
        type: "gotcha",
        title,
        body: `# ${title}\n\n${body}\n`
      }
    ]
  };
}

function createGotchaInput(id: string, title: string, body: string) {
  return {
    task: "Save intent integration test",
    nodes: [
      {
        id,
        kind: "gotcha",
        title,
        body: `# ${title}\n\n${body}\n`
      }
    ]
  };
}

async function readProjectObjectId(projectRoot: string): Promise<string> {
  const storage = await readCanonicalStorage(projectRoot);

  if (!storage.ok) {
    throw new Error(storage.error.message);
  }

  return storage.data.config.project.id;
}

async function createInitializedProject(prefix: string): Promise<string> {
  const projectRoot = await createTempRoot(prefix);
  const initialized = await initProject({
    cwd: projectRoot,
    clock: createFixedTestClock(FIXED_TIMESTAMP)
  });

  expect(initialized.ok).toBe(true);
  if (!initialized.ok) {
    throw new Error(initialized.error.message);
  }

  return projectRoot;
}

async function createRepo(prefix: string): Promise<string> {
  const repo = await createTempRoot(prefix);
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Memory Test"]);
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "README.md"), "# Test\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "Initial commit"]);
  return repo;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resolvedRoot = await realpath(root);
  tempRoots.push(resolvedRoot);
  return resolvedRoot;
}

async function readCanonicalSnapshot(projectRoot: string): Promise<Record<string, string>> {
  const paths = (
    await fg(".memory/**/*.{json,jsonl,md}", {
      cwd: projectRoot,
      dot: true,
      ignore: [".memory/index/**", ".memory/context/**"],
      onlyFiles: true,
      unique: true
    })
  ).sort();
  const entries = await Promise.all(
    paths.map(async (path) => [path, await readFile(join(projectRoot, path), "utf8")] as const)
  );

  return Object.fromEntries(entries);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runSubprocess("git", args, { cwd });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  if (result.data.exitCode !== 0) {
    throw new Error(result.data.stderr || result.data.stdout || `git ${args.join(" ")} failed`);
  }

  return result.data.stdout;
}

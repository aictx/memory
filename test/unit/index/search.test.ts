import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { searchIndex } from "../../../src/index/search.js";
import { openIndexDatabase, type IndexDatabaseConnection } from "../../../src/index/sqlite.js";
import type {
  Evidence,
  FeatureStage,
  ObjectStatus,
  ObjectType,
  SourceOrigin
} from "../../../src/core/types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("search index", () => {
  it("rejects empty queries before opening SQLite", async () => {
    const result = await searchIndex({
      memoryRoot: "/does/not/matter",
      query: " \n\t "
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemoryValidationFailed");
      expect(result.error.details).toMatchObject({
        field: "query"
      });
    }
  });

  it("validates limits before opening SQLite", async () => {
    for (const limit of [0, 51, 1.5, Number.NaN, Infinity]) {
      const result = await searchIndex({
        memoryRoot: "/does/not/matter",
        query: "webhook",
        limit
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("MemoryValidationFailed");
        expect(result.error.details).toMatchObject({
          field: "limit",
          minimum: 1,
          maximum: 50
        });
      }
    }
  });

  it("defaults to ten matches", async () => {
    const connection = await openMigratedConnection();

    try {
      for (let index = 0; index < 12; index += 1) {
        insertObject(connection, {
          id: `gotcha.shared-${String(index).padStart(2, "0")}`,
          title: `Shared search ${index}`,
          body: "Shared search body.",
          updatedAt: `2026-04-27T12:${String(index).padStart(2, "0")}:00+02:00`
        });
      }

      const result = await searchIndex({
        memoryRoot: connection.memoryRoot,
        query: "shared"
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.matches).toHaveLength(10);
      }
    } finally {
      connection.close();
    }
  });

  it("matches exact IDs and indexed body paths", async () => {
    const connection = await openMigratedConnection();

    try {
      insertObject(connection, {
        id: "decision.webhook-idempotency",
        type: "decision",
        title: "Webhook idempotency",
        bodyPath: ".memory/memory/decisions/webhook-idempotency.md",
        body: "Stripe may deliver duplicate webhook events.",
        tags: ["stripe", "webhooks"]
      });

      const byId = await searchIndex({
        memoryRoot: connection.memoryRoot,
        query: " decision.webhook-idempotency "
      });
      const byPath = await searchIndex({
        memoryRoot: connection.memoryRoot,
        query: ".memory/memory/decisions/webhook-idempotency.md"
      });

      expect(byId.ok).toBe(true);
      expect(byPath.ok).toBe(true);

      if (byId.ok && byPath.ok) {
        expect(byId.data.matches[0]).toMatchObject({
          id: "decision.webhook-idempotency",
          status: "active"
        });
        expect(byPath.data.matches[0]).toMatchObject({
          id: "decision.webhook-idempotency",
          body_path: ".memory/memory/decisions/webhook-idempotency.md"
        });
      }
    } finally {
      connection.close();
    }
  });

  it("uses punctuation-safe FTS and exposes current hybrid statuses", async () => {
    const connection = await openMigratedConnection();

    try {
      insertObject(connection, {
        id: "decision.active-webhook",
        type: "decision",
        status: "active",
        title: "Active webhook",
        body: "Webhook delivery must be idempotent.",
        tags: ["stripe"]
      });
      insertObject(connection, {
        id: "decision.stale-webhook",
        type: "decision",
        status: "stale",
        title: "Stale webhook",
        body: "Webhook delivery used an old queue.",
        tags: ["stripe"]
      });
      insertObject(connection, {
        id: "gotcha.superseded-webhook",
        status: "superseded",
        title: "Superseded webhook",
        body: "Webhook behavior was replaced.",
        tags: ["stripe"]
      });
      insertObject(connection, {
        id: "question.closed-webhook",
        type: "question",
        status: "closed",
        title: "Closed webhook",
        body: "Webhook question was closed.",
        tags: ["stripe"]
      });
      insertObject(connection, {
        id: "feature.webhook-context",
        type: "feature",
        status: "active",
        title: "Webhook context",
        body: "Webhook text is captured in the webhook feature node.",
        tags: ["stripe"]
      });

      const result = await searchIndex({
        memoryRoot: connection.memoryRoot,
        query: "webhook!!!"
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const ids = result.data.matches.map((match) => match.id);
        const statuses = result.data.matches.map((match) => match.status);

        expect(ids).toContain("feature.webhook-context");
        expect(statuses).toEqual(expect.arrayContaining(["active", "stale", "superseded", "closed"]));
      }
    } finally {
      connection.close();
    }
  });

  it("normalizes legacy draft rows and excludes legacy rejected rows", async () => {
    const connection = await openMigratedConnection();

    try {
      insertObject(connection, {
        id: "gotcha.legacy-draft",
        status: "draft",
        title: "Legacy draft webhook",
        body: "Webhook notes from legacy draft storage.",
        tags: ["webhook"]
      });
      insertObject(connection, {
        id: "gotcha.legacy-rejected",
        status: "rejected",
        title: "Legacy rejected webhook",
        body: "Webhook notes from legacy rejected storage.",
        tags: ["webhook"]
      });

      const result = await searchIndex({
        memoryRoot: connection.memoryRoot,
        query: "webhook"
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.matches).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "gotcha.legacy-draft",
              status: "active"
            })
          ])
        );
        expect(result.data.matches.map((match) => match.id)).not.toContain(
          "gotcha.legacy-rejected"
        );
      }
    } finally {
      connection.close();
    }
  });

  it("returns gotcha and staged feature search matches", async () => {
    const connection = await openMigratedConnection();

    try {
      insertObject(connection, {
        id: "gotcha.webhook-duplicates",
        type: "gotcha",
        title: "Webhook duplicates",
        bodyPath: ".memory/memory/gotchas/webhook-duplicates.md",
        body: "Never assume webhook delivery is unique.",
        tags: ["webhook"]
      });
      insertObject(connection, {
        id: "feature.release-checklist",
        type: "feature",
        stage: "building",
        title: "Release checklist",
        bodyPath: ".memory/memory/features/release-checklist.md",
        body: "Run the release checklist before publishing.",
        tags: ["release"]
      });

      const result = await searchIndex({
        memoryRoot: connection.memoryRoot,
        query: "webhook release",
        limit: 10
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.matches).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "gotcha.webhook-duplicates",
              type: "gotcha",
              body_path: ".memory/memory/gotchas/webhook-duplicates.md"
            }),
            expect.objectContaining({
              id: "feature.release-checklist",
              type: "feature",
              body_path: ".memory/memory/features/release-checklist.md"
            })
          ])
        );
      }
    } finally {
      connection.close();
    }
  });

  it("matches anchor and object evidence search material", async () => {
    const connection = await openMigratedConnection();

    try {
      insertObject(connection, {
        id: "decision.sqlite-schema",
        type: "decision",
        title: "SQLite schema",
        body: "The index keeps deterministic search material.",
        anchors: ["src/index/migrations.ts", "src/index/"],
        evidence: [{ kind: "commit", id: "abc1234" }]
      });

      const byAnchor = await searchIndex({
        memoryRoot: connection.memoryRoot,
        query: "migrations"
      });
      const byEvidence = await searchIndex({
        memoryRoot: connection.memoryRoot,
        query: "abc1234"
      });

      expect(byAnchor.ok).toBe(true);
      expect(byEvidence.ok).toBe(true);

      if (byAnchor.ok && byEvidence.ok) {
        expect(byAnchor.data.matches[0]?.id).toBe("decision.sqlite-schema");
        expect(byEvidence.data.matches[0]?.id).toBe("decision.sqlite-schema");
      }
    } finally {
      connection.close();
    }
  });

  it("matches source origin search material", async () => {
    const connection = await openMigratedConnection();

    try {
      insertObject(connection, {
        id: "decision.llm-wiki",
        type: "decision",
        title: "LLM Wiki decision",
        body: "Decision derived from a wiki workflow article.",
        origin: {
          kind: "url",
          locator: "https://example.com/llm-wiki",
          captured_at: "2026-05-14T12:00:00+02:00",
          media_type: "text/markdown"
        }
      });

      const result = await searchIndex({
        memoryRoot: connection.memoryRoot,
        query: "llm-wiki"
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.matches[0]?.id).toBe("decision.llm-wiki");
      }
    } finally {
      connection.close();
    }
  });

  it("ranks deterministic ties by recency and then lexicographic ID", async () => {
    const connection = await openMigratedConnection();

    try {
      insertObject(connection, {
        id: "gotcha.beta",
        title: "Ranking tie",
        body: "Ranking tie body.",
        updatedAt: "2026-04-27T12:00:00+02:00"
      });
      insertObject(connection, {
        id: "gotcha.alpha",
        title: "Ranking tie",
        body: "Ranking tie body.",
        updatedAt: "2026-04-27T12:00:00+02:00"
      });
      insertObject(connection, {
        id: "gotcha.newer",
        title: "Ranking tie",
        body: "Ranking tie body.",
        updatedAt: "2026-04-27T12:01:00+02:00"
      });

      const first = await searchIndex({
        memoryRoot: connection.memoryRoot,
        query: "ranking"
      });
      const second = await searchIndex({
        memoryRoot: connection.memoryRoot,
        query: "ranking"
      });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);

      if (first.ok && second.ok) {
        expect(first.data.matches.map((match) => match.id)).toEqual([
          "gotcha.newer",
          "gotcha.alpha",
          "gotcha.beta"
        ]);
        expect(second.data.matches.map((match) => match.id)).toEqual(
          first.data.matches.map((match) => match.id)
        );
      }
    } finally {
      connection.close();
    }
  });

  it("builds deterministic snippets from matched terms or body fallback", async () => {
    const connection = await openMigratedConnection();

    try {
      insertObject(connection, {
        id: "gotcha.needle",
        title: "Needle",
        body: `${"prefix ".repeat(20)}needle appears in the middle of this memory body.${" suffix".repeat(20)}`
      });
      insertObject(connection, {
        id: "gotcha.fallback-snippet",
        title: "Fallback snippet title",
        body: "First sentence of the body is used when no query term appears in the body."
      });

      const matched = await searchIndex({
        memoryRoot: connection.memoryRoot,
        query: "needle"
      });
      const fallback = await searchIndex({
        memoryRoot: connection.memoryRoot,
        query: "gotcha.fallback-snippet"
      });

      expect(matched.ok).toBe(true);
      expect(fallback.ok).toBe(true);

      if (matched.ok && fallback.ok) {
        expect(matched.data.matches[0]?.snippet).toContain("needle appears");
        expect(matched.data.matches[0]?.snippet.length).toBeLessThanOrEqual(166);
        expect(fallback.data.matches[0]?.snippet).toBe(
          "First sentence of the body is used when no query term appears in the body."
        );
      }
    } finally {
      connection.close();
    }
  });
});

interface TestConnection extends IndexDatabaseConnection {
  memoryRoot: string;
}

interface ObjectFixture {
  id: string;
  type?: ObjectType;
  status?: ObjectStatus | "draft" | "rejected";
  title: string;
  bodyPath?: string;
  body: string;
  stage?: FeatureStage;
  anchors?: string[];
  tags?: string[];
  evidence?: Evidence[];
  origin?: SourceOrigin;
  updatedAt?: string;
}

async function openMigratedConnection(): Promise<TestConnection> {
  const memoryRoot = await createMemoryRoot();
  const opened = await openIndexDatabase({ memoryRoot });

  expect(opened.ok).toBe(true);
  if (!opened.ok) {
    throw new Error(opened.error.message);
  }

  return {
    ...opened.data,
    memoryRoot
  };
}

async function createMemoryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-search-unit-"));
  tempRoots.push(root);

  const memoryRoot = join(root, ".memory");
  await mkdir(memoryRoot);

  return memoryRoot;
}

function insertObject(connection: TestConnection, fixture: ObjectFixture): void {
  const type = fixture.type ?? "gotcha";
  const status = fixture.status ?? "active";
  const bodyPath = fixture.bodyPath ?? `.memory/memory/gotchas/${fixture.id.replace(".", "-")}.md`;
  const anchors = fixture.anchors ?? null;
  const tags = fixture.tags ?? [];
  const evidence = fixture.evidence ?? [];
  const origin = fixture.origin ?? null;
  const updatedAt = fixture.updatedAt ?? "2026-04-27T12:00:00+02:00";

  connection.db
    .prepare<Record<string, string | null>>(
      `
        INSERT INTO objects (
          id,
          type,
          status,
          title,
          body_path,
          json_path,
          body,
          content_hash,
          stage,
          anchors_json,
          tags_json,
          evidence_json,
          source_json,
          origin_json,
          superseded_by,
          created_at,
          updated_at
        ) VALUES (
          @id,
          @type,
          @status,
          @title,
          @body_path,
          @json_path,
          @body,
          @content_hash,
          @stage,
          @anchors_json,
          @tags_json,
          @evidence_json,
          @source_json,
          @origin_json,
          @superseded_by,
          @created_at,
          @updated_at
        )
      `
    )
    .run({
      id: fixture.id,
      type,
      status,
      title: fixture.title,
      body_path: bodyPath,
      json_path: bodyPath.replace(/\.md$/, ".json"),
      body: fixture.body,
      content_hash: `sha256:${fixture.id}`,
      stage: fixture.stage ?? null,
      anchors_json: jsonOrNull(anchors),
      tags_json: JSON.stringify(tags),
      evidence_json: JSON.stringify(evidence),
      source_json: null,
      origin_json: jsonOrNull(origin),
      superseded_by: null,
      created_at: updatedAt,
      updated_at: updatedAt
    });

  connection.db
    .prepare<Record<string, string>>(
      `
        INSERT INTO objects_fts (object_id, title, body, tags, anchors, evidence)
        VALUES (@object_id, @title, @body, @tags, @anchors, @evidence)
      `
    )
    .run({
      object_id: fixture.id,
      title: fixture.title,
      body: fixture.body,
      tags: tags.join(" "),
      anchors: (anchors ?? []).join(" "),
      evidence: [evidenceSearchText(evidence), originSearchText(origin)].join(" ")
    });
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function evidenceSearchText(evidence: readonly Evidence[]): string {
  return evidence.map((item) => `${item.kind} ${item.id}`).join(" ");
}

function originSearchText(origin: SourceOrigin | null): string {
  if (origin === null) {
    return "";
  }

  return [
    origin.kind,
    origin.locator,
    origin.captured_at ?? "",
    origin.digest ?? "",
    origin.media_type ?? ""
  ].join(" ");
}

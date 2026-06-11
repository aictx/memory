import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CURRENT_INDEX_SCHEMA_VERSION,
  getIndexSchemaVersion,
  REQUIRED_META_DEFAULTS
} from "../../../src/index/migrations.js";
import { openIndexDatabase, type IndexDatabaseConnection } from "../../../src/index/sqlite.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SQLite index connection and migrations", () => {
  it("opens an empty database and migrates it to the current schema version", async () => {
    const memoryRoot = await createMemoryRoot();

    const opened = await openIndexDatabase({ memoryRoot });

    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }

    expect(opened.data.path).toBe(join(memoryRoot, "index", "memory.sqlite"));
    expect((await stat(opened.data.path)).isFile()).toBe(true);

    const version = getIndexSchemaVersion(opened.data.db);

    expect(version).toEqual({
      ok: true,
      data: CURRENT_INDEX_SCHEMA_VERSION,
      warnings: []
    });

    expect(opened.data.close()).toEqual({ ok: true, data: undefined, warnings: [] });
  });

  it("creates required tables", async () => {
    const connection = await openMigratedConnection();

    expect(listTables(connection.db)).toEqual(
      expect.arrayContaining(["events", "meta", "objects", "objects_fts", "relations"])
    );

    connection.close();
  });

  it("creates required explicit indexes", async () => {
    const connection = await openMigratedConnection();

    expect(listIndexes(connection.db)).toEqual(
      expect.arrayContaining([
        "events_line_number_idx",
        "events_memory_id_idx",
        "events_relation_id_idx",
        "objects_stage_idx",
        "objects_status_idx",
        "objects_type_idx",
        "objects_updated_at_idx",
        "relations_from_idx",
        "relations_predicate_idx",
        "relations_to_idx"
      ])
    );

    connection.close();
  });

  it("stores required meta rows with deterministic defaults", async () => {
    const connection = await openMigratedConnection();

    expect(readMeta(connection.db)).toEqual(REQUIRED_META_DEFAULTS);

    connection.close();
  });

  it("commits successful transactions", async () => {
    const connection = await openMigratedConnection();

    const transaction = connection.transaction((db) => {
      db.prepare<[string, string]>("UPDATE meta SET value = ? WHERE key = ?").run(
        "2026-04-27T00:00:00+02:00",
        "built_at"
      );
      return "committed";
    });

    expect(transaction).toEqual({ ok: true, data: "committed", warnings: [] });
    expect(readMeta(connection.db).built_at).toBe("2026-04-27T00:00:00+02:00");

    connection.close();
  });

  it("rolls back failed transactions", async () => {
    const connection = await openMigratedConnection();

    const transaction = connection.transaction((db) => {
      db.prepare<[string, string]>("UPDATE meta SET value = ? WHERE key = ?").run(
        "changed",
        "built_at"
      );
      throw new Error("rollback");
    });

    expect(transaction.ok).toBe(false);
    if (!transaction.ok) {
      expect(transaction.error.code).toBe("MemoryIndexUnavailable");
    }
    expect(readMeta(connection.db).built_at).toBe("");

    connection.close();
  });

  it("closes cleanly and idempotently", async () => {
    const connection = await openMigratedConnection();

    expect(connection.close()).toEqual({ ok: true, data: undefined, warnings: [] });
    expect(connection.close()).toEqual({ ok: true, data: undefined, warnings: [] });
  });
});

interface NamedRow {
  name: string;
}

interface MetaRow {
  key: keyof typeof REQUIRED_META_DEFAULTS;
  value: string;
}

async function openMigratedConnection(): Promise<IndexDatabaseConnection> {
  const memoryRoot = await createMemoryRoot();
  const opened = await openIndexDatabase({ memoryRoot });

  expect(opened.ok).toBe(true);
  if (!opened.ok) {
    throw new Error(opened.error.message);
  }

  return opened.data;
}

async function createMemoryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-sqlite-"));
  tempRoots.push(root);

  const memoryRoot = join(root, ".memory");
  await mkdir(memoryRoot);

  return memoryRoot;
}

function listTables(db: IndexDatabaseConnection["db"]): string[] {
  return db
    .prepare<[], NamedRow>(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual') ORDER BY name"
    )
    .all()
    .map((row) => row.name);
}

function listIndexes(db: IndexDatabaseConnection["db"]): string[] {
  return db
    .prepare<[], NamedRow>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((row) => row.name);
}

function readMeta(db: IndexDatabaseConnection["db"]): typeof REQUIRED_META_DEFAULTS {
  const rows = db.prepare<[], MetaRow>("SELECT key, value FROM meta ORDER BY key").all();

  return Object.fromEntries(rows.map((row) => [row.key, row.value])) as typeof REQUIRED_META_DEFAULTS;
}

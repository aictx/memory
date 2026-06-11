import { memoryError } from "../core/errors.js";
import { err, ok, type Result } from "../core/result.js";
import type { SqliteDatabase } from "./sqlite-driver.js";

export const CURRENT_INDEX_SCHEMA_VERSION = 6;

export const REQUIRED_META_DEFAULTS = {
  schema_version: String(CURRENT_INDEX_SCHEMA_VERSION),
  built_at: "",
  source_git_commit: "",
  git_available: "false",
  storage_version: "5",
  object_count: "0",
  relation_count: "0",
  event_count: "0"
} as const;

interface MetaRow {
  value: string;
}

export function migrateIndexDatabase(db: SqliteDatabase): Result<void> {
  try {
    const migrate = db.transaction(() => {
      createMetaTable(db);

      const existingVersion = getIndexSchemaVersionUnchecked(db);

      if (existingVersion !== null && existingVersion !== CURRENT_INDEX_SCHEMA_VERSION) {
        throw new UnsupportedSchemaVersionError(existingVersion);
      }

      createSchema(db);
      insertMissingMetaRows(db);
    });

    migrate();
    return ok(undefined);
  } catch (error) {
    if (error instanceof UnsupportedSchemaVersionError) {
      return err(
        memoryError(
          "MemoryIndexUnavailable",
          "SQLite index schema version is not supported.",
          {
            expected: CURRENT_INDEX_SCHEMA_VERSION,
            actual: error.version
          }
        )
      );
    }

    return err(
      memoryError("MemoryIndexUnavailable", "SQLite index migration failed.", {
        message: messageFromUnknown(error)
      })
    );
  }
}

export function getIndexSchemaVersion(db: SqliteDatabase): Result<number | null> {
  try {
    return ok(getIndexSchemaVersionUnchecked(db));
  } catch (error) {
    return err(
      memoryError("MemoryIndexUnavailable", "SQLite index schema version could not be read.", {
        message: messageFromUnknown(error)
      })
    );
  }
}

function createMetaTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function createSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS objects (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      body_path TEXT NOT NULL,
      json_path TEXT NOT NULL,
      body TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      stage TEXT,
      anchors_json TEXT,
      tags_json TEXT NOT NULL,
      evidence_json TEXT,
      source_json TEXT,
      origin_json TEXT,
      superseded_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_file_links (
      memory_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      link_kind TEXT NOT NULL,
      PRIMARY KEY (memory_id, file_path, link_kind)
    );

    CREATE TABLE IF NOT EXISTS memory_commit_links (
      memory_id TEXT NOT NULL,
      commit_hash TEXT NOT NULL,
      link_kind TEXT NOT NULL,
      PRIMARY KEY (memory_id, commit_hash, link_kind)
    );

    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      predicate TEXT NOT NULL,
      to_id TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence TEXT,
      evidence_json TEXT,
      content_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      line_number INTEGER NOT NULL,
      event TEXT NOT NULL,
      memory_id TEXT,
      relation_id TEXT,
      actor TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      reason TEXT,
      payload_json TEXT
    );

    CREATE TABLE IF NOT EXISTS git_file_changes (
      file_path TEXT NOT NULL,
      commit_hash TEXT NOT NULL,
      short_commit TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      subject TEXT NOT NULL,
      PRIMARY KEY (file_path, commit_hash)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS objects_fts USING fts5(
      object_id UNINDEXED,
      title,
      body,
      tags,
      anchors,
      evidence
    );

    CREATE INDEX IF NOT EXISTS objects_type_idx ON objects(type);
    CREATE INDEX IF NOT EXISTS objects_status_idx ON objects(status);
    CREATE INDEX IF NOT EXISTS objects_stage_idx ON objects(stage);
    CREATE INDEX IF NOT EXISTS objects_updated_at_idx ON objects(updated_at);
    CREATE INDEX IF NOT EXISTS memory_file_links_file_idx ON memory_file_links(file_path);
    CREATE INDEX IF NOT EXISTS memory_file_links_memory_idx ON memory_file_links(memory_id);
    CREATE INDEX IF NOT EXISTS memory_commit_links_commit_idx ON memory_commit_links(commit_hash);
    CREATE INDEX IF NOT EXISTS memory_commit_links_memory_idx ON memory_commit_links(memory_id);
    CREATE INDEX IF NOT EXISTS relations_from_idx ON relations(from_id);
    CREATE INDEX IF NOT EXISTS relations_to_idx ON relations(to_id);
    CREATE INDEX IF NOT EXISTS relations_predicate_idx ON relations(predicate);
    CREATE INDEX IF NOT EXISTS events_memory_id_idx ON events(memory_id);
    CREATE INDEX IF NOT EXISTS events_relation_id_idx ON events(relation_id);
    CREATE INDEX IF NOT EXISTS events_line_number_idx ON events(line_number);
    CREATE INDEX IF NOT EXISTS git_file_changes_file_idx ON git_file_changes(file_path);
    CREATE INDEX IF NOT EXISTS git_file_changes_timestamp_idx ON git_file_changes(timestamp);
  `);
}

function insertMissingMetaRows(db: SqliteDatabase): void {
  const insert = db.prepare<[string, string]>(
    "INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)"
  );

  for (const [key, value] of Object.entries(REQUIRED_META_DEFAULTS)) {
    insert.run(key, value);
  }
}

function getIndexSchemaVersionUnchecked(db: SqliteDatabase): number | null {
  const metaTableExists = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'"
    )
    .get();

  if (metaTableExists === undefined) {
    return null;
  }

  const row = db
    .prepare<[string], MetaRow>("SELECT value FROM meta WHERE key = ?")
    .get("schema_version");

  if (row === undefined) {
    return null;
  }

  const parsedVersion = Number.parseInt(row.value, 10);

  if (!Number.isSafeInteger(parsedVersion) || String(parsedVersion) !== row.value) {
    throw new UnsupportedSchemaVersionError(row.value);
  }

  return parsedVersion;
}

class UnsupportedSchemaVersionError extends Error {
  constructor(readonly version: number | string) {
    super(`Unsupported SQLite index schema version: ${String(version)}`);
  }
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

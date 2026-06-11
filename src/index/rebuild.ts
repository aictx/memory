import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import { memoryError, type JsonValue } from "../core/errors.js";
import type { ProjectFileChange } from "../core/git.js";
import { err, ok, type Result } from "../core/result.js";
import type { GitState, ValidationIssue } from "../core/types.js";
import type { StoredMemoryObject } from "../storage/objects.js";
import { readCanonicalStorage, type CanonicalStorageSnapshot } from "../storage/read.js";
import type { MemoryRelation } from "../storage/relations.js";
import { validateProject } from "../validation/validate.js";
import {
  CURRENT_INDEX_SCHEMA_VERSION,
  migrateIndexDatabase,
  REQUIRED_META_DEFAULTS
} from "./migrations.js";
import { resolveIndexDatabasePath } from "./sqlite.js";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite-driver.js";

export interface RebuildIndexOptions {
  projectRoot: string;
  memoryRoot: string;
  clock?: Clock;
  git?: Pick<GitState, "available" | "branch" | "commit">;
  gitFileChanges?: readonly ProjectFileChange[];
}

export interface RebuildIndexData {
  index_rebuilt: true;
  objects_indexed: number;
  relations_indexed: number;
  events_indexed: number;
  event_appended: false;
}

type MetaKey = keyof typeof REQUIRED_META_DEFAULTS;

export async function rebuildIndex(
  options: RebuildIndexOptions
): Promise<Result<RebuildIndexData>> {
  const clock = options.clock ?? systemClock;
  const validation = await validateProject(options.projectRoot, {
    git: {
      available: options.git?.available === true,
      branch: options.git?.branch ?? null
    }
  });
  const validationWarnings = warningsFromValidation(validation.warnings);

  if (!validation.valid) {
    return err(
      memoryError(
        "MemoryIndexUnavailable",
        "Canonical files are invalid; SQLite index was not replaced.",
        validationIssuesDetails(validation.errors)
      ),
      validationWarnings
    );
  }

  const storage = await readCanonicalStorage(options.projectRoot);

  if (!storage.ok) {
    return err(
      memoryError("MemoryIndexUnavailable", "Canonical files could not be read for indexing.", {
        cause: errorToJson(storage.error)
      }),
      [...validationWarnings, ...storage.warnings]
    );
  }

  const databasePath = await resolveIndexDatabasePath(options.memoryRoot);

  if (!databasePath.ok) {
    return databasePath;
  }

  const indexDirectory = dirname(databasePath.data);
  const temporaryPath = join(indexDirectory, `.memory-rebuild-${randomUUID()}.sqlite`);

  try {
    await mkdir(indexDirectory, { recursive: true });
  } catch (error) {
    return indexUnavailable("SQLite index directory could not be prepared.", {
      path: indexDirectory,
      message: messageFromUnknown(error)
    });
  }

  const validIndexDirectory = await validateIndexDirectory(options.memoryRoot, indexDirectory);

  if (!validIndexDirectory.ok) {
    return validIndexDirectory;
  }

  const built = await buildTemporaryDatabase({
    path: temporaryPath,
    storage: storage.data,
    clock,
    git: options.git,
    gitFileChanges: options.gitFileChanges ?? []
  });

  if (!built.ok) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    return built;
  }

  try {
    await rename(temporaryPath, databasePath.data);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    return indexUnavailable("SQLite index database could not be replaced.", {
      path: databasePath.data,
      message: messageFromUnknown(error)
    });
  }

  return ok(built.data, validationWarnings);
}

async function validateIndexDirectory(
  memoryRoot: string,
  indexDirectory: string
): Promise<Result<void>> {
  try {
    const directoryStat = await lstat(indexDirectory);

    if (directoryStat.isSymbolicLink()) {
      return indexUnavailable("Refusing to rebuild SQLite index through a symbolic link.", {
        path: indexDirectory
      });
    }

    if (!directoryStat.isDirectory()) {
      return indexUnavailable("SQLite index path is not a directory.", {
        path: indexDirectory
      });
    }

    const [realMemoryRoot, realIndexDirectory] = await Promise.all([
      realpath(memoryRoot),
      realpath(indexDirectory)
    ]);

    if (!isInsideOrEqual(realMemoryRoot, realIndexDirectory)) {
      return indexUnavailable("SQLite index directory resolves outside the Memory root.", {
        memoryRoot: realMemoryRoot,
        indexDirectory: realIndexDirectory
      });
    }

    return ok(undefined);
  } catch (error) {
    return indexUnavailable("SQLite index directory could not be validated.", {
      path: indexDirectory,
      message: messageFromUnknown(error)
    });
  }
}

interface BuildTemporaryDatabaseOptions {
  path: string;
  storage: CanonicalStorageSnapshot;
  clock: Clock;
  git: Pick<GitState, "available" | "branch" | "commit"> | undefined;
  gitFileChanges: readonly ProjectFileChange[];
}

async function buildTemporaryDatabase(
  options: BuildTemporaryDatabaseOptions
): Promise<Result<RebuildIndexData>> {
  let db: SqliteDatabase | null = null;

  try {
    db = await openSqliteDatabase(options.path);
    db.pragma("journal_mode = DELETE");

    const migrated = migrateIndexDatabase(db);

    if (!migrated.ok) {
      return migrated;
    }

    const populated = populateDatabase(
      db,
      options.storage,
      options.clock,
      options.git,
      options.gitFileChanges
    );

    if (!populated.ok) {
      return populated;
    }

    db.close();
    db = null;

    return populated;
  } catch (error) {
    return indexUnavailable("SQLite index rebuild failed.", {
      path: options.path,
      message: messageFromUnknown(error)
    });
  } finally {
    if (db?.open === true) {
      try {
        db.close();
      } catch {
        // The original rebuild error is more useful than a cleanup close failure.
      }
    }
  }
}

function populateDatabase(
  db: SqliteDatabase,
  storage: CanonicalStorageSnapshot,
  clock: Clock,
  git: Pick<GitState, "available" | "branch" | "commit"> | undefined,
  gitFileChanges: readonly ProjectFileChange[]
): Result<RebuildIndexData> {
  try {
    const run = db.transaction(() => {
      clearGeneratedRows(db);
      insertObjects(db, storage);
      insertRelations(db, storage);
      insertEvents(db, storage);
      insertGitFileChanges(db, gitFileChanges);
      insertMeta(db, storage, clock, git);

      return {
        index_rebuilt: true,
        objects_indexed: storage.objects.length,
        relations_indexed: storage.relations.length,
        events_indexed: storage.events.length,
        event_appended: false
      } satisfies RebuildIndexData;
    });

    return ok(run());
  } catch (error) {
    return indexUnavailable("SQLite index rows could not be rebuilt.", {
      message: messageFromUnknown(error)
    });
  }
}

function clearGeneratedRows(db: SqliteDatabase): void {
  db.exec(`
    DELETE FROM objects_fts;
    DELETE FROM git_file_changes;
    DELETE FROM events;
    DELETE FROM relations;
    DELETE FROM memory_commit_links;
    DELETE FROM memory_file_links;
    DELETE FROM objects;
    DELETE FROM meta;
  `);
}

function insertObjects(db: SqliteDatabase, storage: CanonicalStorageSnapshot): void {
  const insertObject = db.prepare<Record<string, string | null>>(`
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
  `);
  const insertFts = db.prepare<Record<string, string>>(`
    INSERT INTO objects_fts (object_id, title, body, tags, anchors, evidence)
    VALUES (@object_id, @title, @body, @tags, @anchors, @evidence)
  `);
  const insertFileLink = db.prepare<Record<string, string>>(`
    INSERT OR IGNORE INTO memory_file_links (memory_id, file_path, link_kind)
    VALUES (@memory_id, @file_path, @link_kind)
  `);
  const insertCommitLink = db.prepare<Record<string, string>>(`
    INSERT OR IGNORE INTO memory_commit_links (memory_id, commit_hash, link_kind)
    VALUES (@memory_id, @commit_hash, @link_kind)
  `);

  for (const object of storage.objects) {
    const sidecar = object.sidecar;
    const tags = sidecar.tags ?? [];

    insertObject.run({
      id: sidecar.id,
      type: sidecar.type,
      status: sidecar.status,
      title: sidecar.title,
      body_path: object.bodyPath,
      json_path: object.path,
      body: object.body,
      content_hash: sidecar.content_hash,
      stage: sidecar.stage ?? null,
      anchors_json: jsonOrNull(sidecar.anchors),
      tags_json: JSON.stringify(tags),
      evidence_json: jsonOrNull(sidecar.evidence),
      source_json: jsonOrNull(sidecar.source),
      origin_json: jsonOrNull(sidecar.origin),
      superseded_by: sidecar.superseded_by ?? null,
      created_at: sidecar.created_at,
      updated_at: sidecar.updated_at
    });

    insertFts.run({
      object_id: sidecar.id,
      title: sidecar.title,
      body: object.body,
      tags: tags.join(" "),
      anchors: anchorsSearchText(sidecar.anchors),
      evidence: [evidenceSearchText(sidecar.evidence), originSearchText(sidecar.origin)].join(" ")
    });
    insertObjectLinks({
      object,
      addFileLink: (filePath, linkKind) => {
        const normalizedPath = normalizeProjectFileReference(filePath);

        if (normalizedPath !== null) {
          insertFileLink.run({
            memory_id: sidecar.id,
            file_path: normalizedPath,
            link_kind: linkKind
          });
        }
      },
      addCommitLink: (commitHash, linkKind) => {
        const normalizedCommit = commitHash.trim();

        if (normalizedCommit !== "" && !normalizedCommit.includes("\0")) {
          insertCommitLink.run({
            memory_id: sidecar.id,
            commit_hash: normalizedCommit,
            link_kind: linkKind
          });
        }
      }
    });
  }
}

function insertObjectLinks(options: {
  object: StoredMemoryObject;
  addFileLink: (filePath: string, linkKind: string) => void;
  addCommitLink: (commitHash: string, linkKind: string) => void;
}): void {
  for (const evidence of options.object.sidecar.evidence ?? []) {
    if (evidence.kind === "file") {
      options.addFileLink(evidence.id, "evidence.file");
    }

    if (evidence.kind === "commit") {
      options.addCommitLink(evidence.id, "evidence.commit");
    }
  }

  if (options.object.sidecar.source?.commit !== undefined) {
    options.addCommitLink(options.object.sidecar.source.commit, "source.commit");
  }

  if (options.object.sidecar.origin?.kind === "file") {
    options.addFileLink(options.object.sidecar.origin.locator, "origin.file");
  }

  for (const filePath of extractProjectFileReferences(options.object.body)) {
    options.addFileLink(filePath, "body.reference");
  }
}

function anchorsSearchText(anchors: StoredMemoryObject["sidecar"]["anchors"]): string {
  return (anchors ?? []).join(" ");
}

function evidenceSearchText(evidence: StoredMemoryObject["sidecar"]["evidence"]): string {
  return (evidence ?? []).map((item) => `${item.kind} ${item.id}`).join(" ");
}

function originSearchText(origin: StoredMemoryObject["sidecar"]["origin"]): string {
  if (origin === undefined) {
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

function insertRelations(db: SqliteDatabase, storage: CanonicalStorageSnapshot): void {
  const insertRelation = db.prepare<Record<string, string | null>>(`
    INSERT INTO relations (
      id,
      from_id,
      predicate,
      to_id,
      status,
      confidence,
      evidence_json,
      content_hash,
      created_at,
      updated_at
    ) VALUES (
      @id,
      @from_id,
      @predicate,
      @to_id,
      @status,
      @confidence,
      @evidence_json,
      @content_hash,
      @created_at,
      @updated_at
    )
  `);
  const insertFileLink = db.prepare<Record<string, string>>(`
    INSERT OR IGNORE INTO memory_file_links (memory_id, file_path, link_kind)
    VALUES (@memory_id, @file_path, @link_kind)
  `);
  const insertCommitLink = db.prepare<Record<string, string>>(`
    INSERT OR IGNORE INTO memory_commit_links (memory_id, commit_hash, link_kind)
    VALUES (@memory_id, @commit_hash, @link_kind)
  `);

  for (const storedRelation of storage.relations) {
    const relation = storedRelation.relation;

    insertRelation.run({
      id: relation.id,
      from_id: relation.from,
      predicate: relation.predicate,
      to_id: relation.to,
      status: relation.status,
      confidence: relation.confidence ?? null,
      evidence_json: jsonOrNull(relation.evidence),
      content_hash: relation.content_hash ?? null,
      created_at: relation.created_at,
      updated_at: relation.updated_at
    });
    insertRelationEvidenceLinks({
      relation,
      addFileLink: (memoryId, filePath) => {
        const normalizedPath = normalizeProjectFileReference(filePath);

        if (normalizedPath !== null) {
          insertFileLink.run({
            memory_id: memoryId,
            file_path: normalizedPath,
            link_kind: "relation.evidence.file"
          });
        }
      },
      addCommitLink: (memoryId, commitHash) => {
        const normalizedCommit = commitHash.trim();

        if (normalizedCommit !== "" && !normalizedCommit.includes("\0")) {
          insertCommitLink.run({
            memory_id: memoryId,
            commit_hash: normalizedCommit,
            link_kind: "relation.evidence.commit"
          });
        }
      }
    });
  }
}

function insertRelationEvidenceLinks(options: {
  relation: MemoryRelation;
  addFileLink: (memoryId: string, filePath: string) => void;
  addCommitLink: (memoryId: string, commitHash: string) => void;
}): void {
  const endpoints = uniqueSorted([options.relation.from, options.relation.to]);

  for (const evidence of options.relation.evidence ?? []) {
    if (evidence.kind !== "file" && evidence.kind !== "commit") {
      continue;
    }

    for (const memoryId of endpoints) {
      if (evidence.kind === "file") {
        options.addFileLink(memoryId, evidence.id);
      } else {
        options.addCommitLink(memoryId, evidence.id);
      }
    }
  }
}

function insertEvents(db: SqliteDatabase, storage: CanonicalStorageSnapshot): void {
  const insertEvent = db.prepare<Record<string, number | string | null>>(`
    INSERT INTO events (
      line_number,
      event,
      memory_id,
      relation_id,
      actor,
      timestamp,
      reason,
      payload_json
    ) VALUES (
      @line_number,
      @event,
      @memory_id,
      @relation_id,
      @actor,
      @timestamp,
      @reason,
      @payload_json
    )
  `);

  for (const event of storage.events) {
    insertEvent.run({
      line_number: event.line,
      event: event.event,
      memory_id: event.id ?? null,
      relation_id: event.relation_id ?? null,
      actor: event.actor,
      timestamp: event.timestamp,
      reason: event.reason ?? null,
      payload_json: jsonOrNull(event.payload)
    });
  }
}

function insertGitFileChanges(
  db: SqliteDatabase,
  changes: readonly ProjectFileChange[]
): void {
  const insert = db.prepare<Record<string, string>>(`
    INSERT OR IGNORE INTO git_file_changes (
      file_path,
      commit_hash,
      short_commit,
      timestamp,
      subject
    ) VALUES (
      @file_path,
      @commit_hash,
      @short_commit,
      @timestamp,
      @subject
    )
  `);

  for (const change of changes) {
    const filePath = normalizeProjectFileReference(change.file);

    if (filePath === null) {
      continue;
    }

    insert.run({
      file_path: filePath,
      commit_hash: change.commit,
      short_commit: change.shortCommit,
      timestamp: change.timestamp,
      subject: change.subject
    });
  }
}

function insertMeta(
  db: SqliteDatabase,
  storage: CanonicalStorageSnapshot,
  clock: Clock,
  git: Pick<GitState, "available" | "branch" | "commit"> | undefined
): void {
  const insert = db.prepare<[string, string]>("INSERT INTO meta (key, value) VALUES (?, ?)");
  const metaRows: Record<MetaKey, string> = {
    schema_version: String(CURRENT_INDEX_SCHEMA_VERSION),
    built_at: clock.nowIso(),
    source_git_commit: git?.available === true && git.commit !== null ? git.commit : "",
    git_available: git?.available === true ? "true" : "false",
    storage_version: String(storage.config.version),
    object_count: String(storage.objects.length),
    relation_count: String(storage.relations.length),
    event_count: String(storage.events.length)
  };

  for (const [key, value] of Object.entries(metaRows)) {
    insert.run(key, value);
  }
}

function jsonOrNull(value: unknown | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function extractProjectFileReferences(body: string): string[] {
  return uniqueSorted(
    [...body.matchAll(/(?:^|[\s([{"'`])((?:\.\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.@+-]+\.[A-Za-z0-9]+)(?=$|[\s)\]}",'`:;])/gu)]
      .map((match) => match[1] ?? "")
      .map(normalizeProjectFileReference)
      .filter((path): path is string => path !== null)
  );
}

function normalizeProjectFileReference(value: string): string | null {
  const normalized = value.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");

  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.includes("://") ||
    normalized.includes("\0") ||
    normalized.startsWith(".memory/")
  ) {
    return null;
  }

  return normalized;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function validationIssuesDetails(issues: readonly ValidationIssue[]): JsonValue {
  return {
    issues: issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.path,
      field: issue.field
    }))
  };
}

function warningsFromValidation(issues: readonly ValidationIssue[]): string[] {
  return issues.map((issue) => `Validation warning in ${issue.path}: ${issue.message}`);
}

function indexUnavailable<T>(message: string, details: JsonValue): Result<T> {
  return err(memoryError("MemoryIndexUnavailable", message, details));
}

function errorToJson(error: { code: string; message: string; details?: JsonValue }): JsonValue {
  return error.details === undefined
    ? {
        code: error.code,
        message: error.message
      }
    : {
        code: error.code,
        message: error.message,
        details: error.details
      };
}

function isInsideOrEqual(root: string, target: string): boolean {
  const relativePath = relative(root, target);

  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

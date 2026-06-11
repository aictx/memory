import { lstat } from "node:fs/promises";

import { memoryError, type JsonValue } from "../core/errors.js";
import { err, ok, type Result } from "../core/result.js";
import {
  OBJECT_STATUSES,
  OBJECT_TYPES,
  type ObjectStatus,
  type ObjectType
} from "../core/types.js";
import {
  CURRENT_INDEX_SCHEMA_VERSION,
  getIndexSchemaVersion
} from "./migrations.js";
import {
  openIndexDatabase,
  resolveIndexDatabasePath,
  type IndexDatabaseConnection
} from "./sqlite.js";
import type { SqliteDatabase } from "./sqlite-driver.js";

const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const SNIPPET_LENGTH = 160;
const SNIPPET_CONTEXT = 48;

const SCORE = {
  exactId: 100,
  exactBodyPath: 80,
  tagMatch: 40,
  titleFtsMatch: 30,
  anchorMatch: 25,
  bodyFtsMatch: 15,
  recentMemoryBoost: 5
} as const;

const TYPE_MODIFIERS = {
  decision: 18,
  gotcha: 14,
  feature: 12,
  question: 10,
  project: 8
} as const satisfies Record<ObjectType, number>;

const STATUS_MODIFIERS = {
  active: 20,
  open: 12,
  stale: -30,
  superseded: -35,
  closed: 0
} as const satisfies Record<ObjectStatus, number>;

const TYPE_PRIORITY = {
  decision: 0,
  gotcha: 1,
  feature: 2,
  question: 3,
  project: 4
} as const satisfies Record<ObjectType, number>;

export interface SearchMemoryInput {
  query: string;
  limit?: number;
}

export interface SearchIndexOptions extends SearchMemoryInput {
  memoryRoot: string;
}

export interface SearchMemoryData {
  matches: SearchResult[];
}

export interface SearchResult {
  id: string;
  type: ObjectType;
  status: ObjectStatus;
  title: string;
  snippet: string;
  body_path: string;
  score: number;
}

interface RankedSearchResult extends SearchResult {
  updatedAt: string;
}

interface NormalizedSearchInput {
  query: string;
  limit: number;
  terms: string[];
  ftsQuery: string | null;
}

interface ObjectRow {
  id: string;
  type: string;
  status: string;
  title: string;
  body_path: string;
  body: string;
  tags_json: string;
  anchors_json: string | null;
  evidence_json: string | null;
  origin_json: string | null;
  updated_at: string;
}

interface IndexedObject {
  id: string;
  type: ObjectType;
  status: ObjectStatus;
  title: string;
  bodyPath: string;
  body: string;
  tags: string[];
  anchorsText: string;
  evidenceText: string;
  updatedAt: string;
}

interface SearchCandidate {
  object: IndexedObject;
  sources: Set<ScoreSource>;
}

type ScoreSource =
  | "exactId"
  | "exactBodyPath"
  | "tagMatch"
  | "titleFtsMatch"
  | "anchorMatch"
  | "bodyFtsMatch";

export async function searchIndex(options: SearchIndexOptions): Promise<Result<SearchMemoryData>> {
  const normalized = normalizeSearchInput(options);

  if (!normalized.ok) {
    return normalized;
  }

  const databaseAvailable = await requireExistingIndexDatabase(options.memoryRoot);

  if (!databaseAvailable.ok) {
    return databaseAvailable;
  }

  const connection = await openIndexDatabase({
    memoryRoot: options.memoryRoot,
    migrate: false
  });

  if (!connection.ok) {
    return connection;
  }

  const searched = searchDatabase(connection.data, normalized.data);
  const closed = connection.data.close();

  if (!searched.ok) {
    return err(searched.error, [...searched.warnings, ...closed.warnings]);
  }

  if (!closed.ok) {
    return err(closed.error, closed.warnings);
  }

  return searched;
}

function normalizeSearchInput(input: SearchMemoryInput): Result<NormalizedSearchInput> {
  if (typeof input.query !== "string") {
    return invalidInput("Search query is required.", {
      field: "query"
    });
  }

  const query = input.query.trim();

  if (query === "") {
    return invalidInput("Search query must be non-empty after trimming whitespace.", {
      field: "query"
    });
  }

  const limit = input.limit ?? DEFAULT_LIMIT;

  if (!Number.isSafeInteger(limit) || limit < MIN_LIMIT || limit > MAX_LIMIT) {
    return invalidInput("Search limit must be an integer between 1 and 50.", {
      field: "limit",
      minimum: MIN_LIMIT,
      maximum: MAX_LIMIT,
      actual: numberDetail(limit)
    });
  }

  const terms = extractSearchTerms(query);

  return ok({
    query,
    limit,
    terms,
    ftsQuery: buildFtsQuery(terms)
  });
}

async function requireExistingIndexDatabase(memoryRoot: string): Promise<Result<void>> {
  const databasePath = await resolveIndexDatabasePath(memoryRoot);

  if (!databasePath.ok) {
    return indexUnavailable("SQLite index database path could not be resolved.", {
      cause: errorToJson(databasePath.error)
    });
  }

  try {
    const stat = await lstat(databasePath.data);

    if (!stat.isFile() || stat.size === 0) {
      return indexUnavailable("SQLite index database is missing or empty.", {
        path: databasePath.data
      });
    }

    return ok(undefined);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return indexUnavailable("SQLite index database is missing.", {
        path: databasePath.data
      });
    }

    return indexUnavailable("SQLite index database could not be checked.", {
      path: databasePath.data,
      message: messageFromUnknown(error)
    });
  }
}

function searchDatabase(
  connection: IndexDatabaseConnection,
  input: NormalizedSearchInput
): Result<SearchMemoryData> {
  try {
    const schemaVersion = getIndexSchemaVersion(connection.db);

    if (!schemaVersion.ok) {
      return schemaVersion;
    }

    if (schemaVersion.data !== CURRENT_INDEX_SCHEMA_VERSION) {
      return indexUnavailable("SQLite index schema version is not supported.", {
        expected: CURRENT_INDEX_SCHEMA_VERSION,
        actual: schemaVersion.data
      });
    }

    const candidates = new Map<string, SearchCandidate>();
    const exactId = selectObjectById(connection.db, input.query);

    if (exactId !== undefined) {
      addCandidate(candidates, exactId, ["exactId"]);
    }

    const exactBodyPath = selectObjectByBodyPath(connection.db, input.query);

    if (exactBodyPath !== undefined) {
      addCandidate(candidates, exactBodyPath, ["exactBodyPath"]);
    }

    if (input.ftsQuery !== null) {
      for (const row of selectObjectsByFts(connection.db, input.ftsQuery)) {
        addCandidate(candidates, row, sourcesForTerms(row, input.terms));
      }
    }

    const recentBoostIds = newestBoostableCandidateIds(candidates);
    const matches = [...candidates.values()]
      .map((candidate) => resultFromCandidate(candidate, input.terms, recentBoostIds))
      .sort(compareRankedSearchResults)
      .slice(0, input.limit)
      .map(({ updatedAt: _updatedAt, ...result }) => result);

    return ok({ matches });
  } catch (error) {
    return indexUnavailable("SQLite index search failed.", {
      path: connection.path,
      message: messageFromUnknown(error)
    });
  }
}

const OBJECT_ROW_COLUMNS =
  "id, type, status, title, body_path, body, tags_json, anchors_json, evidence_json, origin_json, updated_at";

function selectObjectById(db: SqliteDatabase, id: string): IndexedObject | undefined {
  const row = db
    .prepare<[string], ObjectRow>(
      `
        SELECT ${OBJECT_ROW_COLUMNS}
        FROM objects
        WHERE id = ? AND status <> 'rejected'
      `
    )
    .get(id);

  return row === undefined ? undefined : indexedObjectFromRow(row);
}

function selectObjectByBodyPath(db: SqliteDatabase, bodyPath: string): IndexedObject | undefined {
  const row = db
    .prepare<[string], ObjectRow>(
      `
        SELECT ${OBJECT_ROW_COLUMNS}
        FROM objects
        WHERE body_path = ? AND status <> 'rejected'
      `
    )
    .get(bodyPath);

  return row === undefined ? undefined : indexedObjectFromRow(row);
}

function selectObjectsByFts(db: SqliteDatabase, ftsQuery: string): IndexedObject[] {
  const rows = db
    .prepare<[string], ObjectRow>(
      `
        SELECT
          o.id,
          o.type,
          o.status,
          o.title,
          o.body_path,
          o.body,
          o.tags_json,
          o.anchors_json,
          o.evidence_json,
          o.origin_json,
          o.updated_at
        FROM objects_fts
        JOIN objects o ON o.id = objects_fts.object_id
        WHERE objects_fts MATCH ? AND o.status <> 'rejected'
      `
    )
    .all(ftsQuery);

  return rows.map(indexedObjectFromRow);
}

function indexedObjectFromRow(row: ObjectRow): IndexedObject {
  if (!isObjectType(row.type)) {
    throw new Error(`Indexed object has unsupported type: ${row.type}`);
  }

  const status = normalizeIndexedObjectStatus(row.type, row.status);

  if (status === null) {
    throw new Error(`Indexed object has unsupported status: ${row.status}`);
  }

  return {
    id: row.id,
    type: row.type,
    status,
    title: row.title,
    bodyPath: row.body_path,
    body: row.body,
    tags: parseTags(row.tags_json),
    anchorsText: jsonSearchText(row.anchors_json),
    evidenceText: [jsonSearchText(row.evidence_json), jsonSearchText(row.origin_json)].join(" "),
    updatedAt: row.updated_at
  };
}

function addCandidate(
  candidates: Map<string, SearchCandidate>,
  object: IndexedObject,
  sources: readonly ScoreSource[]
): void {
  const existing = candidates.get(object.id);

  if (existing === undefined) {
    candidates.set(object.id, {
      object,
      sources: new Set(sources)
    });
    return;
  }

  for (const source of sources) {
    existing.sources.add(source);
  }
}

function sourcesForTerms(object: IndexedObject, terms: readonly string[]): ScoreSource[] {
  const sources = new Set<ScoreSource>();
  const normalizedTitle = normalizeForMatch(object.title);
  const normalizedBody = normalizeForMatch(object.body);
  const normalizedTags = object.tags.map(normalizeForMatch);
  const normalizedAnchors = normalizeForMatch(object.anchorsText);
  const normalizedEvidence = normalizeForMatch(object.evidenceText);

  for (const term of terms) {
    if (normalizedTitle.includes(term)) {
      sources.add("titleFtsMatch");
    }

    if (normalizedAnchors.includes(term)) {
      sources.add("anchorMatch");
    }

    if (normalizedBody.includes(term) || normalizedEvidence.includes(term)) {
      sources.add("bodyFtsMatch");
    }

    if (normalizedTags.some((tag) => tag.includes(term))) {
      sources.add("tagMatch");
    }
  }

  return [...sources];
}

function newestBoostableCandidateIds(candidates: ReadonlyMap<string, SearchCandidate>): Set<string> {
  return new Set(
    [...candidates.values()]
      .filter((candidate) => shouldApplyRecentBoost(candidate.object.status))
      .sort(compareNewestObjects)
      .slice(0, 5)
      .map((candidate) => candidate.object.id)
  );
}

function resultFromCandidate(
  candidate: SearchCandidate,
  terms: readonly string[],
  recentBoostIds: ReadonlySet<string>
): RankedSearchResult {
  const score =
    scoreSources(candidate.sources) +
    TYPE_MODIFIERS[candidate.object.type] +
    STATUS_MODIFIERS[candidate.object.status] +
    (recentBoostIds.has(candidate.object.id) ? SCORE.recentMemoryBoost : 0);

  return {
    id: candidate.object.id,
    type: candidate.object.type,
    status: candidate.object.status,
    title: candidate.object.title,
    snippet: buildSnippet(candidate.object.body, candidate.object.title, terms),
    body_path: candidate.object.bodyPath,
    score,
    updatedAt: candidate.object.updatedAt
  };
}

function scoreSources(sources: ReadonlySet<ScoreSource>): number {
  let score = 0;

  if (sources.has("exactId")) {
    score += SCORE.exactId;
  }

  if (sources.has("exactBodyPath")) {
    score += SCORE.exactBodyPath;
  }

  if (sources.has("tagMatch")) {
    score += SCORE.tagMatch;
  }

  if (sources.has("titleFtsMatch")) {
    score += SCORE.titleFtsMatch;
  }

  if (sources.has("anchorMatch")) {
    score += SCORE.anchorMatch;
  }

  if (sources.has("bodyFtsMatch")) {
    score += SCORE.bodyFtsMatch;
  }

  return score;
}

function compareRankedSearchResults(left: RankedSearchResult, right: RankedSearchResult): number {
  const scoreDifference = right.score - left.score;

  if (scoreDifference !== 0) {
    return scoreDifference;
  }

  const typeDifference = TYPE_PRIORITY[left.type] - TYPE_PRIORITY[right.type];

  if (typeDifference !== 0) {
    return typeDifference;
  }

  const updatedDifference = compareIsoDesc(left.updatedAt, right.updatedAt);

  if (updatedDifference !== 0) {
    return updatedDifference;
  }

  return left.id.localeCompare(right.id);
}

function compareNewestObjects(left: SearchCandidate, right: SearchCandidate): number {
  const updatedDifference = compareIsoDesc(left.object.updatedAt, right.object.updatedAt);

  if (updatedDifference !== 0) {
    return updatedDifference;
  }

  return left.object.id.localeCompare(right.object.id);
}

function compareIsoDesc(left: string, right: string): number {
  const leftMillis = Date.parse(left);
  const rightMillis = Date.parse(right);

  if (Number.isFinite(leftMillis) && Number.isFinite(rightMillis)) {
    return rightMillis - leftMillis;
  }

  return right.localeCompare(left);
}

function buildSnippet(body: string, title: string, terms: readonly string[]): string {
  const text = collapseWhitespace(body) || title;

  if (text.length <= SNIPPET_LENGTH) {
    return text;
  }

  const normalizedText = normalizeForMatch(text);
  const matchIndex = firstTermIndex(normalizedText, terms);

  if (matchIndex === -1) {
    return `${text.slice(0, SNIPPET_LENGTH - 3).trimEnd()}...`;
  }

  const start = Math.max(0, matchIndex - SNIPPET_CONTEXT);
  const end = Math.min(text.length, start + SNIPPET_LENGTH);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";

  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

function firstTermIndex(text: string, terms: readonly string[]): number {
  let firstIndex = -1;

  for (const term of terms) {
    const index = text.indexOf(term);

    if (index !== -1 && (firstIndex === -1 || index < firstIndex)) {
      firstIndex = index;
    }
  }

  return firstIndex;
}

function extractSearchTerms(query: string): string[] {
  const terms = query
    .match(/[\p{L}\p{N}_]+/gu)
    ?.map((term) => normalizeForMatch(term))
    .filter((term) => term.length > 0) ?? [];

  return [...new Set(terms)];
}

function buildFtsQuery(terms: readonly string[]): string | null {
  if (terms.length === 0) {
    return null;
  }

  return terms.map((term) => `"${term}"`).join(" OR ");
}

function parseTags(tagsJson: string): string[] {
  const parsed = JSON.parse(tagsJson) as unknown;

  if (!Array.isArray(parsed) || !parsed.every((tag) => typeof tag === "string")) {
    throw new Error("Indexed object tags are not a string array.");
  }

  return parsed;
}

function jsonSearchText(value: string | null): string {
  if (value === null) {
    return "";
  }

  try {
    return flattenJsonText(JSON.parse(value) as unknown).join(" ");
  } catch {
    return "";
  }
}

function flattenJsonText(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(flattenJsonText);
  }

  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(flattenJsonText);
  }

  return [];
}

function isObjectType(value: string): value is ObjectType {
  return OBJECT_TYPES.includes(value as ObjectType);
}

function isObjectStatus(value: string): value is ObjectStatus {
  return OBJECT_STATUSES.includes(value as ObjectStatus);
}

function normalizeIndexedObjectStatus(
  type: ObjectType,
  status: string
): ObjectStatus | null {
  if (isObjectStatus(status)) {
    return status;
  }

  if (status === "draft") {
    return type === "question" ? "open" : "active";
  }

  return null;
}

function shouldApplyRecentBoost(status: ObjectStatus): boolean {
  return status !== "stale" && status !== "superseded";
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase();
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function invalidInput<T>(message: string, details: JsonValue): Result<T> {
  return err(memoryError("MemoryValidationFailed", message, details));
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

function numberDetail(value: number): JsonValue {
  if (Number.isNaN(value)) {
    return "NaN";
  }

  if (value === Infinity) {
    return "Infinity";
  }

  if (value === -Infinity) {
    return "-Infinity";
  }

  return value;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

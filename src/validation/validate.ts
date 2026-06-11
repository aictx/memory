import { lstat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import type { ErrorObject } from "ajv/dist/2020.js";
import fg from "fast-glob";

import { memoryError, type MemoryError, type JsonValue } from "../core/errors.js";
import { readUtf8FileInsideRoot } from "../core/fs.js";
import type { GitState, ValidationIssue } from "../core/types.js";
import {
  computeObjectContentHash,
  computeRelationContentHash
} from "../storage/hashes.js";
import {
  extractFirstH1,
  validateMarkdownBody
} from "../storage/markdown.js";
import { scanProjectConflictMarkers } from "./conflicts.js";
import { scanProjectSecrets } from "./secrets.js";
import {
  compileProjectSchemas,
  type CompiledSchemaValidators,
  type SchemaKind
} from "./schemas.js";

export interface SchemaValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export type ProjectValidationResult = SchemaValidationResult;

export interface ValidateProjectOptions {
  git?: Pick<GitState, "available" | "branch">;
}

interface ParsedJsonFile {
  path: string;
  value: Record<string, unknown>;
}

interface MemoryObjectFile extends ParsedJsonFile {
  markdownPath: string | null;
  markdownBody: string | null;
}

interface RelationFile extends ParsedJsonFile {}

interface ProjectValidationState {
  projectRoot: string;
  validators: CompiledSchemaValidators | null;
  config: ParsedJsonFile | null;
  projectId: string | null;
  objects: MemoryObjectFile[];
  relations: RelationFile[];
  objectIds: Set<string>;
  supersededTargetIds: Set<string>;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

type RelativeFileRead =
  | {
      ok: true;
      contents: string;
    }
  | {
      ok: false;
      missing: true;
    }
  | {
      ok: false;
      missing: false;
      issue: ValidationIssue;
    };

const SUPPORTED_STORAGE_VERSIONS = new Set([5]);
const RELATED_TO_WARNING_MINIMUM = 5;

export function validateConfig(
  validators: CompiledSchemaValidators,
  value: unknown,
  path = ".memory/config.json"
): SchemaValidationResult {
  return validateWithSchema(validators, "config", value, path);
}

export function validateObject(
  validators: CompiledSchemaValidators,
  value: unknown,
  path: string
): SchemaValidationResult {
  return validateWithSchema(validators, "object", value, path);
}

export function validateRelation(
  validators: CompiledSchemaValidators,
  value: unknown,
  path: string
): SchemaValidationResult {
  return validateWithSchema(validators, "relation", value, path);
}

export function validateEvent(
  validators: CompiledSchemaValidators,
  value: unknown,
  path = ".memory/events.jsonl",
  line?: number
): SchemaValidationResult {
  const issuePath = line === undefined ? path : `${path}:${line}`;
  return validateWithSchema(validators, "event", value, issuePath);
}

export function validatePatch(
  validators: CompiledSchemaValidators,
  value: unknown,
  path = "<patch>"
): SchemaValidationResult {
  return validateWithSchema(validators, "patch", value, path);
}

export function schemaValidationError(issues: readonly ValidationIssue[]): MemoryError {
  return memoryError(
    "MemorySchemaValidationFailed",
    "Schema validation failed.",
    validationIssuesDetails(issues)
  );
}

export async function validateProject(
  projectRoot: string,
  _options: ValidateProjectOptions = {}
): Promise<ProjectValidationResult> {
  const state: ProjectValidationState = {
    projectRoot,
    validators: null,
    config: null,
    projectId: null,
    objects: [],
    relations: [],
    objectIds: new Set<string>(),
    supersededTargetIds: new Set<string>(),
    errors: [],
    warnings: []
  };

  await validateRequiredStorage(state);
  await addConflictMarkers(state);
  await addSecretFindings(state);
  await loadSchemas(state);
  await validateConfigFile(state);
  await validateObjectFiles(state);
  await validateRelationFiles(state);
  await validateEventsFile(state);
  validateDuplicateObjectIds(state);
  validateDuplicateRelationIds(state);
  validateRelationEndpointsAndEquivalence(state);
  validateSupersededObjects(state);
  validateRelatedToUsage(state);

  return {
    valid: state.errors.length === 0,
    errors: state.errors,
    warnings: state.warnings
  };
}

function validateWithSchema(
  validators: CompiledSchemaValidators,
  kind: SchemaKind,
  value: unknown,
  path: string
): SchemaValidationResult {
  const validate = validators.validators[kind];

  if (validate(value)) {
    return {
      valid: true,
      errors: [],
      warnings: []
    };
  }

  const errors = validate.errors ?? [];

  return {
    valid: false,
    errors:
      errors.length > 0
        ? ajvErrorsToIssues(errors, path)
        : [
            {
              code: "SchemaValidationFailed",
              message: "Schema validation failed.",
              path,
              field: null
            }
          ],
    warnings: []
  };
}

function ajvErrorsToIssues(errors: readonly ErrorObject[], path: string): ValidationIssue[] {
  return errors.map((error) => ({
    code: issueCodeForKeyword(error.keyword),
    message: issueMessage(error),
    path,
    field: issueField(error)
  }));
}

function issueCodeForKeyword(keyword: string): string {
  switch (keyword) {
    case "required":
      return "SchemaRequired";
    case "type":
      return "SchemaType";
    case "enum":
      return "SchemaEnum";
    case "const":
      return "SchemaConst";
    case "additionalProperties":
      return "SchemaAdditionalProperty";
    case "pattern":
      return "SchemaPattern";
    case "minLength":
      return "SchemaMinLength";
    case "minimum":
      return "SchemaMinimum";
    case "maximum":
      return "SchemaMaximum";
    case "minItems":
      return "SchemaMinItems";
    case "uniqueItems":
      return "SchemaUniqueItems";
    case "oneOf":
      return "SchemaOneOf";
    default:
      return "SchemaValidationFailed";
  }
}

function issueField(error: ErrorObject): string | null {
  if (error.keyword === "required") {
    const missingProperty = stringParam(error, "missingProperty");
    return missingProperty === null
      ? normalizedInstancePath(error.instancePath)
      : appendJsonPointer(error.instancePath, missingProperty);
  }

  if (error.keyword === "additionalProperties") {
    const additionalProperty = stringParam(error, "additionalProperty");
    return additionalProperty === null
      ? normalizedInstancePath(error.instancePath)
      : appendJsonPointer(error.instancePath, additionalProperty);
  }

  return normalizedInstancePath(error.instancePath);
}

function issueMessage(error: ErrorObject): string {
  if (error.keyword === "required") {
    const missingProperty = stringParam(error, "missingProperty");
    return missingProperty === null
      ? "Required field is missing."
      : `Required field is missing: ${missingProperty}.`;
  }

  if (error.keyword === "additionalProperties") {
    const additionalProperty = stringParam(error, "additionalProperty");
    return additionalProperty === null
      ? "Unknown field is not allowed."
      : `Unknown field is not allowed: ${additionalProperty}.`;
  }

  return error.message ?? "Schema validation failed.";
}

function normalizedInstancePath(instancePath: string): string | null {
  return instancePath === "" ? null : instancePath;
}

function appendJsonPointer(instancePath: string, token: string): string {
  return `${instancePath}/${escapeJsonPointerToken(token)}`;
}

function escapeJsonPointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function stringParam(error: ErrorObject, name: string): string | null {
  const params = error.params as Record<string, unknown>;
  const value = params[name];

  return typeof value === "string" ? value : null;
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

async function validateRequiredStorage(state: ProjectValidationState): Promise<void> {
  await Promise.all([
    requireFile(state, ".memory/config.json"),
    requireDirectory(state, ".memory/memory"),
    requireDirectory(state, ".memory/relations"),
    requireFile(state, ".memory/events.jsonl"),
    requireDirectory(state, ".memory/schema")
  ]);
}

async function requireFile(state: ProjectValidationState, path: string): Promise<void> {
  const fileStat = await lstat(join(state.projectRoot, path)).catch(() => null);

  if (fileStat === null) {
    state.errors.push({
      code: "CanonicalFileMissing",
      message: "Required canonical file is missing.",
      path,
      field: null
    });
  }

  if (fileStat !== null && !fileStat.isSymbolicLink() && !fileStat.isFile()) {
    state.errors.push({
      code: "CanonicalFileMissing",
      message: "Required canonical file is missing.",
      path,
      field: null
    });
  }
}

async function requireDirectory(state: ProjectValidationState, path: string): Promise<void> {
  const directoryStat = await lstat(join(state.projectRoot, path)).catch(() => null);

  if (directoryStat === null) {
    state.errors.push({
      code: "CanonicalDirectoryMissing",
      message: "Required canonical directory is missing.",
      path,
      field: null
    });
  }

  if (directoryStat !== null && !directoryStat.isSymbolicLink() && !directoryStat.isDirectory()) {
    state.errors.push({
      code: "CanonicalDirectoryMissing",
      message: "Required canonical directory is missing.",
      path,
      field: null
    });
  }
}

async function addConflictMarkers(state: ProjectValidationState): Promise<void> {
  const result = await scanProjectConflictMarkers(state.projectRoot);
  state.errors.push(...result.errors);
}

async function addSecretFindings(state: ProjectValidationState): Promise<void> {
  const result = await scanProjectSecrets(state.projectRoot);
  state.errors.push(...result.errors);
  state.warnings.push(...result.warnings);
}

async function loadSchemas(state: ProjectValidationState): Promise<void> {
  const compiled = await compileProjectSchemas(state.projectRoot);

  if (compiled.ok) {
    state.validators = compiled.data;
    return;
  }

  state.errors.push(...issuesFromErrorDetails(compiled.error.details));
}

async function validateConfigFile(state: ProjectValidationState): Promise<void> {
  const parsed = await readJsonObjectFile(state, ".memory/config.json");

  if (parsed === null) {
    return;
  }

  state.config = parsed;

  if (state.validators !== null) {
    addResult(state, validateConfig(state.validators, parsed.value, parsed.path));
  }

  const version = parsed.value.version;
  if (version === undefined) {
    state.errors.push({
      code: "StorageVersionMissing",
      message: "Storage version is missing.",
      path: parsed.path,
      field: "/version"
    });
  } else if (!SUPPORTED_STORAGE_VERSIONS.has(Number(version))) {
    state.errors.push({
      code: "StorageVersionUnsupported",
      message: "Storage version is unsupported.",
      path: parsed.path,
      field: "/version"
    });
  }

  state.projectId = readProjectId(parsed.value);
}

async function validateObjectFiles(state: ProjectValidationState): Promise<void> {
  const paths = await globProjectPaths(state.projectRoot, ".memory/memory/**/*.json");

  for (const path of paths) {
    const parsed = await readJsonObjectFile(state, path);

    if (parsed === null) {
      continue;
    }

    if (state.validators !== null) {
      addResult(state, validateObject(state.validators, parsed.value, parsed.path));
    }

    const objectFile: MemoryObjectFile = {
      ...parsed,
      markdownPath: null,
      markdownBody: null
    };
    state.objects.push(objectFile);
    validateObjectIdentity(state, objectFile);
    await validateObjectBody(state, objectFile);
    validateObjectHash(state, objectFile);
  }
}

async function validateRelationFiles(state: ProjectValidationState): Promise<void> {
  const paths = await globProjectPaths(state.projectRoot, ".memory/relations/**/*.json");

  for (const path of paths) {
    const parsed = await readJsonObjectFile(state, path);

    if (parsed === null) {
      continue;
    }

    if (state.validators !== null) {
      addResult(state, validateRelation(state.validators, parsed.value, parsed.path));
    }

    state.relations.push(parsed);
    validateRelationHash(state, parsed);

    if (
      readString(parsed.value, "predicate") === "supersedes" &&
      readString(parsed.value, "status") === "active"
    ) {
      const to = readString(parsed.value, "to");
      if (to !== null) {
        state.supersededTargetIds.add(to);
      }
    }
  }
}

async function validateEventsFile(state: ProjectValidationState): Promise<void> {
  const path = ".memory/events.jsonl";
  const contents = await readRelativeFile(state.projectRoot, path);

  if (!contents.ok) {
    if (!contents.missing) {
      state.errors.push(contents.issue);
    }

    return;
  }

  const lines = contents.contents.split(/\r\n|\n|\r/);
  const lineCount = lines.length > 0 && lines.at(-1) === "" ? lines.length - 1 : lines.length;

  for (let index = 0; index < lineCount; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;

    if (line.trim() === "") {
      state.errors.push({
        code: "EventJsonlBlankLine",
        message: "Events JSONL must not contain blank lines.",
        path: `${path}:${lineNumber}`,
        field: null
      });
      continue;
    }

    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) {
        state.errors.push({
          code: "EventJsonlInvalid",
          message: "Events JSONL line must contain one JSON object.",
          path: `${path}:${lineNumber}`,
          field: null
        });
        continue;
      }

      if (state.validators !== null) {
        addResult(state, validateEvent(state.validators, parsed, path, lineNumber));
      }
    } catch (error) {
      state.errors.push({
        code: "EventJsonlInvalid",
        message: `Events JSONL line contains invalid JSON: ${messageFromUnknown(error)}`,
        path: `${path}:${lineNumber}`,
        field: null
      });
    }
  }
}

function validateObjectIdentity(state: ProjectValidationState, objectFile: MemoryObjectFile): void {
  const id = readString(objectFile.value, "id");
  const type = readString(objectFile.value, "type");

  if (id !== null) {
    state.objectIds.add(id);
  }

  if (id !== null && type !== null && id.split(".", 1)[0] !== type) {
    state.errors.push({
      code: "ObjectIdTypeMismatch",
      message: "Object id prefix must match object type.",
      path: objectFile.path,
      field: "/id"
    });
  }
}

async function validateObjectBody(
  state: ProjectValidationState,
  objectFile: MemoryObjectFile
): Promise<void> {
  const bodyPath = readString(objectFile.value, "body_path");

  if (bodyPath === null) {
    return;
  }

  const resolved = resolveBodyPath(state.projectRoot, bodyPath);

  if (resolved === null) {
    state.errors.push({
      code: "ObjectBodyPathEscapesMemory",
      message: "Object body path must stay inside .memory.",
      path: objectFile.path,
      field: "/body_path"
    });
    return;
  }

  const markdownPath = `.memory/${bodyPath}`;
  objectFile.markdownPath = markdownPath;

  if (basename(objectFile.path, ".json") !== basename(markdownPath, ".md")) {
    state.errors.push({
      code: "ObjectBodyPathMismatch",
      message: "Object JSON sidecar and Markdown body must share a basename.",
      path: objectFile.path,
      field: "/body_path"
    });
  }

  const markdown = await readRelativeFile(state.projectRoot, markdownPath, "ObjectBodyPathUnsafe");

  if (!markdown.ok) {
    if (!markdown.missing) {
      state.errors.push(markdown.issue);
      return;
    }

    state.errors.push({
      code: "ObjectBodyMissing",
      message: "Object body file is missing.",
      path: objectFile.path,
      field: "/body_path"
    });
    return;
  }

  objectFile.markdownBody = markdown.contents;
  addResult(state, validateMarkdownBody(markdown.contents, markdownPath));
  validateTitleMatchesH1(state, objectFile, markdown.contents);
}

function validateObjectHash(state: ProjectValidationState, objectFile: MemoryObjectFile): void {
  const contentHash = readString(objectFile.value, "content_hash");

  if (contentHash === null) {
    state.errors.push({
      code: "ObjectContentHashMissing",
      message: "Memory object content_hash is missing.",
      path: objectFile.path,
      field: "/content_hash"
    });
    return;
  }

  if (objectFile.markdownBody === null) {
    return;
  }

  const actualHash = computeObjectContentHash(objectFile.value, objectFile.markdownBody);
  if (actualHash !== contentHash) {
    state.warnings.push({
      code: "ObjectContentHashMismatch",
      message: "Memory object content_hash does not match current body and metadata.",
      path: objectFile.path,
      field: "/content_hash"
    });
  }
}

function validateTitleMatchesH1(
  state: ProjectValidationState,
  objectFile: MemoryObjectFile,
  markdown: string
): void {
  const title = readString(objectFile.value, "title");
  const h1 = extractFirstH1(markdown);

  if (title !== null && h1 !== null && h1 !== title) {
    state.warnings.push({
      code: "ObjectTitleH1Mismatch",
      message: "Markdown H1 differs from JSON title.",
      path: objectFile.path,
      field: "/title"
    });
  }
}

function validateRelationHash(state: ProjectValidationState, relation: RelationFile): void {
  const contentHash = readString(relation.value, "content_hash");

  if (contentHash === null) {
    return;
  }

  const actualHash = computeRelationContentHash(relation.value);
  if (actualHash !== contentHash) {
    state.warnings.push({
      code: "RelationContentHashMismatch",
      message: "Relation content_hash does not match current metadata.",
      path: relation.path,
      field: "/content_hash"
    });
  }
}

function validateDuplicateObjectIds(state: ProjectValidationState): void {
  const pathsById = new Map<string, string[]>();

  for (const objectFile of state.objects) {
    const id = readString(objectFile.value, "id");
    if (id === null) {
      continue;
    }

    const paths = pathsById.get(id) ?? [];
    paths.push(objectFile.path);
    pathsById.set(id, paths);
  }

  for (const [id, paths] of pathsById) {
    if (paths.length > 1) {
      for (const path of paths) {
        state.errors.push({
          code: "ObjectIdDuplicate",
          message: `Duplicate object id: ${id}.`,
          path,
          field: "/id"
        });
      }
    }
  }
}

function validateDuplicateRelationIds(state: ProjectValidationState): void {
  const pathsById = new Map<string, string[]>();

  for (const relation of state.relations) {
    const id = readString(relation.value, "id");
    if (id === null) {
      continue;
    }

    const paths = pathsById.get(id) ?? [];
    paths.push(relation.path);
    pathsById.set(id, paths);
  }

  for (const [id, paths] of pathsById) {
    if (paths.length > 1) {
      for (const path of paths) {
        state.errors.push({
          code: "RelationIdDuplicate",
          message: `Duplicate relation id: ${id}.`,
          path,
          field: "/id"
        });
      }
    }
  }
}

function validateRelationEndpointsAndEquivalence(state: ProjectValidationState): void {
  const pathsByEquivalentRelation = new Map<string, string[]>();

  for (const relation of state.relations) {
    const from = readString(relation.value, "from");
    const predicate = readString(relation.value, "predicate");
    const to = readString(relation.value, "to");

    if (from !== null && !state.objectIds.has(from)) {
      state.errors.push({
        code: "RelationEndpointMissing",
        message: "Relation from endpoint does not reference an existing object.",
        path: relation.path,
        field: "/from"
      });
    }

    if (to !== null && !state.objectIds.has(to)) {
      state.errors.push({
        code: "RelationEndpointMissing",
        message: "Relation to endpoint does not reference an existing object.",
        path: relation.path,
        field: "/to"
      });
    }

    if (from !== null && predicate !== null && to !== null) {
      const equivalenceKey = `${from}\u0000${predicate}\u0000${to}`;
      const paths = pathsByEquivalentRelation.get(equivalenceKey) ?? [];
      paths.push(relation.path);
      pathsByEquivalentRelation.set(equivalenceKey, paths);
    }
  }

  for (const paths of pathsByEquivalentRelation.values()) {
    if (paths.length > 1) {
      for (const path of paths) {
        state.errors.push({
          code: "RelationEquivalentDuplicate",
          message: "Duplicate equivalent relation.",
          path,
          field: null
        });
      }
    }
  }
}

function validateSupersededObjects(state: ProjectValidationState): void {
  for (const objectFile of state.objects) {
    const id = readString(objectFile.value, "id");
    if (
      id !== null &&
      readString(objectFile.value, "status") === "superseded" &&
      readNullableString(objectFile.value, "superseded_by") === null &&
      !state.supersededTargetIds.has(id)
    ) {
      state.warnings.push({
        code: "ObjectSupersededReplacementMissing",
        message: "Superseded object should identify its replacement.",
        path: objectFile.path,
        field: "/superseded_by"
      });
    }
  }
}

function validateRelatedToUsage(state: ProjectValidationState): void {
  const relatedToRelations = state.relations.filter(
    (relation) => readString(relation.value, "predicate") === "related_to"
  );

  if (
    relatedToRelations.length >= RELATED_TO_WARNING_MINIMUM &&
    relatedToRelations.length / state.relations.length > 0.5
  ) {
    state.warnings.push({
      code: "RelationRelatedToExcessive",
      message: "related_to appears excessively and should not be overused.",
      path: ".memory/relations",
      field: "/predicate"
    });
  }
}

async function readJsonObjectFile(
  state: ProjectValidationState,
  path: string
): Promise<ParsedJsonFile | null> {
  const contents = await readRelativeFile(state.projectRoot, path);

  if (!contents.ok) {
    if (!contents.missing) {
      state.errors.push(contents.issue);
    }

    return null;
  }

  try {
    const parsed = JSON.parse(contents.contents) as unknown;

    if (!isRecord(parsed)) {
      state.errors.push({
        code: "JsonInvalid",
        message: "JSON file must contain one object.",
        path,
        field: null
      });
      return null;
    }

    return { path, value: parsed };
  } catch (error) {
    state.errors.push({
      code: "JsonInvalid",
      message: `JSON file contains invalid JSON: ${messageFromUnknown(error)}`,
      path,
      field: null
    });
    return null;
  }
}

async function readRelativeFile(
  projectRoot: string,
  path: string,
  unsafeCode = "CanonicalFileUnsafe"
): Promise<RelativeFileRead> {
  const result = await readUtf8FileInsideRoot(projectRoot, path);

  if (result.ok) {
    return {
      ok: true,
      contents: result.data
    };
  }

  if (isMissingFileReadError(result.error)) {
    return {
      ok: false,
      missing: true
    };
  }

  return {
    ok: false,
    missing: false,
    issue: {
      code: unsafeCode,
      message: `Canonical file could not be read safely: ${result.error.message}`,
      path,
      field: null
    }
  };
}

function isMissingFileReadError(error: MemoryError): boolean {
  const details = error.details;

  return isRecord(details) && details.fsCode === "ENOENT";
}

async function globProjectPaths(projectRoot: string, pattern: string): Promise<string[]> {
  return (
    await fg(pattern, {
      cwd: projectRoot,
      dot: true,
      ignore: [".memory/index/**"],
      onlyFiles: true,
      unique: true
    })
  ).sort();
}

function resolveBodyPath(projectRoot: string, bodyPath: string): string | null {
  if (isAbsolute(bodyPath)) {
    return null;
  }

  const memoryRoot = resolve(projectRoot, ".memory");
  const resolvedBodyPath = resolve(memoryRoot, bodyPath);
  const relativePath = relative(memoryRoot, resolvedBodyPath);

  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return null;
  }

  return resolvedBodyPath;
}

function addResult(state: ProjectValidationState, result: SchemaValidationResult): void {
  state.errors.push(...result.errors);
  state.warnings.push(...result.warnings);
}

function issuesFromErrorDetails(details: JsonValue | undefined): ValidationIssue[] {
  if (!isRecord(details) || !Array.isArray(details.issues)) {
    return [
      {
        code: "SchemaValidationFailed",
        message: "Schema validation failed.",
        path: ".memory/schema",
        field: null
      }
    ];
  }

  const issues: ValidationIssue[] = [];

  for (const issue of details.issues) {
    if (isValidationIssue(issue)) {
      issues.push(issue);
    }
  }

  return issues;
}

function isValidationIssue(value: unknown): value is ValidationIssue {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    typeof value.path === "string" &&
    (typeof value.field === "string" || value.field === null)
  );
}

function readProjectId(config: Record<string, unknown>): string | null {
  const project = config.project;

  return isRecord(project) ? readString(project, "id") : null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];

  return typeof value === "string" ? value : null;
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];

  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

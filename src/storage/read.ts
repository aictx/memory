import { join, resolve } from "node:path";

import fg from "fast-glob";

import { memoryError, type MemoryError } from "../core/errors.js";
import { readUtf8FileInsideRoot } from "../core/fs.js";
import { err, ok, type Result } from "../core/result.js";
import type { ValidationIssue } from "../core/types.js";
import type { CompiledSchemaValidators } from "../validation/schemas.js";
import { compileProjectSchemas } from "../validation/schemas.js";
import {
  schemaValidationError,
  validateConfig,
  validateEvent,
  validateObject,
  validateRelation
} from "../validation/validate.js";
import { readMarkdownBodyInsideRoot } from "./markdown.js";
import {
  CURRENT_STORAGE_VERSION,
  isMemoryConfig,
  isMemoryObjectSidecar,
  type MemoryConfig,
  type StoredMemoryObject
} from "./objects.js";
import { isMemoryEvent, isJsonObject, type StoredMemoryEvent } from "./events.js";
import {
  isMemoryRelation,
  type StoredMemoryRelation
} from "./relations.js";

const CONFIG_PATH = ".memory/config.json";
const EVENTS_PATH = ".memory/events.jsonl";
const GENERATED_IGNORES = [".memory/index/**"] as const;

export interface CanonicalStorageSnapshot {
  projectRoot: string;
  memoryRoot: string;
  config: MemoryConfig;
  objects: StoredMemoryObject[];
  relations: StoredMemoryRelation[];
  events: StoredMemoryEvent[];
}

export interface ReadCanonicalStorageOptions {
  validators?: CompiledSchemaValidators;
}

export async function readCanonicalStorage(
  projectRoot: string,
  options: ReadCanonicalStorageOptions = {}
): Promise<Result<CanonicalStorageSnapshot>> {
  const resolvedProjectRoot = resolve(projectRoot);
  const memoryRoot = join(resolvedProjectRoot, ".memory");
  const validatorsResult = await getValidators(resolvedProjectRoot, options);

  if (!validatorsResult.ok) {
    return validatorsResult;
  }

  const validators = validatorsResult.data;
  const config = await readConfig(resolvedProjectRoot, validators);

  if (!config.ok) {
    return config;
  }

  const objects = await readObjects(resolvedProjectRoot, memoryRoot, validators);

  if (!objects.ok) {
    return objects;
  }

  const relations = await readRelations(resolvedProjectRoot, validators);

  if (!relations.ok) {
    return relations;
  }

  const events = await readEvents(resolvedProjectRoot, validators);

  if (!events.ok) {
    return events;
  }

  return ok({
    projectRoot: resolvedProjectRoot,
    memoryRoot,
    config: config.data,
    objects: objects.data,
    relations: relations.data,
    events: events.data
  });
}

async function getValidators(
  projectRoot: string,
  options: ReadCanonicalStorageOptions
): Promise<Result<CompiledSchemaValidators>> {
  if (options.validators !== undefined) {
    return ok(options.validators);
  }

  return compileProjectSchemas(projectRoot);
}

async function readConfig(
  projectRoot: string,
  validators: CompiledSchemaValidators
): Promise<Result<MemoryConfig>> {
  const parsed = await readJsonFile(projectRoot, CONFIG_PATH);

  if (!parsed.ok) {
    return parsed;
  }

  const versionGate = storageVersionGate(parsed.data);

  if (versionGate !== null) {
    return err(versionGate);
  }

  const validation = validateConfig(validators, parsed.data, CONFIG_PATH);

  if (!validation.valid) {
    return err(schemaValidationError(validation.errors));
  }

  if (!isMemoryConfig(parsed.data)) {
    return schemaContractFailure(CONFIG_PATH, "Config does not match the storage reader contract.");
  }

  return ok(parsed.data);
}

export function unsupportedStorageVersionError(version: unknown): MemoryError {
  const rendered =
    typeof version === "number" || typeof version === "string" ? String(version) : "unknown";

  return memoryError(
    "MemoryUnsupportedStorageVersion",
    `Memory storage version ${rendered} is not supported by this release. Run \`memory reset\` then \`memory init\` to re-index with the current schema.`,
    {
      path: CONFIG_PATH,
      supported_version: CURRENT_STORAGE_VERSION,
      ...(typeof version === "number" || typeof version === "string"
        ? { found_version: version }
        : {})
    }
  );
}

/**
 * Checks the canonical config storage version without compiling schemas.
 * Returns the gate error for any parsed config whose version is not the
 * current storage version. This backs commands that do not read full
 * canonical storage up front (check, search, rebuild).
 */
export async function checkStorageVersion(projectRoot: string): Promise<Result<void>> {
  const resolvedProjectRoot = resolve(projectRoot);
  const parsed = await readJsonFile(resolvedProjectRoot, CONFIG_PATH);

  if (!parsed.ok) {
    return parsed;
  }

  const versionGate = storageVersionGate(parsed.data);

  if (versionGate !== null) {
    return err(versionGate);
  }

  return ok(undefined);
}

function storageVersionGate(config: unknown): MemoryError | null {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return null;
  }

  const version = (config as { version?: unknown }).version;

  if (version === CURRENT_STORAGE_VERSION) {
    return null;
  }

  return unsupportedStorageVersionError(version);
}

async function readObjects(
  projectRoot: string,
  memoryRoot: string,
  validators: CompiledSchemaValidators
): Promise<Result<StoredMemoryObject[]>> {
  const paths = await discoverCanonicalJson(projectRoot, ".memory/memory/**/*.json");
  const objects: StoredMemoryObject[] = [];

  for (const path of paths) {
    const parsed = await readJsonFile(projectRoot, path);

    if (!parsed.ok) {
      return parsed;
    }

    const validation = validateObject(validators, parsed.data, path);

    if (!validation.valid) {
      return err(schemaValidationError(validation.errors));
    }

    if (!isMemoryObjectSidecar(parsed.data)) {
      return schemaContractFailure(path, "Memory object does not match the storage reader contract.");
    }

    const body = await readMarkdownBodyInsideRoot(memoryRoot, parsed.data.body_path);

    if (!body.ok) {
      return body;
    }

    objects.push({
      path,
      bodyPath: `.memory/${parsed.data.body_path}`,
      sidecar: parsed.data,
      body: body.data
    });
  }

  return ok(objects);
}

async function readRelations(
  projectRoot: string,
  validators: CompiledSchemaValidators
): Promise<Result<StoredMemoryRelation[]>> {
  const paths = await discoverCanonicalJson(projectRoot, ".memory/relations/**/*.json");
  const relations: StoredMemoryRelation[] = [];

  for (const path of paths) {
    const parsed = await readJsonFile(projectRoot, path);

    if (!parsed.ok) {
      return parsed;
    }

    const validation = validateRelation(validators, parsed.data, path);

    if (!validation.valid) {
      return err(schemaValidationError(validation.errors));
    }

    if (!isMemoryRelation(parsed.data)) {
      return schemaContractFailure(path, "Relation does not match the storage reader contract.");
    }

    relations.push({
      path,
      relation: parsed.data
    });
  }

  return ok(relations);
}

async function readEvents(
  projectRoot: string,
  validators: CompiledSchemaValidators
): Promise<Result<StoredMemoryEvent[]>> {
  const contents = await readUtf8FileInsideRoot(projectRoot, EVENTS_PATH);

  if (!contents.ok) {
    return contents;
  }

  if (contents.data === "") {
    return ok([]);
  }

  const lines = contents.data.split(/\n/);
  const events: StoredMemoryEvent[] = [];
  const lastLineIndex = lines.length - 1;

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;

    if (index === lastLineIndex && line === "") {
      continue;
    }

    if (line.trim() === "") {
      return invalidJsonl(`Blank JSONL lines are not allowed.`, lineNumber);
    }

    const parsed = parseJsonlLine(line, lineNumber);

    if (!parsed.ok) {
      return parsed;
    }

    if (!isJsonObject(parsed.data)) {
      return invalidJsonl("JSONL lines must contain one JSON object.", lineNumber);
    }

    const validation = validateEvent(validators, parsed.data, EVENTS_PATH, lineNumber);

    if (!validation.valid) {
      return err(schemaValidationError(validation.errors));
    }

    if (!isMemoryEvent(parsed.data)) {
      return schemaContractFailure(
        `${EVENTS_PATH}:${lineNumber}`,
        "Event does not match the storage reader contract."
      );
    }

    events.push({
      ...parsed.data,
      path: EVENTS_PATH,
      line: lineNumber
    });
  }

  return ok(events);
}

async function discoverCanonicalJson(projectRoot: string, pattern: string): Promise<string[]> {
  return (
    await fg(pattern, {
      cwd: projectRoot,
      dot: true,
      ignore: [...GENERATED_IGNORES],
      onlyFiles: true,
      unique: true
    })
  ).sort();
}

async function readJsonFile(projectRoot: string, path: string): Promise<Result<unknown>> {
  const contents = await readUtf8FileInsideRoot(projectRoot, path);

  if (!contents.ok) {
    return contents;
  }

  try {
    return ok(JSON.parse(contents.data) as unknown);
  } catch (error) {
    return err(
      memoryError("MemoryInvalidJson", "Invalid JSON.", {
        path,
        message: messageFromUnknown(error)
      })
    );
  }
}

function parseJsonlLine(line: string, lineNumber: number): Result<unknown> {
  try {
    return ok(JSON.parse(line) as unknown);
  } catch (error) {
    return invalidJsonl(`Invalid JSONL: ${messageFromUnknown(error)}`, lineNumber);
  }
}

function invalidJsonl(message: string, line: number): Result<never> {
  return err(
    memoryError("MemoryInvalidJsonl", message, {
      path: `${EVENTS_PATH}:${line}`,
      line
    })
  );
}

function schemaContractFailure<T>(path: string, message: string): Result<T> {
  const issue: ValidationIssue = {
    code: "SchemaValidationFailed",
    message,
    path,
    field: null
  };

  return err(schemaValidationError([issue]));
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

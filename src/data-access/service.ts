import { resolve } from "node:path";

import {
  diffMemory,
  inspectMemory,
  saveMemory,
  searchMemory,
  type AppResult,
  type DiffMemoryData,
  type InspectMemoryData,
  type InspectMemoryOptions,
  type SaveMemoryData,
  type SaveMemoryOptions,
  type SearchMemoryOptions
} from "../app/operations.js";
import type { Clock } from "../core/clock.js";
import { getGitState, type GitWrapperOptions } from "../core/git.js";
import {
  resolveProjectPaths,
  type ProjectPaths,
  type ProjectRootResolutionMode
} from "../core/paths.js";
import type { Result } from "../core/result.js";
import type { MemoryMeta, ObjectId } from "../core/types.js";
import type { SearchMemoryData, SearchMemoryInput } from "../index/search.js";

export type DataAccessProjectTarget =
  | {
      kind: "cwd";
      cwd: string;
    }
  | {
      kind: "project-root";
      projectRoot: string;
    };

export interface DataAccessBaseInput extends GitWrapperOptions {
  target: DataAccessProjectTarget;
  clock?: Clock;
}

export interface DataAccessSearchInput extends DataAccessBaseInput, SearchMemoryInput {}

export interface DataAccessInspectInput extends DataAccessBaseInput {
  id: ObjectId;
}

export type DataAccessDiffInput = DataAccessBaseInput;

export interface DataAccessSaveInput extends DataAccessBaseInput {
  input?: unknown;
  dryRun?: boolean;
}

export interface DataAccessService {
  search(input: DataAccessSearchInput): Promise<AppResult<SearchMemoryData>>;
  inspect(input: DataAccessInspectInput): Promise<AppResult<InspectMemoryData>>;
  diff(input: DataAccessDiffInput): Promise<AppResult<DiffMemoryData>>;
  save(input: DataAccessSaveInput): Promise<AppResult<SaveMemoryData>>;
}

export function createDataAccessService(): DataAccessService {
  return {
    search: async (input) =>
      withResolvedProject(input, async (paths) =>
        searchMemory(toSearchMemoryOptions(input, paths))
      ),
    inspect: async (input) =>
      withResolvedProject(input, async (paths) =>
        inspectMemory(toInspectMemoryOptions(input, paths))
      ),
    diff: async (input) =>
      withResolvedProject(input, async (paths) =>
        diffMemory({
          cwd: paths.projectRoot,
          ...gitWrapperOptions(input)
        })
      ),
    save: async (input) =>
      withResolvedProject(
        input,
        async (paths) => saveMemory(toSaveMemoryOptions(input, paths)),
        "init"
      )
  };
}

export const dataAccessService = createDataAccessService();

async function withResolvedProject<T>(
  input: DataAccessBaseInput,
  operation: (paths: ProjectPaths) => Promise<AppResult<T>>,
  mode: ProjectRootResolutionMode = "require-initialized"
): Promise<AppResult<T>> {
  const paths = await resolveDataAccessProject(input, mode);

  if (!paths.ok) {
    return {
      ok: false,
      error: paths.error,
      warnings: paths.warnings,
      meta: await buildBestEffortMeta(input)
    };
  }

  return operation(paths.data);
}

async function resolveDataAccessProject(
  input: DataAccessBaseInput,
  mode: ProjectRootResolutionMode
): Promise<Result<ProjectPaths>> {
  return resolveProjectPaths({
    cwd: targetCwd(input.target),
    mode,
    ...gitWrapperOptions(input)
  });
}

function toSearchMemoryOptions(
  input: DataAccessSearchInput,
  paths: ProjectPaths
): SearchMemoryOptions {
  return {
    cwd: paths.projectRoot,
    query: input.query,
    ...gitWrapperOptions(input),
    ...clockOption(input),
    ...(input.limit === undefined ? {} : { limit: input.limit })
  };
}

function toInspectMemoryOptions(
  input: DataAccessInspectInput,
  paths: ProjectPaths
): InspectMemoryOptions {
  return {
    cwd: paths.projectRoot,
    id: input.id,
    ...gitWrapperOptions(input)
  };
}

function toSaveMemoryOptions(
  input: DataAccessSaveInput,
  paths: ProjectPaths
): SaveMemoryOptions {
  return {
    cwd: paths.projectRoot,
    ...gitWrapperOptions(input),
    ...clockOption(input),
    ...(input.input === undefined ? {} : { input: input.input }),
    ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun })
  };
}

function gitWrapperOptions(input: GitWrapperOptions): GitWrapperOptions {
  return input.runner === undefined ? {} : { runner: input.runner };
}

function clockOption(input: { clock?: Clock }): { clock?: Clock } {
  return input.clock === undefined ? {} : { clock: input.clock };
}

async function buildBestEffortMeta(input: DataAccessBaseInput): Promise<MemoryMeta> {
  const cwd = resolve(targetCwd(input.target));
  const paths = await resolveProjectPaths({
    cwd,
    mode: "init",
    ...gitWrapperOptions(input)
  });

  if (!paths.ok) {
    return {
      project_root: cwd,
      memory_root: resolve(cwd, ".memory"),
      git: {
        available: false,
        branch: null,
        commit: null,
        dirty: null
      }
    };
  }

  const git = await getGitState(paths.data.projectRoot, gitWrapperOptions(input));

  if (!git.ok) {
    return fallbackMeta(paths.data);
  }

  return {
    project_root: paths.data.projectRoot,
    memory_root: paths.data.memoryRoot,
    git: git.data
  };
}

function fallbackMeta(paths: ProjectPaths): MemoryMeta {
  return {
    project_root: paths.projectRoot,
    memory_root: paths.memoryRoot,
    git: {
      available: paths.git.available,
      branch: null,
      commit: null,
      dirty: paths.git.available ? false : null
    }
  };
}

function targetCwd(target: DataAccessProjectTarget): string {
  switch (target.kind) {
    case "cwd":
      return target.cwd;
    case "project-root":
      return target.projectRoot;
  }
}
